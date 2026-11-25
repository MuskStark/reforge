package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// sessionData 会话载荷：携带用户名、系统角色与用户 ID（admin 可访问管理端）
type sessionData struct {
	Username  string
	Role      string
	UserID    string // users.id;环境变量引导的管理员没有用户行,为空
	ExpiresAt time.Time
	// 登录时为 true 表示这个账号还没改过管理员设定的密码;改完密码后清除
	MustChangePwd bool
}

// passwordChangeRequired "必须先改密码"拒绝响应里的错误码(前端据此弹出强制改密)
const passwordChangeRequired = "PASSWORD_CHANGE_REQUIRED"

// sessionStore 内存角色会话表（开发库单实例足够；重启即全量登出）
type sessionStore struct {
	mu     sync.RWMutex
	tokens map[string]sessionData
	ttl    time.Duration
}

func newSessionStore() *sessionStore {
	return &sessionStore{tokens: make(map[string]sessionData), ttl: 24 * time.Hour}
}

func (s *sessionStore) create(username, role, userID string, mustChange bool) string {
	token := newID()
	s.mu.Lock()
	s.tokens[token] = sessionData{Username: username, Role: role, UserID: userID, ExpiresAt: time.Now().Add(s.ttl), MustChangePwd: mustChange}
	s.mu.Unlock()
	return token
}

func (s *sessionStore) get(token string) *sessionData {
	s.mu.RLock()
	sd, ok := s.tokens[token]
	s.mu.RUnlock()
	if !ok {
		return nil
	}
	if time.Now().After(sd.ExpiresAt) {
		s.mu.Lock()
		delete(s.tokens, token)
		s.mu.Unlock()
		return nil
	}
	return &sd
}

func (s *sessionStore) revoke(token string) {
	s.mu.Lock()
	delete(s.tokens, token)
	s.mu.Unlock()
}

// revokeByUsername(F03):账号被删除时吊销其全部存量会话
func (s *sessionStore) revokeByUsername(username string) {
	s.mu.Lock()
	for t, sd := range s.tokens {
		if sd.Username == username {
			delete(s.tokens, t)
		}
	}
	s.mu.Unlock()
}

// clearMustChange 改完密码后,当前会话解除"必须先改密码"的限制
func (s *sessionStore) clearMustChange(token string) {
	s.mu.Lock()
	if sd, ok := s.tokens[token]; ok {
		sd.MustChangePwd = false
		s.tokens[token] = sd
	}
	s.mu.Unlock()
}

// revokeOthers 改完密码后吊销同一账号的其余会话(改密前的登录一律失效)
func (s *sessionStore) revokeOthers(token, username string) {
	s.mu.Lock()
	for t, sd := range s.tokens {
		if t != token && sd.Username == username {
			delete(s.tokens, t)
		}
	}
	s.mu.Unlock()
}

var sessions = newSessionStore()

// bearerToken 从 Authorization: Bearer <token> 提取会话令牌
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

// requireAdmin 校验会话且角色为管理员；未通过时写入 401/403 并返回 false
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	token := bearerToken(r)
	sd := sessions.get(token)
	if sd == nil {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return false
	}
	if mustChangeFirst(w, sd) {
		return false
	}
	if sd.Role != "admin" {
		writeError(w, http.StatusForbidden, "需要管理员权限")
		return false
	}
	return true
}

// ---- 用户认证 ----

// validateCredential 用户名 2-32 字符；密码 6-64 字符
func validateCredential(username, password string) string {
	if n := len([]rune(strings.TrimSpace(username))); n < 2 || n > 32 {
		return "用户名长度需在 2-32 个字符之间"
	}
	if len(password) < 6 || len(password) > 64 {
		return "密码长度需在 6-64 个字符之间"
	}
	return ""
}

