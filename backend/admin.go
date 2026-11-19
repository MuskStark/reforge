package main

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// adminCredentials 开发环境账号：默认 admin / flow123，可用环境变量覆盖
func adminCredentials() (user, pass string) {
	user = os.Getenv("FLOW_ADMIN_USER")
	if user == "" {
		user = "admin"
	}
	pass = os.Getenv("FLOW_ADMIN_PASS")
	if pass == "" {
		pass = "flow123"
	}
	return user, pass
}

// sessionStore 内存会话表（开发库单实例足够；重启即全量登出）
type sessionStore struct {
	mu      sync.RWMutex
	tokens  map[string]time.Time
	ttl     time.Duration
}

func newSessionStore() *sessionStore {
	return &sessionStore{tokens: make(map[string]time.Time), ttl: 24 * time.Hour}
}

func (s *sessionStore) create() string {
	token := newID()
	s.mu.Lock()
	s.tokens[token] = time.Now().Add(s.ttl)
	s.mu.Unlock()
	return token
}

func (s *sessionStore) valid(token string) bool {
	s.mu.RLock()
	exp, ok := s.tokens[token]
	s.mu.RUnlock()
	if !ok {
		return false
	}
	if time.Now().After(exp) {
		s.mu.Lock()
		delete(s.tokens, token)
		s.mu.Unlock()
		return false
	}
	return true
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

// requireAdmin 校验会话；未通过时写入 401 并返回 false
func requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	token := bearerToken(r)
	if token == "" || !sessions.valid(token) {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return false
	}
	return true
}

// handleAdminLogin POST /api/admin/login
func handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	user, pass := adminCredentials()
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(body.Username)), []byte(user)) != 1 ||
		subtle.ConstantTimeCompare([]byte(body.Password), []byte(pass)) != 1 {
		writeError(w, http.StatusUnauthorized, "账号或密码错误")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     sessions.create(),
		"expiresIn": int((24 * time.Hour).Seconds()),
	})
}

// handleAdminLogout DELETE /api/admin/session
func handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if token := bearerToken(r); token != "" {
		sessions.revoke(token)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"loggedOut": true})
}

// handleAdminWhoami GET /api/admin/session（前端启动时校验已有令牌）
func handleAdminWhoami(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	user, _ := adminCredentials()
	writeJSON(w, http.StatusOK, map[string]string{"username": user})
}

// registerAdminRoutes 挂载受保护的管理端路由
func registerAdminRoutes(mux *http.ServeMux, st store) {
	mux.HandleFunc("POST /api/admin/login", handleAdminLogin)
	mux.HandleFunc("DELETE /api/admin/session", handleAdminLogout)
	mux.HandleFunc("GET /api/admin/session", handleAdminWhoami)

	mux.HandleFunc("GET /api/admin/processes", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		list, err := st.List()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)
	})

	mux.HandleFunc("GET /api/admin/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
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

	mux.HandleFunc("DELETE /api/admin/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
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

	// ---- 线上系统库（公开读，管理写）----

	mux.HandleFunc("GET /api/systems", func(w http.ResponseWriter, r *http.Request) {
		list, err := st.ListSystems()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)
	})

	mux.HandleFunc("POST /api/admin/systems", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		name := strings.TrimSpace(body.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "系统名称不能为空")
			return
		}
		so, err := st.CreateSystem(name)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, so)
	})

	mux.HandleFunc("DELETE /api/admin/systems/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		ok, err := st.DeleteSystem(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "删除失败: "+err.Error())
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "系统不存在或已删除")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	})
}
