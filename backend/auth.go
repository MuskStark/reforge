package main

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// sessionData 会话载荷：携带用户名与角色（admin 可访问管理端）
type sessionData struct {
	Username  string
	Role      string
	ExpiresAt time.Time
}

// sessionStore 内存角色会话表（开发库单实例足够；重启即全量登出）
type sessionStore struct {
	mu     sync.RWMutex
	tokens map[string]sessionData
	ttl    time.Duration
}

func newSessionStore() *sessionStore {
	return &sessionStore{tokens: make(map[string]sessionData), ttl: 24 * time.Hour}
}

func (s *sessionStore) create(username, role string) string {
	token := newID()
	s.mu.Lock()
	s.tokens[token] = sessionData{Username: username, Role: role, ExpiresAt: time.Now().Add(s.ttl)}
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
		if err := decodeJSON(r, &body); err != nil {
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
		token := sessions.create(u.Username, u.Role)
		writeJSON(w, http.StatusCreated, map[string]any{
			"token": token,
			"user":  map[string]any{"id": u.ID, "username": u.Username, "role": u.Role},
		})
	}
}

// handleLogin POST /api/auth/login —— 用户密码登录；
// 未命中注册用户时回退校验环境变量引导管理员（FLOW_ADMIN_USER/PASS）
func handleLogin(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		username := strings.TrimSpace(body.Username)

		if u, err := st.GetUserByUsername(username); err != nil {
			writeError(w, http.StatusInternalServerError, "登录失败: "+err.Error())
			return
		} else if u != nil {
			if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(body.Password)) != nil {
				writeError(w, http.StatusUnauthorized, "账号或密码错误")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"token": sessions.create(u.Username, u.Role),
				"user":  map[string]any{"id": u.ID, "username": u.Username, "role": u.Role},
			})
			return
		}

		// 回退：环境变量引导管理员（系统级账号，非注册用户）
		envUser, envPass := adminCredentials()
		if username == envUser && subtleEqual(body.Password, envPass) {
			writeJSON(w, http.StatusOK, map[string]any{
				"token": sessions.create(envUser, "admin"),
				"user":  map[string]any{"id": "", "username": envUser, "role": "admin"},
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

// handleMe GET /api/auth/me —— 当前会话身份
func handleMe(w http.ResponseWriter, r *http.Request) {
	sd := sessions.get(bearerToken(r))
	if sd == nil {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"username": sd.Username, "role": sd.Role})
}

// handleLogout DELETE /api/auth/session
func handleLogout(w http.ResponseWriter, r *http.Request) {
	if token := bearerToken(r); token != "" {
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
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role"`
		}
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		body.Username = strings.TrimSpace(body.Username)
		body.Role = strings.TrimSpace(body.Role)
		if body.Role == "" {
			body.Role = "member"
		}
		if body.Role != "admin" && body.Role != "member" {
			writeError(w, http.StatusBadRequest, "角色无效（应为 admin 或 member）")
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
		u := &User{Username: body.Username, PasswordHash: string(hash), Role: body.Role}
		if err := st.CreateUser(u); err != nil {
			if strings.Contains(err.Error(), "duplicate key") {
				writeError(w, http.StatusConflict, "用户名已被占用")
				return
			}
			writeError(w, http.StatusInternalServerError, "创建失败: "+err.Error())
			return
		}
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
			writeError(w, http.StatusInternalServerError, "删除失败: "+err.Error())
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "用户不存在或已删除")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	}
}
