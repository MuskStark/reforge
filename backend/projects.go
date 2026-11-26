package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// registerProjectRoutes 流程项目的全部接口(架构见 docs/process-management-architecture.md 第 12 节)
func registerProjectRoutes(mux *http.ServeMux, st *postgresStore) {
	// 项目
	mux.HandleFunc("GET /api/projects", st.handleListProjects)
	mux.HandleFunc("GET /api/projects/{id}", st.handleGetProject)
	mux.HandleFunc("PATCH /api/projects/{id}", st.handlePatchProject)
	mux.HandleFunc("POST /api/projects/{id}/status", st.handleProjectStatus)
	mux.HandleFunc("PUT /api/projects/{id}/members", st.handleMembers)
	mux.HandleFunc("POST /api/projects/{id}/stages/{seq}/enter", st.handleStageEnter)
	mux.HandleFunc("POST /api/projects/{id}/stages/{seq}/skip", st.handleStageSkip)
	mux.HandleFunc("GET /api/projects/{id}/events", st.handleProjectEvents)
	// 关卡评审
	mux.HandleFunc("GET /api/projects/{id}/reviews", st.handleListReviews)
	mux.HandleFunc("POST /api/projects/{id}/reviews", st.handleSubmitReview)
	mux.HandleFunc("POST /api/reviews/{id}/decide", st.handleDecideReview)
	mux.HandleFunc("POST /api/reviews/{id}/withdraw", st.handleWithdrawReview)
	mux.HandleFunc("GET /api/reviews/pending", st.handlePendingReviews)
	// 工作项
	mux.HandleFunc("GET /api/projects/{id}/items", st.handleListItems)
	mux.HandleFunc("POST /api/projects/{id}/items", st.handleCreateItem)
	mux.HandleFunc("PATCH /api/items/{id}", st.handlePatchItem)
	mux.HandleFunc("DELETE /api/items/{id}", st.handleDeleteItem)
	mux.HandleFunc("POST /api/items/{id}/links", st.handleLinkItem)
	mux.HandleFunc("DELETE /api/items/{id}/links", st.handleUnlinkItem)
	mux.HandleFunc("POST /api/items/{id}/split", st.handleSplitItem)
	mux.HandleFunc("GET /api/me/items", st.handleMyItems)
	// 评论与简报
	mux.HandleFunc("GET /api/projects/{id}/comments", st.handleListComments)
	mux.HandleFunc("POST /api/projects/{id}/comments", st.handleCreateComment)
	mux.HandleFunc("POST /api/projects/{id}/updates", st.handleProjectUpdate)
	// 流程版本
	mux.HandleFunc("GET /api/projects/{id}/versions", st.handleVersions)
	mux.HandleFunc("GET /api/projects/{id}/versions/{version}", st.handleVersionSteps)
	mux.HandleFunc("GET /api/projects/{id}/compare", st.handleCompare)
	// 通知与聚合
	mux.HandleFunc("GET /api/notifications", st.handleNotifications)
	mux.HandleFunc("POST /api/notifications/read", st.handleReadNotifications)
	mux.HandleFunc("GET /api/overview", st.handleOverview)
	mux.HandleFunc("GET /api/admin/overview", st.handleOverview) // 旧大屏沿用此路径
	// 导出:项目清单(CSV;GET 导出全部或某状态,POST {ids} 导出所选)与单个项目报告(Markdown / JSON)
	mux.HandleFunc("GET /api/projects/export.csv", st.handleExportProjectsCSV)
	mux.HandleFunc("POST /api/projects/export.csv", st.handleExportProjectsCSV)
	mux.HandleFunc("GET /api/projects/{id}/export", st.handleExportProject)
}

func pathID(r *http.Request) string { return strings.TrimSpace(r.PathValue("id")) }

// seqParam 解析路径里的阶段序号。上限只是防胡填的粗边界:每个项目有几个阶段取决于它立项时的模板,
// 是否越界由各接口在拿到项目后按"只能操作当前 / 更早的阶段"的规则判断。
func seqParam(w http.ResponseWriter, r *http.Request) (int, bool) {
	seq, err := strconv.Atoi(r.PathValue("seq"))
	if err != nil || seq < 1 || seq > maxStages {
		writeError(w, http.StatusBadRequest, "阶段序号不合法")
		return 0, false
	}
	return seq, true
}

// stageStatusOf 项目里某个序号的阶段现状
func stageStatusOf(stages []ProjectStage, seq int) (ProjectStage, bool) {
	if seq < 1 || seq > len(stages) {
		return ProjectStage{}, false
	}
	return stages[seq-1], true
}

