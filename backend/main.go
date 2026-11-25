package main

import (
	"encoding/json"
	"log"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultAddr = "127.0.0.1:8080"

// newMux 注册全部路由。main 与端到端测试共用,保证测试走的是真实路由表。
func newMux(st *postgresStore) *http.ServeMux {
	mux := http.NewServeMux()
	registerAdminRoutes(mux, st)
	registerDefinitionRoutes(mux, st)
	registerProjectRoutes(mux, st)
	registerStageTemplateRoutes(mux, st)
	registerChannelRoutes(mux, st)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// 用户认证：注册（首个用户自动成为管理员）/ 登录 / 身份 / 注销 / 注册状态
	mux.HandleFunc("POST /api/auth/register", handleRegister(st))
	mux.HandleFunc("POST /api/auth/login", handleLogin(st))
	mux.HandleFunc("GET /api/auth/status", handleAuthStatus(st))
	mux.HandleFunc("GET /api/auth/me", handleMe(st))
	// 个人信息自助:改显示名与部门、改密码(管理员建号的首次登录必须先走后者)
	mux.HandleFunc("PATCH /api/auth/profile", handleUpdateOwnProfile(st))
	mux.HandleFunc("POST /api/auth/password", handleChangePassword(st))
	mux.HandleFunc("GET /api/users", handleUserDirectory(st))
	mux.HandleFunc("PATCH /api/admin/users/{id}", handleAdminUpdateUser(st))
	mux.HandleFunc("DELETE /api/auth/session", handleLogout)
	// 浏览器与 Next 服务端的日志上报(不要求登录,见 logging.go)
	mux.HandleFunc("POST "+clientLogsPath, handleClientLogs(clientLogLimiter))
	mux.HandleFunc("GET /api/admin/users", handleListUsers(st))
	mux.HandleFunc("POST /api/admin/users", handleAdminCreateUser(st))
	mux.HandleFunc("DELETE /api/admin/users/{id}", handleAdminDeleteUser(st))
	// 公开读收紧为登录可读(数据查看权限);匿名仅保留提交与健康检查
	mux.HandleFunc("GET /api/processes", func(w http.ResponseWriter, r *http.Request) {
		if currentUser(w, r) == nil {
			return
		}
		list, err := st.List()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)
	})
	mux.HandleFunc("POST /api/processes", func(w http.ResponseWriter, r *http.Request) {
		// F02:匿名提交固定窗口限流(每次尝试计数,20 次/分钟)
		if !submitWindow.allowHit("submit:" + clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "提交过于频繁,请稍后再试")
			return
		}
		var p Process
		if err := decodeJSON(w, r, &p); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确: "+err.Error())
			return
		}
		p.ID = ""
		p.CreatedAt = time.Now()
		p.UpdatedAt = p.CreatedAt
		sanitize(&p)
		if msg := validateProcess(&p); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		created, err := st.Create(&p)
		if err != nil {
			requestLogger(r).Error("流程保存失败", "err", err)
			writeError(w, http.StatusInternalServerError, "保存失败,请检查输入后重试")
			return
		}
		// 流程一提交即自动立项:进入阶段 1「分析立项」,等待指派 PM
		if pid, perr := st.CreateProjectForProcess(r.Context(), created); perr != nil {
			requestLogger(r).Error("自动立项失败(可由启动时的补建兜底)", "process", created.ID, "err", perr)
		} else if admins, aerr := usersWithRoleTx(r.Context(), st.db, "admin"); aerr == nil {
			_ = notifyManyTx(r.Context(), st.db, userIDs(admins), "project_created", pid, "", "",
				"新流程「"+created.Name+"」已提交，等待立项与指派 PM", "project_created:"+pid)
		}
		requestLogger(r).Info("新流程提交", "process", created.ID, "steps", len(created.Steps))
		writeJSON(w, http.StatusCreated, created)
	})
	mux.HandleFunc("GET /api/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if currentUser(w, r) == nil {
			return
		}
		p, err := st.Get(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		if p == nil {
			writeError(w, http.StatusNotFound, "流程不存在")
			return
		}
		writeJSON(w, http.StatusOK, p)
	})
	// S0 修复:公开删除 → 管理员(此前无鉴权,任何人都可删任意流程)。旧地址,与后台那条共用同一个处理函数
	mux.HandleFunc("DELETE /api/processes/{id}", handleAdminDeleteProcess(st))

	return mux
}

