package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const defaultAddr = "127.0.0.1:8080"

func main() {
	addr := defaultAddr
	if v := os.Getenv("FLOW_ADDR"); v != "" {
		addr = v
	}
	st, err := newStore(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatalf("初始化存储失败: %v", err)
	}
	defer st.Close()

	mux := http.NewServeMux()
	registerAdminRoutes(mux, st)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// 用户认证：注册（首个用户自动成为管理员）/ 登录 / 身份 / 注销 / 注册状态
	mux.HandleFunc("POST /api/auth/register", handleRegister(st))
	mux.HandleFunc("POST /api/auth/login", handleLogin(st))
	mux.HandleFunc("GET /api/auth/status", handleAuthStatus(st))
	mux.HandleFunc("GET /api/auth/me", handleMe)
	mux.HandleFunc("DELETE /api/auth/session", handleLogout)
	mux.HandleFunc("GET /api/admin/users", handleListUsers(st))
	mux.HandleFunc("GET /api/processes", func(w http.ResponseWriter, r *http.Request) {
		list, err := st.List()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)
	})
	mux.HandleFunc("POST /api/processes", func(w http.ResponseWriter, r *http.Request) {
		var p Process
		if err := decodeJSON(r, &p); err != nil {
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
			writeError(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, created)
	})
	mux.HandleFunc("GET /api/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc("DELETE /api/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		ok, err := st.Delete(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "删除失败: "+err.Error())
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "流程不存在或已删除")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	})

	log.Printf("ReForge（流程再造工程收集表）后端已启动: http://%s (API 前缀 /api，存储: PostgreSQL)", addr)
	if err := http.ListenAndServe(addr, withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}

// sanitize 去除首尾空白、过滤空标签/空人员/空依赖，保证落库数据干净
func sanitize(p *Process) {
	p.Name = strings.TrimSpace(p.Name)
	p.Description = strings.TrimSpace(p.Description)
	p.Applicant = strings.TrimSpace(p.Applicant)
	for i := range p.Steps {
		s := &p.Steps[i]
		s.Name = strings.TrimSpace(s.Name)
		s.Remark = strings.TrimSpace(s.Remark)
		s.Online.SystemName = strings.TrimSpace(s.Online.SystemName)
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

func decodeJSON(r *http.Request, v any) error {
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

// withCORS 允许本地前端跨端口直连调试
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