// ---- 列表与详情 ----

func (s *postgresStore) handleListProjects(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	where, args := "", []any{}
	if a.isJobless() {
		// 无岗位的纯提交人:只看到自己提交的需求
		where = `WHERE pr.created_by = $1`
		args = append(args, a.ID)
	} else if r.URL.Query().Get("view") == "mine" && !a.isAdmin() && !a.isCTO() {
		// "我参与的":按项目成员过滤;管理员与 CTO 本来就看全部
		where = `WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = pr.id AND m.user_id = $1)`
		args = append(args, a.ID)
	}
	projects, err := listProjects(r.Context(), s.db, where, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	ids := make([]string, 0, len(projects))
	for _, pr := range projects {
		ids = append(ids, pr.ID)
	}
	bundle, err := loadBundle(r.Context(), s.db, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	wantPending, wantStatus, query := r.URL.Query().Get("pending"), r.URL.Query().Get("status"), strings.TrimSpace(r.URL.Query().Get("q"))
	out := []*ProjectView{}
	for _, pr := range projects {
		c, err := loadCaps(r.Context(), s.db, pr.ID, a)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		v := bundle.view(pr, nil, c)
		if wantPending != "" && v.PendingOn != wantPending {
			continue
		}
		if wantStatus != "" && v.Status != wantStatus {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(v.Name+" "+v.Applicant), strings.ToLower(query)) {
			continue
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *postgresStore) handleGetProject(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	pr, err := getProject(r.Context(), s.db, pathID(r), false)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if pr == nil || !joblessSees(a, pr) {
		writeError(w, http.StatusNotFound, "项目不存在")
		return
	}
	bundle, err := loadBundle(r.Context(), s.db, []string{pr.ID})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	users, err := s.ListUsers()
	if err != nil {
		writeErr(w, r, err)
		return
	}
	c, err := loadCaps(r.Context(), s.db, pr.ID, a)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, bundle.view(pr, users, c))
}

// ---- 修改 ----

func (s *postgresStore) handlePatchProject(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		Priority   *string         `json:"priority"`
		Value      *string         `json:"value"`
		Complexity *string         `json:"complexity"`
		DueDate    *string         `json:"dueDate"`
		Analysis   json.RawMessage `json:"analysis"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if body.Priority != nil && !validPriorities[*body.Priority] {
		writeError(w, http.StatusBadRequest, "优先级取值不合法")
		return
	}
	if body.Value != nil && *body.Value != "" && !validLevel(*body.Value) {
		writeError(w, http.StatusBadRequest, "改造价值应为 高 / 中 / 低")
		return
	}
	if body.Complexity != nil && *body.Complexity != "" && !validLevel(*body.Complexity) {
		writeError(w, http.StatusBadRequest, "复杂度应为 高 / 中 / 低")
		return
	}
	if body.DueDate != nil && *body.DueDate != "" && !validDate(*body.DueDate) {
		writeError(w, http.StatusBadRequest, "目标完成日格式应为 YYYY-MM-DD")
		return
	}
	analysis := ""
	if len(body.Analysis) > 0 && string(body.Analysis) != "null" {
		var obj map[string]any
		if json.Unmarshal(body.Analysis, &obj) != nil || obj == nil {
			writeError(w, http.StatusBadRequest, "分析报告必须是 JSON 对象")
			return
		}
		if len(body.Analysis) > 16*1024 {
			writeError(w, http.StatusBadRequest, "分析报告过长")
			return
		}
		analysis = string(body.Analysis)
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, _ []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.manage() {
			return noPermission()
		}
		if pr.Status == ProjDone || pr.Status == ProjCancelled {
			return badRequest("项目已结束，不能再修改")
		}
		changed := []string{}
		if body.Priority != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET priority = $2 WHERE id = $1`, pr.ID, *body.Priority); err != nil {
				return err
			}
			changed = append(changed, "优先级")
		}
		if body.Value != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET value = $2 WHERE id = $1`, pr.ID, *body.Value); err != nil {
				return err
			}
			changed = append(changed, "改造价值")
		}
		if body.Complexity != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET complexity = $2 WHERE id = $1`, pr.ID, *body.Complexity); err != nil {
				return err
			}
			changed = append(changed, "复杂度")
		}
		if body.DueDate != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET due_date = NULLIF($2,'')::date WHERE id = $1`, pr.ID, *body.DueDate); err != nil {
				return err
			}
			changed = append(changed, "目标完成日")
		}
		if analysis != "" {
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET analysis = $2::jsonb WHERE id = $1`, pr.ID, analysis); err != nil {
				return err
			}
			changed = append(changed, "分析报告")
		}
		if len(changed) == 0 {
			return nil
		}
		return addEventTx(r.Context(), tx, pr.ID, "project", "", a, "project_updated", map[string]any{"fields": changed})
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeProject(w, r, a, pathID(r))
}

