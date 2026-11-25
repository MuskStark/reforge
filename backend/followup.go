package main

import (
	"net/http"
	"time"
)

// currentUser 取当前登录用户（未登录写 401 返回 nil）。
// 首次登录还没改密码的会话只放行个人信息相关接口，其余一律拒绝（见 mustChangeFirst）。
func currentUser(w http.ResponseWriter, r *http.Request) *sessionData {
	token := bearerToken(r)
	sd := sessions.get(token)
	if sd == nil {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return nil
	}
	if mustChangeFirst(w, sd) {
		return nil
	}
	return sd
}

// mustChangeFirst 会话对应的账号是否"必须先改密码"。为真时写 403 并返回 true：
// 改完密码之前，除身份、改资料、改密码、注销外的一切接口都不可用。
func mustChangeFirst(w http.ResponseWriter, sd *sessionData) bool {
	if sd == nil || !sd.MustChangePwd {
		return false
	}
	writeJSON(w, http.StatusForbidden, map[string]string{
		"error": "首次登录，请先修改密码", "code": passwordChangeRequired,
	})
	return true
}

// loadProcess 取流程,不存在时写 404
func loadProcess(w http.ResponseWriter, st *postgresStore, id string) (*Process, bool) {
	p, err := st.Get(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
		return nil, false
	}
	if p == nil {
		writeError(w, http.StatusNotFound, "流程不存在")
		return nil, false
	}
	return p, true
}

// registerDefinitionRoutes 编辑流程定义。
// 流程定义是项目的"To-Be 工作副本":节点上的经办人(PM / BH / TH)、CTO 与管理员都能改(见 caps.editFlow);
// 版本快照由关卡引擎在 G3 / G6 通过时自动留存。
func registerDefinitionRoutes(mux *http.ServeMux, st *postgresStore) {
	mux.HandleFunc("PUT /api/admin/processes/{id}", func(w http.ResponseWriter, r *http.Request) {
		a, ok := currentActor(w, r, st)
		if !ok {
			return
		}
		p, ok := loadProcess(w, st, r.PathValue("id"))
		if !ok {
			return
		}
		// 还没有挂到项目上的流程,只有管理员与 CTO 能改
		allowed := a.isAdmin() || a.isCTO()
		projectID, _ := projectIDForProcess(r.Context(), st.db, p.ID)
		if projectID != "" {
			if c, err := loadCaps(r.Context(), st.db, projectID, a); err == nil {
				allowed = c.editFlow()
			}
		}
		if !allowed {
			writeError(w, http.StatusForbidden, "只有项目成员、CTO 或管理员可以修改流程")
			return
		}
		var body Process
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确: "+err.Error())
			return
		}
		body.ID = p.ID
		body.CreatedAt = p.CreatedAt
		body.UpdatedAt = time.Now()
		sanitize(&body)
		if msg := validateProcess(&body); msg != "" {
			writeError(w, http.StatusBadRequest, msg)
			return
		}
		if err := st.Update(&body); err != nil {
			writeError(w, http.StatusInternalServerError, "保存失败: "+err.Error())
			return
		}
		kind := "edited_form"
		if r.URL.Query().Get("via") == "chart" {
			kind = "edited_chart"
		}
		if projectID != "" {
			_ = addEventTx(r.Context(), st.db, projectID, "process", p.ID, a, kind, map[string]any{
				"steps": len(body.Steps), "name": body.Name,
			})
			_, _ = st.db.ExecContext(r.Context(), `UPDATE projects SET updated_at = now() WHERE id = $1`, projectID)
		}
		updated, _ := st.Get(p.ID)
		writeJSON(w, http.StatusOK, updated)
	})
}