// handleRegister POST /api/auth/register —— 仅用于引导首个管理员：
// 系统已有注册用户后公开注册关闭（403），账号由管理员在后台创建
func handleRegister(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		body.Username = strings.TrimSpace(body.Username)
		if msg := validateCredential(body.Username, body.Password); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if n, err := st.CountUsers(); err != nil {
			writeError(w, http.StatusInternalServerError, "注册失败: "+err.Error())
			return
		} else if n > 0 {
			writeError(w, http.StatusForbidden, "公开注册已关闭，请联系管理员创建账号")
			return
		}
		if existing, err := st.GetUserByUsername(body.Username); err != nil {
			writeError(w, http.StatusInternalServerError, "注册失败: "+err.Error())
			return
		} else if existing != nil {
			writeError(w, http.StatusConflict, "用户名已被占用")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "密码加密失败")
			return
		}
		u := &User{Username: body.Username, PasswordHash: string(hash)}
		if err := st.CreateUser(u); err != nil {
			if strings.Contains(err.Error(), "duplicate key") {
				writeError(w, http.StatusConflict, "用户名已被占用")
				return
			}
			writeError(w, http.StatusInternalServerError, "注册失败: "+err.Error())
			return
		}
		// 公开注册的密码由用户自己设定,不强制改
		token := sessions.create(u.Username, u.Role, u.ID, false)
		requestLogger(r).Info("audit", "action", "auth.register", "user", u.Username, "note", "首个注册用户,成为管理员")
		writeJSON(w, http.StatusCreated, map[string]any{
			"token": token,
			"user":  publicUser(u),
		})
	}
}

// handleLogin POST /api/auth/login —— 用户密码登录；
// 未命中注册用户时回退校验环境变量引导管理员（FLOW_ADMIN_USER/PASS）
func handleLogin(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// S2 登录限流:按 IP+账号,15 分钟 5 次失败锁定
		ip := clientIP(r)
		r.Body = http.MaxBytesReader(w, r.Body, 4096) // 登录载荷极小,收紧到 4KB
		raw, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			writeError(w, http.StatusBadRequest, "请求数据过大")
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		username := strings.TrimSpace(body.Username)
		rlKey := "login:" + ip + "|" + username
		if !loginLimiter.allow(rlKey) {
			// 记下被锁定的尝试:是有人在试密码,还是用户自己忘了密码
			requestLogger(r).Warn("audit", "action", "auth.login_locked", "user", username)
			writeError(w, http.StatusTooManyRequests, "尝试次数过多,请 15 分钟后再试")
			return
		}

		fail := func(code int, msg string) {
			loginLimiter.hit(rlKey)
			loginAccountLimiter.hit("acct:" + username)
			requestLogger(r).Warn("audit", "action", "auth.login_failed", "user", username, "reason", msg)
			writeError(w, code, msg)
		}

		if u, err := st.GetUserByUsername(username); err != nil {
			requestLogger(r).Error("登录时读取用户失败", "err", err)
			writeError(w, http.StatusInternalServerError, "登录失败")
			return
		} else if u != nil {
			if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(body.Password)) != nil {
				fail(http.StatusUnauthorized, "账号或密码错误")
				return
			}
			requestLogger(r).Info("audit", "action", "auth.login", "user", u.Username, "how", "password", "must_change_password", u.MustChangePassword)
			writeJSON(w, http.StatusOK, map[string]any{
				"token": sessions.create(u.Username, u.Role, u.ID, u.MustChangePassword),
				"user":  publicUser(u),
			})
			return
		}

		// 回退：环境变量引导管理员（系统级账号，非注册用户）
		envUser, envPass := adminCredentials()
		if username != envUser {
			fail(http.StatusUnauthorized, "账号或密码错误")
			return
		}
		if username == envUser && !subtleEqual(body.Password, envPass) {
			fail(http.StatusUnauthorized, "账号或密码错误")
			return
		}
		if username == envUser && subtleEqual(body.Password, envPass) {
			requestLogger(r).Info("audit", "action", "auth.login", "user", envUser, "how", "env-admin")
			writeJSON(w, http.StatusOK, map[string]any{
				"token": sessions.create(envUser, "admin", "", false),
				"user": map[string]any{"id": "", "username": envUser, "role": "admin",
					"displayName": envUser, "department": "", "jobRole": "", "mustChangePassword": false},
			})
			return
		}
		writeError(w, http.StatusUnauthorized, "账号或密码错误")
	}
}

// handleAuthStatus GET /api/auth/status —— 注册开放状态（供前端提示"首个注册用户将成为管理员"）
func handleAuthStatus(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, err := st.CountUsers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"hasUsers": n > 0, "userCount": n})
	}
}

// handleMe GET /api/auth/me —— 当前会话身份(含显示名、部门、岗位)
func handleMe(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sd := sessions.get(bearerToken(r))
		if sd == nil {
			writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
			return
		}
		u := &User{ID: sd.UserID, Username: sd.Username, Role: sd.Role, DisplayName: sd.Username}
		if sd.UserID != "" {
			if row, err := st.GetUserByID(sd.UserID); err == nil && row != nil {
				u = row
			}
		}
		writeJSON(w, http.StatusOK, publicUser(u))
	}
}