// writeProject 回写项目完整视图
func (s *postgresStore) writeProject(w http.ResponseWriter, r *http.Request, a *actor, id string) {
	pr, err := getProject(r.Context(), s.db, id, false)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if pr == nil {
		writeError(w, http.StatusNotFound, "项目不存在")
		return
	}
	bundle, err := loadBundle(r.Context(), s.db, []string{id})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	users, err := s.ListUsers()
	if err != nil {
		writeErr(w, r, err)
		return
	}
	c, err := loadCaps(r.Context(), s.db, id, a)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, bundle.view(pr, users, c))
}

func (s *postgresStore) handleProjectStatus(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Note = trimRunes(body.Note, 500)
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		if body.Status == ProjCancelled && !c.skip() {
			return noPermission()
		}
		if body.Status != ProjCancelled && !c.manage() {
			return noPermission()
		}
		if pr.Status == body.Status {
			return conflict("项目已处于该状态")
		}
		switch body.Status {
		case ProjOnHold:
			if pr.Status != ProjActive {
				return badRequest("只有进行中的项目可以搁置")
			}
		case ProjActive:
			if pr.Status != ProjOnHold {
				return badRequest("只有已搁置的项目可以恢复")
			}
		case ProjCancelled:
			if pr.Status == ProjDone {
				return badRequest("已完成的项目不能取消")
			}
		case ProjDone:
			if pr.Status != ProjActive {
				return badRequest("只有进行中的项目可以标记完成")
			}
			// 验收阶段(模板里带 accept 标识的阶段,见 template.go)通过后才算完成;管理员与 CTO 可越过
			if accept, ok := pr.acceptStage(); ok && !c.Admin && !c.CTO {
				st, has := stageStatusOf(stages, accept.Seq)
				if !has || (st.Status != StageApproved && st.Status != StageSkipped) {
					return badRequest("「" + accept.Name + "」通过后才能标记项目完成")
				}
			}
		default:
			return badRequest("项目状态不合法")
		}
		now := time.Now()
		if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET status = $2,
			completed_at = CASE WHEN $2 = 'done' THEN COALESCE(completed_at, $3) ELSE NULL END WHERE id = $1`,
			pr.ID, body.Status, now); err != nil {
			return err
		}
		if body.Status == ProjCancelled {
			// 取消项目时,仍在等待的评审一并作废;等 PMO 终审的标记也一并清掉
			if _, err := tx.ExecContext(r.Context(), `UPDATE gate_reviews SET status = 'withdrawn', decided_at = now()
				WHERE project_id = $1 AND status = 'pending'`, pr.ID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET final_status = '', final_review_id = '' WHERE id = $1`, pr.ID); err != nil {
				return err
			}
		}
		if err := addEventTx(r.Context(), tx, pr.ID, "project", "", a, "project_status", map[string]any{
			"from": pr.Status, "to": body.Status, "note": body.Note,
		}); err != nil {
			return err
		}
		members, err := memberUserIDsTx(r.Context(), tx, pr.ID)
		if err != nil {
			return err
		}
		label := map[string]string{ProjOnHold: "已搁置", ProjActive: "已恢复", ProjCancelled: "已取消", ProjDone: "已完成"}[body.Status]
		return notifyManyTx(r.Context(), tx, members, "project_status", pr.ID, "", "",
			"「"+pr.Name+"」"+label, "project_status:"+pr.ID+":"+body.Status+":"+now.Format("20060102150405"))
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeProject(w, r, a, pathID(r))
}

