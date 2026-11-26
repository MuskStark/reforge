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

// registerAdminRoutes 挂载管理端路由（全部要求管理员会话）。
// 流程查看对登录用户开放,但无岗位的纯提交人只见自己的提交
func registerAdminRoutes(mux *http.ServeMux, st *postgresStore) {
	mux.HandleFunc("GET /api/admin/processes", func(w http.ResponseWriter, r *http.Request) {
		a, ok := currentActor(w, r, st) // 登录即可查看(数据查看权限)
		if !ok {
			return
		}
		var (
			list []*Process
			err  error
		)
		if a.isJobless() {
			list, err = st.ListForSubmitter(a.ID)
		} else {
			list, err = st.List()
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, list)
	})

	mux.HandleFunc("GET /api/admin/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		a, ok := currentActor(w, r, st) // 登录即可查看
		if !ok {
			return
		}
		if a.isJobless() {
			by, err := submitterOfProcess(r.Context(), st.db, r.PathValue("id"))
			if err != nil {
				writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
				return
			}
			if by != a.ID {
				writeError(w, http.StatusNotFound, "流程不存在")
				return
			}
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

	mux.HandleFunc("DELETE /api/admin/processes/{id}", handleAdminDeleteProcess(st))

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
			requestLogger(r).Error("新建线上系统失败", "err", err)
			writeError(w, http.StatusInternalServerError, "保存失败，请稍后重试")
			return
		}
		audit(r, "system.create", "target", so.Name)
		writeJSON(w, http.StatusOK, so)
	})

	mux.HandleFunc("DELETE /api/admin/systems/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		id := r.PathValue("id")
		ok, err := st.DeleteSystem(id)
		if err != nil {
			requestLogger(r).Error("删除线上系统失败", "id", id, "err", err)
			writeError(w, http.StatusInternalServerError, "删除失败，请稍后重试")
			return
		}
		if !ok {
			writeError(w, http.StatusNotFound, "系统不存在或已删除")
			return
		}
		audit(r, "system.delete", "id", id)
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	})
}

// handleAdminDeleteProcess 管理员删除流程:连同它的项目与全部记录(见 postgresStore.Delete)。
// 后台用的 /api/admin/processes/{id} 与旧地址 /api/processes/{id} 共用。
// 删掉的东西在数据库里不留痕,所以成败都在后端日志里留一行;失败原因只进日志,
// 不把内部错误原文返回给浏览器(2026-11-25 线上出现过一次「删除失败」却无从查起)。
func handleAdminDeleteProcess(st store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		id := r.PathValue("id")
		p, err := st.Get(id)
		if err != nil {
			requestLogger(r).Error("删除流程前读取失败", "process", id, "err", err)
			writeError(w, http.StatusInternalServerError, "读取失败，请稍后重试")
			return
		}
		if p == nil {
			writeError(w, http.StatusNotFound, "流程不存在或已删除")
			return
		}
		if ok, err := st.Delete(id); err != nil {
			requestLogger(r).Error("删除流程失败", "process", id, "name", p.Name, "err", err)
			writeError(w, http.StatusInternalServerError, "删除失败，请稍后重试")
			return
		} else if !ok {
			writeError(w, http.StatusNotFound, "流程不存在或已删除")
			return
		}
		audit(r, "process.delete", "process", id, "name", p.Name, "note", "连同其项目与全部记录")
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	}
}