// publicUser 对外暴露的用户信息(不含口令散列)
func publicUser(u *User) map[string]any {
	return map[string]any{
		"id": u.ID, "username": u.Username, "role": u.Role,
		"displayName": displayName(u), "department": u.Department, "jobRole": u.JobRole,
		"mustChangePassword": u.MustChangePassword,
	}
}

// handleLogout DELETE /api/auth/session
func handleLogout(w http.ResponseWriter, r *http.Request) {
	if token := bearerToken(r); token != "" {
		// 吊销之前先认人:访问日志那一行认出的也是吊销前的会话
		if sd := sessions.get(token); sd != nil {
			requestLogger(r).Info("audit", "action", "auth.logout", "user", sd.Username)
		}
		sessions.revoke(token)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"loggedOut": true})
}

// handleListUsers GET /api/admin/users —— 管理员查看注册用户
func handleListUsers(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		users, err := st.ListUsers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, users)
	}
}

// subtleEqual 恒定时间字符串比较（防时序攻击）
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// handleAdminCreateUser POST /api/admin/users —— 管理员创建用户（显式角色）
func handleAdminCreateUser(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		var body struct {
			Username    string `json:"username"`
			Password    string `json:"password"`
			Role        string `json:"role"`
			DisplayName string `json:"displayName"`
			Department  string `json:"department"`
			JobRole     string `json:"jobRole"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		body.Username = strings.TrimSpace(body.Username)
		body.Role = strings.TrimSpace(body.Role)
		body.DisplayName, body.Department = trimRunes(body.DisplayName, 32), trimRunes(body.Department, 64)
		body.JobRole = strings.TrimSpace(body.JobRole)
		if body.Role == "" {
			body.Role = "member"
		}
		if body.Role != "admin" && body.Role != "member" {
			writeError(w, http.StatusBadRequest, "角色无效（应为 admin 或 member）")
			return
		}
		if body.JobRole == "" {
			body.JobRole = RoleHandler
		}
		if !validJobRoles[body.JobRole] {
			writeError(w, http.StatusBadRequest, "岗位无效（应为 PMO、CTO、PM、BH 或 TH）")
			return
		}
		if msg := validateCredential(body.Username, body.Password); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if existing, err := st.GetUserByUsername(body.Username); err != nil {
			writeError(w, http.StatusInternalServerError, "创建失败: "+err.Error())
			return
		} else if existing != nil {
			writeError(w, http.StatusConflict, "用户名已被占用")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "密码加密失败")
			return
		}
		// 密码由管理员设定:首次登录必须先改成自己的密码
		u := &User{Username: body.Username, PasswordHash: string(hash), Role: body.Role,
			DisplayName: body.DisplayName, Department: body.Department, JobRole: body.JobRole,
			MustChangePassword: true}
		if err := st.CreateUser(u); err != nil {
			if strings.Contains(err.Error(), "duplicate key") {
				writeError(w, http.StatusConflict, "用户名已被占用")
				return
			}
			writeError(w, http.StatusInternalServerError, "创建失败: "+err.Error())
			return
		}
		audit(r, "user.create", "target", u.Username, "role", u.Role, "job", u.JobRole)
		writeJSON(w, http.StatusCreated, u)
	}
}

// handleAdminDeleteUser DELETE /api/admin/users/{id} —— 管理员删除用户；
// 防呆：不能删除当前登录账号、不能删除最后一名管理员
func handleAdminDeleteUser(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		id := r.PathValue("id")
		target, err := st.GetUserByID(id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "删除失败: "+err.Error())
			return
		}
		if target == nil {
			writeError(w, http.StatusNotFound, "用户不存在或已删除")
			return
		}
		if sd := sessions.get(bearerToken(r)); sd != nil && sd.Username == target.Username {
			writeError(w, http.StatusForbidden, "不能删除当前登录账号")
			return
		}
		if target.Role == "admin" {
			if n, err := st.CountAdmins(); err != nil {
				writeError(w, http.StatusInternalServerError, "删除失败: "+err.Error())
				return
			} else if n <= 1 {
				writeError(w, http.StatusForbidden, "系统至少需要保留一名管理员")
				return
			}
		}
		ok, err := st.DeleteUser(id)
		if err != nil {
			requestLogger(r).Error("删除用户失败", "target", target.Username, "err", err)
			writeError(w, http.StatusInternalServerError, "删除失败,请稍后重试")
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "用户不存在或已删除")
			return
		}
		// F03:吊销被删用户全部存量会话(角色快照立即失效)
		if target != nil {
			sessions.revokeByUsername(target.Username)
		}
		audit(r, "user.delete", "target", target.Username, "role", target.Role)
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	}
}