// handleMembers 增删项目成员(流程的权限分配,规则见 caps.canAssign):
// PMO 指派 PM(需求承接里在初级分析之后),CTO 分配 TH(科技经办),PM 分配 BH(业务经办),管理员不受限。
// PM 可以有多名,其中一名是主负责(lead=true 指定;没指定时取最早到岗的)。
func (s *postgresStore) handleMembers(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
		Action string `json:"action"` // add | remove
		Lead   *bool  `json:"lead"`   // 仅指派 PM 时有意义:设为主负责
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if !validProjectRoles[body.Role] {
		writeError(w, http.StatusBadRequest, "项目角色不合法")
		return
	}
	if body.Action != "add" && body.Action != "remove" {
		writeError(w, http.StatusBadRequest, "action 应为 add 或 remove")
		return
	}
	u, err := s.GetUserByID(body.UserID)
	if err != nil || u == nil {
		writeError(w, http.StatusBadRequest, "用户不存在")
		return
	}
	err = s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		ctx := r.Context()
		c, err := loadCaps(ctx, tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.canAssign(body.Role) {
			return noPermission()
		}
		if pr.Status == ProjDone || pr.Status == ProjCancelled {
			return badRequest("项目已结束，不能再调整成员")
		}
		intake, hasIntake := pr.intakeStage()
		atIntakeGate := hasIntake && pr.CurrentStage == intake.Seq && stages[intake.Seq-1].Status == StagePending
		roleLabel := map[string]string{RolePM: "PM", RoleHandler: "BH", RoleDev: "TH", RoleViewer: "PMO"}[body.Role]
		if body.Action == "remove" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = $3`,
				pr.ID, u.ID, body.Role); err != nil {
				return err
			}
			last := false
			if body.Role == RolePM {
				lead, err := syncLeadTx(ctx, tx, pr.ID)
				if err != nil {
					return err
				}
				// 承接阶段:最后一名 PM 被移除后回到待指派,由 PMO 重新指派;新 PM 到岗时阶段重新启动
				if hasIntake && lead == "" && pr.CurrentStage == intake.Seq && stages[intake.Seq-1].Status == StageInProgress {
					if err := setStageStatusTx(ctx, tx, pr.ID, intake.Seq, StagePending); err != nil {
						return err
					}
					if _, err := tx.ExecContext(ctx, `UPDATE projects SET started_at = NULL WHERE id = $1`, pr.ID); err != nil {
						return err
					}
					last = true
				}
			}
			return addEventTx(ctx, tx, pr.ID, "member", u.ID, a, "member_removed", map[string]any{
				"user": displayName(u), "role": roleLabel, "last": last,
			})
		}
		// 需求承接:PMO 要先完成初级分析,才能指派第一位 PM(管理员不受此限,可以兜底)
		if body.Role == RolePM && c.PMO && !c.Admin && pr.TriageDoneAt == nil && atIntakeGate {
			return badRequest("请先完成初级分析，再指派 PM")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
			VALUES ($1, $2, $3, $4, now()) ON CONFLICT DO NOTHING`, pr.ID, u.ID, body.Role, a.ID); err != nil {
			return err
		}
		isLead := false
		if body.Role == RolePM {
			// 主负责 PM:显式指定的优先;否则保持现任,现任不在了就取最早到岗的
			if body.Lead != nil && *body.Lead {
				if err := setLeadTx(ctx, tx, pr.ID, u.ID); err != nil {
					return err
				}
				isLead = true
			} else if lead, err := syncLeadTx(ctx, tx, pr.ID); err != nil {
				return err
			} else {
				isLead = lead == u.ID
			}
		}
		// 第一位项目经理到岗:项目正式启动,阶段 1 进入进行中
		if body.Role == RolePM && pr.CurrentStage == 1 && stages[0].Status == StagePending {
			if err := setStageStatusTx(ctx, tx, pr.ID, 1, StageInProgress); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE projects SET started_at = COALESCE(started_at, now()) WHERE id = $1`, pr.ID); err != nil {
				return err
			}
		}
		if err := addEventTx(ctx, tx, pr.ID, "member", u.ID, a, "member_added", map[string]any{
			"user": displayName(u), "role": roleLabel, "lead": isLead,
		}); err != nil {
			return err
		}
		text := "你被加入「" + pr.Name + "」，担任" + roleLabel
		if isLead {
			text += "（主负责）"
		}
		return notifyTx(ctx, tx, u.ID, "member_added", pr.ID, "", "",
			text, "member:"+pr.ID+":"+u.ID+":"+body.Role+":"+time.Now().Format("20060102150405"))
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeProject(w, r, a, pathID(r))
}

// handleStageEnter 回退到某个已通过的阶段重做(其后阶段重置),须填原因
func (s *postgresStore) handleStageEnter(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	seq, ok := seqParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Reason = trimRunes(body.Reason, 500)
	if body.Reason == "" {
		writeError(w, http.StatusBadRequest, "回退阶段必须填写原因")
		return
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.manage() {
			return noPermission()
		}
		if pr.Status != ProjActive {
			return badRequest("项目不在进行中")
		}
		if seq >= pr.CurrentStage || seq > pr.stageCount() {
			return badRequest("只能回退到当前阶段之前的阶段")
		}
		cur, ok := currentStageOf(pr, stages)
		if !ok {
			return conflict("项目的阶段数据异常，请刷新后重试")
		}
		if cur.Status == StageInReview {
			return conflict("当前阶段正在评审，请先撤回评审再回退")
		}
		for k := seq; k <= pr.stageCount(); k++ {
			if err := setStageStatusTx(r.Context(), tx, pr.ID, k, StagePending); err != nil {
				return err
			}
		}
		if err := setStageStatusTx(r.Context(), tx, pr.ID, seq, StageInProgress); err != nil {
			return err
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET current_stage = $2 WHERE id = $1`, pr.ID, seq); err != nil {
			return err
		}
		if err := addEventTx(r.Context(), tx, pr.ID, "stage", "", a, "stage_rewound", map[string]any{
			"from": pr.stageName(pr.CurrentStage), "to": pr.stageName(seq), "reason": body.Reason,
		}); err != nil {
			return err
		}
		members, err := memberUserIDsTx(r.Context(), tx, pr.ID)
		if err != nil {
			return err
		}
		return notifyManyTx(r.Context(), tx, members, "stage_rewound", pr.ID, "", "",
			"「"+pr.Name+"」退回到「"+pr.stageName(seq)+"」："+body.Reason, "stage_rewound:"+pr.ID+":"+time.Now().Format("20060102150405"))
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeProject(w, r, a, pathID(r))
}

