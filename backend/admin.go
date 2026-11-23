package main

import (
	"net/http"
	"os"
	"strings"
)

// adminCredentials 环境变量引导管理员（系统级账号，非注册用户）：
// 默认 admin / flow123，可用 FLOW_ADMIN_USER、FLOW_ADMIN_PASS 覆盖
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

// registerAdminRoutes 挂载管理端路由（全部要求管理员会话）
func registerAdminRoutes(mux *http.ServeMux, st store) {
	mux.HandleFunc("GET /api/admin/processes", func(w http.ResponseWriter, r *http.Request) {
		if currentUser(w, r) == nil { // 登录即可查看(数据查看权限)
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
		if currentUser(w, r) == nil { // 登录即可查看
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
		if err := decodeJSON(w, r, &body); err != nil {
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
