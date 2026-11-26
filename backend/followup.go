package main

import (
	"context"
	"database/sql"
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

// intakeFreshState 拉改单窗口要用的项目状态:提交人、是否在进行中、
// 承接是否还没开始(PMO 初析未完成且从未指派过 PM,即还在"等待初级分析")
func intakeFreshState(ctx context.Context, q runner, projectID string) (createdBy string, active, notStarted bool, err error) {
	var (
		status   string
		triageAt sql.NullTime
		hasPM    bool
	)
	err = q.QueryRowContext(ctx, `SELECT COALESCE(created_by, ''), status, triage_done_at,
		EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = projects.id AND m.role = 'pm')
		FROM projects WHERE id = $1`, projectID).Scan(&createdBy, &status, &triageAt, &hasPM)
	if err != nil {
		return
	}
	active = status == ProjActive
	notStarted = !triageAt.Valid && !hasPM
	return
}

// submitterMayEdit 提交人的改单窗口:项目是他提交的、仍在进行中,而且承接还没开始。
// 初析完成或指派 PM 之后即锁定,之后的调整走项目里的流程定义修改
func submitterMayEdit(ctx context.Context, q runner, projectID string, a *actor) bool {
	by, active, notStarted, err := intakeFreshState(ctx, q, projectID)
	return err == nil && active && notStarted && by != "" && by == a.ID
}

// registerDefinitionRoutes 编辑流程定义。
// 流程定义是项目的"To-Be 工作副本":节点上的经办人(PM / BH / TH)、CTO 与管理员都能改(见 caps.editFlow);
// 提交人另有一个改单窗口——自己提交的需求还没被处理(初析未完成、未指派 PM)时可自行修改;
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
			if !allowed && submitterMayEdit(r.Context(), st.db, projectID, a) {
				allowed = true
			}
		}
		if !allowed {
			writeError(w, http.StatusForbidden, "只有项目成员、CTO 或管理员可以修改流程；提交人可在需求开始处理前自行修改")
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
			// 承接还没开始时,把 As-Is 基线刷成最新定义:PMO 初析与自动诊断以改后的流程为准
			if _, _, notStarted, err := intakeFreshState(r.Context(), st.db, projectID); err == nil && notStarted {
				_ = snapshotVersionTx(r.Context(), st.db, projectID, &body, "as_is", "承接开始前修改后的流程定义（As-Is 基线随之刷新）", a.ID)
			}
		}
		updated, _ := st.Get(p.ID)
		writeJSON(w, http.StatusOK, updated)
	})
}