// handleStageSkip 跳过当前阶段(CTO / 管理员),须填原因
func (s *postgresStore) handleStageSkip(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	seq, ok := seqParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Reason = trimRunes(body.Reason, 500)
	if body.Reason == "" {
		writeError(w, http.StatusBadRequest, "跳过阶段必须填写原因")
		return
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.skip() {
			return noPermission()
		}
		if pr.Status != ProjActive {
			return badRequest("项目不在进行中")
		}
		if seq != pr.CurrentStage {
			return badRequest("只能跳过当前阶段")
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE gate_reviews SET status = 'withdrawn', decided_at = now()
			WHERE project_id = $1 AND stage_seq = $2 AND status = 'pending'`, pr.ID, seq); err != nil {
			return err
		}
		if err := advanceAfterApprovalTx(r.Context(), tx, pr, stages, seq, true); err != nil {
			return err
		}
		// 跳过承接阶段时不再等 PMO 终审
		if _, err := tx.ExecContext(r.Context(), `UPDATE projects SET final_status = '', final_review_id = '' WHERE id = $1`, pr.ID); err != nil {
			return err
		}
		if err := addEventTx(r.Context(), tx, pr.ID, "stage", "", a, "stage_skipped", map[string]any{
			"stage": pr.stageName(seq), "reason": body.Reason,
		}); err != nil {
			return err
		}
		members, err := memberUserIDsTx(r.Context(), tx, pr.ID)
		if err != nil {
			return err
		}
		text := "「" + pr.Name + "」的「" + pr.stageName(seq) + "」被跳过：" + body.Reason
		if n := pr.nextStageName(seq); n != "" {
			text += "，进入「" + n + "」"
		}
		return notifyManyTx(r.Context(), tx, members, "stage_skipped", pr.ID, "", "", text,
			"stage_skipped:"+pr.ID+":"+itoa(seq)+":"+time.Now().Format("20060102150405"))
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeProject(w, r, a, pathID(r))
}

func (s *postgresStore) handleProjectEvents(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	// 无岗位的纯提交人只能看自己项目的时间线
	if a.isJobless() {
		pr, err := getProject(r.Context(), s.db, pathID(r), false)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		if pr == nil || !joblessSees(a, pr) {
			writeError(w, http.StatusNotFound, "项目不存在")
			return
		}
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id, project_id, scope, target_id, actor_id, actor_name, kind, detail, created_at
		FROM events WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 300`, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var detail []byte
		if err := rows.Scan(&e.ID, &e.ProjectID, &e.Scope, &e.TargetID, &e.ActorID, &e.ActorName, &e.Kind, &detail, &e.CreatedAt); err != nil {
			writeErr(w, r, err)
			return
		}
		e.Detail = rawOrNull(detail)
		out = append(out, e)
	}
	writeJSON(w, http.StatusOK, out)
}