func main() {
	// 先建日志器并设为默认:之后所有日志(包括包里原有的 log.Printf)都是同一种格式、同一条流
	logger := newLogger()
	slog.SetDefault(logger)

	addr := defaultAddr
	if v := os.Getenv("FLOW_ADDR"); v != "" {
		addr = v
	}
	// 连接串里有口令,只记主机和库名
	dsn := os.Getenv("DATABASE_URL")
	slog.Info("正在启动", "addr", addr, "log_level", logLevel().String(), "log_format", logFormat(), "db", dbTarget(dsn))
	st, err := newStore(dsn)
	if err != nil {
		log.Fatalf("初始化存储失败: %v", err)
	}
	defer st.Close()

	mux := newMux(st)

	// 定时扫描:逾期、评审积压、简报到期;站内通知转发到外部渠道(企业微信 / 钉钉 / 飞书 / 邮件)
	startScheduler(st)
	startChannelDelivery(st)

	slog.Info("ReForge 后端已启动", "addr", addr, "api_prefix", "/api", "store", "PostgreSQL")
	// S5 服务器超时(防 slowloris);中间件链见 logging.go 的 newHandler(访问日志在最外层,记最终状态码)
	srv := &http.Server{
		Addr:    addr,
		Handler: newHandler(mux),
		// net/http 自己报的错(连接异常等)也进同一条日志流
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 14,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// stripUnsafe(F05):剥离 NUL 与 C0 控制字符(PostgreSQL JSONB 拒绝 \u0000)
func stripUnsafe(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 }) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 0x20 {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sanitize 去除首尾空白、剥离控制字符、过滤空标签/空人员/空依赖，保证落库数据干净
func sanitize(p *Process) {
	p.Name = stripUnsafe(strings.TrimSpace(p.Name))
	p.Description = stripUnsafe(strings.TrimSpace(p.Description))
	p.Applicant = stripUnsafe(strings.TrimSpace(p.Applicant))
	for i := range p.Steps {
		s := &p.Steps[i]
		s.Name = stripUnsafe(strings.TrimSpace(s.Name))
		s.Remark = stripUnsafe(strings.TrimSpace(s.Remark))
		s.Online.SystemName = stripUnsafe(strings.TrimSpace(s.Online.SystemName))
		s.Offline.Documents = trimAll(s.Offline.Documents)
		s.Offline.Handlers = cleanHandlers(s.Offline.Handlers)
		s.Parties = cleanParties(s.Parties)
		if s.WaitFor != nil {
			s.WaitFor.StepID = strings.TrimSpace(s.WaitFor.StepID)
			s.WaitFor.PartyID = strings.TrimSpace(s.WaitFor.PartyID)
			if s.WaitFor.StepID == "" {
				s.WaitFor = nil
			}
		}
	}
}

func trimAll(ss []string) []string {
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		t := strings.TrimSpace(s)
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

func cleanHandlers(hs []Handler) []Handler {
	out := make([]Handler, 0, len(hs))
	for _, h := range hs {
		h.Department = strings.TrimSpace(h.Department)
		h.Staff = trimAll(h.Staff)
		if h.Department != "" || len(h.Staff) > 0 {
			out = append(out, h)
		}
	}
	return out
}

// cleanParties 清理会签方：去空白、补子步骤缺省值、过滤空子步骤，
// 保留有效方（部门/人员/子步骤任一非空）
func cleanParties(ps []Party) []Party {
	out := make([]Party, 0, len(ps))
	for _, p := range ps {
		p.Department = strings.TrimSpace(p.Department)
		p.Staff = trimAll(p.Staff)
		ss := make([]SubStep, 0, len(p.SubSteps))
		for _, sub := range p.SubSteps {
			sub.Name = strings.TrimSpace(sub.Name)
			if sub.Name == "" {
				continue
			}
			// 旧数据兼容：mode 缺省按线上处理
			if sub.Mode == "" {
				sub.Mode = "online"
			}
			sub.Online.SystemName = strings.TrimSpace(sub.Online.SystemName)
			sub.Offline.Documents = trimAll(sub.Offline.Documents)
			sub.Offline.Handlers = cleanHandlers(sub.Offline.Handlers)
			ss = append(ss, sub)
		}
		p.SubSteps = ss
		if p.Department != "" || len(p.Staff) > 0 || len(ss) > 0 {
			out = append(out, p)
		}
	}
	return out
}

// decodeJSON 解析请求体(S1:限制 1MB,防超大载荷耗尽内存)
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}
