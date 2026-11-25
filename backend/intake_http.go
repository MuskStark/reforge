package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// registerIntakeRoutes 需求承接的接口(规则见 docs/process-management-architecture.md 第 21 节)。
// 承接挂在项目的第一个阶段(标识 intake)上,所以路径都挂在项目下;
// 指派 PM 仍走 PUT /api/projects/{id}/members,提交评估仍走 POST /api/projects/{id}/reviews。
func registerIntakeRoutes(mux *http.ServeMux, st *postgresStore) {
	mux.HandleFunc("GET /api/projects/{id}/intake", st.handleGetIntake)
	mux.HandleFunc("PUT /api/projects/{id}/intake/triage", st.handleIntakeTriage)
	mux.HandleFunc("PUT /api/projects/{id}/intake/solution", st.handleIntakeSolution)
	mux.HandleFunc("POST /api/projects/{id}/intake/cto-support", st.handleIntakeSupport)
	mux.HandleFunc("POST /api/projects/{id}/intake/final", st.handleIntakeFinal)
	mux.HandleFunc("POST /api/projects/{id}/intake/points", st.handleCreatePoint)
	mux.HandleFunc("PATCH /api/intake/points/{id}", st.handlePatchPoint)
	mux.HandleFunc("DELETE /api/intake/points/{id}", st.handleDeletePoint)
	mux.HandleFunc("PUT /api/reviews/{id}/assessment", st.handleSaveAssessment)
}

// intakeViewOf 读出承接的完整视图;项目不存在或没有承接阶段时返回 nil
func (s *postgresStore) intakeViewOf(ctx context.Context, a *actor, id string) (*IntakeView, error) {
	pr, err := getProject(ctx, s.db, id, false)
	if err != nil {
		return nil, err
	}
	if pr == nil {
		return nil, nil
	}
	st, ok := pr.intakeStage()
	if !ok {
		return nil, nil
	}
	bundle, err := loadBundle(ctx, s.db, []string{id})
	if err != nil {
		return nil, err
	}
	users, err := s.ListUsers()
	if err != nil {
		return nil, err
	}
	// a 为 nil 时只读(导出用):不解析任何人的能力
	c := caps{}
	if a != nil {
		if c, err = loadCaps(ctx, s.db, id, a); err != nil {
			return nil, err
		}
	}
	var cur ProjectStage
	for _, x := range bundle.stages[id] {
		if x.Seq == st.Seq {
			cur = x
		}
	}
	v, err := buildIntakeView(ctx, s.db, pr, st, cur, hasPM(bundle.members[id]), bundle.procs[pr.ProcessID], bundle.asis[id], a, c, userNames(users))
	if err != nil {
		return nil, err
	}
	v.LeadPmID, v.LeadPmName = leadPmOf(pr, bundle.members[id])
	return v, nil
}

func hasPM(members []MemberView) bool {
	for _, m := range members {
		if m.Role == RolePM {
			return true
		}
	}
	return false
}

// writeIntake 回写承接的完整视图
func (s *postgresStore) writeIntake(w http.ResponseWriter, r *http.Request, a *actor, id string) {
	v, err := s.intakeViewOf(r.Context(), a, id)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if v == nil {
		writeError(w, http.StatusNotFound, "项目不存在，或它的第一个阶段不是需求承接阶段")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *postgresStore) handleGetIntake(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	s.writeIntake(w, r, a, pathID(r))
}

// intakeContextTx 承接类写操作的公共校验:项目在进行中、第一个阶段是承接阶段。返回承接阶段
func intakeContextTx(pr *Project) (StageTemplate, error) {
	st, ok := pr.intakeStage()
	if !ok {
		return StageTemplate{}, badRequest("这个项目的第一个阶段不是需求承接阶段")
	}
	if pr.Status != ProjActive {
		return StageTemplate{}, badRequest("项目不在进行中")
	}
	return st, nil
}

// ---- PMO 初级分析 ----

// handleIntakeTriage PUT /api/projects/{id}/intake/triage —— PMO 的初级分析:改造价值、复杂度、优先级、
// 目标完成日、分析结论与流程是否完整。done=true 表示完成初级分析(之后才能指派 PM)。
// 只在还没指派 PM 时可改;PM 到岗后这几项归 PM 维护(PATCH /api/projects/{id})。
func (s *postgresStore) handleIntakeTriage(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		Value            *string `json:"value"`
		Complexity       *string `json:"complexity"`
		Priority         *string `json:"priority"`
		DueDate          *string `json:"dueDate"`
		Conclusion       *string `json:"conclusion"`
		Completeness     *string `json:"completeness"`
		CompletenessNote *string `json:"completenessNote"`
		Done             bool    `json:"done"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	// 取值校验与 PATCH /api/projects/{id} 同一口径
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
	if body.Completeness != nil && *body.Completeness != "" && !validCompleteness[*body.Completeness] {
		writeError(w, http.StatusBadRequest, "流程完整性的结论不合法")
		return
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.triage() {
			return noPermission()
		}
		if _, err := intakeContextTx(pr); err != nil {
			return err
		}
		if pms, err := memberUserIDsByRoleTx(r.Context(), tx, pr.ID, RolePM); err != nil {
			return err
		} else if len(pms) > 0 || stages[0].Status != StagePending {
			return badRequest("已经指派了 PM，初级分析不能再修改")
		}
		ctx := r.Context()
		changed := []string{}
		set := func(label, query string, args ...any) error {
			if _, err := tx.ExecContext(ctx, query, args...); err != nil {
				return err
			}
			changed = append(changed, label)
			return nil
		}
		if body.Value != nil {
			if err := set("改造价值", `UPDATE projects SET value = $2 WHERE id = $1`, pr.ID, *body.Value); err != nil {
				return err
			}
		}
		if body.Complexity != nil {
			if err := set("复杂度", `UPDATE projects SET complexity = $2 WHERE id = $1`, pr.ID, *body.Complexity); err != nil {
				return err
			}
		}
		if body.Priority != nil {
			if err := set("优先级", `UPDATE projects SET priority = $2 WHERE id = $1`, pr.ID, *body.Priority); err != nil {
				return err
			}
		}
		if body.DueDate != nil {
			if err := set("目标完成日", `UPDATE projects SET due_date = NULLIF($2,'')::date WHERE id = $1`, pr.ID, *body.DueDate); err != nil {
				return err
			}
		}
		if body.Conclusion != nil {
			// 分析结论与其他分析字段同存一个 JSON 对象,只覆盖 conclusion 一项
			one, _ := json.Marshal(map[string]string{"conclusion": trimRunes(*body.Conclusion, maxIntakeText)})
			if err := set("分析结论", `UPDATE projects SET analysis = COALESCE(analysis, '{}'::jsonb) || $2::jsonb WHERE id = $1`, pr.ID, string(one)); err != nil {
				return err
			}
		}
		if body.Completeness != nil || body.CompletenessNote != nil {
			if err := saveIntakeReviewTx(ctx, tx, pr.ID, body.Completeness, body.CompletenessNote, nil, a.ID); err != nil {
				return err
			}
			changed = append(changed, "流程是否完整")
		}
		if body.Done && pr.TriageDoneAt == nil {
			// 以落库后的值为准:这次请求可以边填边完成
			var value, complexity, conclusion string
			if err := tx.QueryRowContext(ctx, `SELECT value, complexity, COALESCE(analysis->>'conclusion','') FROM projects WHERE id = $1`, pr.ID).
				Scan(&value, &complexity, &conclusion); err != nil {
				return err
			}
			row, err := loadIntakeRowTx(ctx, tx, pr.ID)
			if err != nil {
				return err
			}
			missing := []string{}
			if !validLevel(value) {
				missing = append(missing, "改造价值")
			}
			if !validLevel(complexity) {
				missing = append(missing, "复杂度")
			}
			if !validCompleteness[row.Completeness] {
				missing = append(missing, "流程是否完整")
			}
			if strings.TrimSpace(conclusion) == "" {
				missing = append(missing, "分析结论")
			}
			if len(missing) > 0 {
				return badRequest("完成初级分析前请先填写：" + strings.Join(missing, "、"))
			}
			if _, err := tx.ExecContext(ctx, `UPDATE projects SET triage_done_at = now(), triage_by = $2 WHERE id = $1`, pr.ID, a.ID); err != nil {
				return err
			}
			changed = append(changed, "完成初级分析")
		}
		if len(changed) == 0 {
			return nil
		}
		return addEventTx(ctx, tx, pr.ID, "intake", "", a, "intake_triaged", map[string]any{
			"done": body.Done || pr.TriageDoneAt != nil, "fields": changed,
		})
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeIntake(w, r, a, pathID(r))
}

// ---- PM 的承接方案 ----

// handleIntakeSolution PUT /api/projects/{id}/intake/solution —— 承接方案:流程是否完整、综合方案总述、
// 三条推进线的原因 / 解决方案 / 负责人,以及逐节点的处理状态。只传要改的部分。
// PM、CTO、管理员能改全部;某条推进线的负责人(项目里的成员)能改自己那一条。只能在 PM 推进时修改。
func (s *postgresStore) handleIntakeSolution(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	type lineIn struct {
		Key      string  `json:"key"`
		Reason   *string `json:"reason"`
		Solution *string `json:"solution"`
		OwnerID  *string `json:"ownerId"`
	}
	type nodeIn struct {
		Key    string  `json:"key"`
		Line   string  `json:"line"`
		Status string  `json:"status"`
		Note   *string `json:"note"`
	}
	var body struct {
		Completeness     *string  `json:"completeness"`
		CompletenessNote *string  `json:"completenessNote"`
		Summary          *string  `json:"summary"`
		Lines            []lineIn `json:"lines"`
		Nodes            []nodeIn `json:"nodes"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if body.Completeness != nil && *body.Completeness != "" && !validCompleteness[*body.Completeness] {
		writeError(w, http.StatusBadRequest, "流程完整性的结论不合法")
		return
	}
	if len(body.Lines) > len(intakeLineKeys) {
		writeError(w, http.StatusBadRequest, "推进线最多 "+itoa(len(intakeLineKeys))+" 条")
		return
	}
	seenLine := map[string]bool{}
	for _, l := range body.Lines {
		if !validIntakeLines[l.Key] {
			writeError(w, http.StatusBadRequest, "推进线不合法")
			return
		}
		if seenLine[l.Key] {
			writeError(w, http.StatusBadRequest, "同一条推进线只能出现一次")
			return
		}
		seenLine[l.Key] = true
	}
	if len(body.Nodes) > maxIntakeNodes {
		writeError(w, http.StatusBadRequest, "一次最多修改 "+itoa(maxIntakeNodes)+" 个节点的处理状态")
		return
	}
	seenNode := map[string]bool{}
	for _, n := range body.Nodes {
		if !validIntakeLines[n.Line] {
			writeError(w, http.StatusBadRequest, "节点所属的推进线不合法")
			return
		}
		if !validPlanStatuses[n.Status] {
			writeError(w, http.StatusBadRequest, "节点的处理状态不合法")
			return
		}
		k := n.Line + "/" + n.Key
		if n.Key == "" || seenNode[k] {
			writeError(w, http.StatusBadRequest, "同一个节点的处理状态只能出现一次")
			return
		}
		seenNode[k] = true
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		ctx := r.Context()
		c, err := loadCaps(ctx, tx, pr.ID, a)
		if err != nil {
			return err
		}
		if _, err := intakeContextTx(pr); err != nil {
			return err
		}
		// 权限:整体字段与总述要能管理项目;推进线与节点,管理者或该线的负责人。
		// 权限校验先于状态校验——与项目里其他接口一致
		global := body.Completeness != nil || body.CompletenessNote != nil || body.Summary != nil
		lines, err := loadLinesTx(ctx, tx, pr.ID)
		if err != nil {
			return err
		}
		owns := func(line string) bool { return a.ID != "" && c.member() && lines[line].OwnerID == a.ID }
		if global && !c.manage() {
			return noPermission()
		}
		for _, l := range body.Lines {
			if !c.manage() && !owns(l.Key) {
				return noPermission()
			}
			// 推进线的负责人由 PM(或 CTO / 管理员)指定:负责人可以改自己那条的原因、方案与节点,但不能换人
			if l.OwnerID != nil && !c.manage() {
				return noPermission()
			}
		}
		for _, n := range body.Nodes {
			if !c.manage() && !owns(n.Line) {
				return noPermission()
			}
		}
		if stages[0].Status != StageInProgress {
			return conflict("承接方案只能在 PM 推进时修改；评估进行中请先撤回评审")
		}
		// 负责人必须是项目的参与成员;节点必须确实在立项时的诊断结果里(已被消除的不能再标)
		asIs, _, err := asIsStepsTx(ctx, tx, pr.ID)
		if err != nil {
			return err
		}
		diag := Diagnose(asIs)
		known := map[string]map[string]bool{}
		for _, key := range intakeLineKeys {
			known[key] = map[string]bool{}
			for _, ref := range diag.refs(key) {
				known[key][ref.Key] = true
			}
		}
		for _, n := range body.Nodes {
			if !known[n.Line][n.Key] {
				return badRequest("有节点不在「" + intakeLineTitle(n.Line) + "」的诊断结果里（可能已被消除），请刷新后重试")
			}
		}
		for _, l := range body.Lines {
			if l.OwnerID != nil && *l.OwnerID != "" {
				ok, err := isProjectMemberTx(ctx, tx, pr.ID, *l.OwnerID)
				if err != nil {
					return err
				}
				if !ok {
					return badRequest("推进线的负责人必须是项目的参与成员（PM / BH / TH）")
				}
			}
		}
		changed := []string{}
		if global {
			if err := saveIntakeReviewTx(ctx, tx, pr.ID, body.Completeness, body.CompletenessNote, body.Summary, a.ID); err != nil {
				return err
			}
			if body.Summary != nil {
				changed = append(changed, "综合方案总述")
			}
			if body.Completeness != nil || body.CompletenessNote != nil {
				changed = append(changed, "流程是否完整")
			}
		}
		for _, l := range body.Lines {
			before := lines[l.Key].OwnerID
			if err := saveLineTx(ctx, tx, pr.ID, l.Key, l.Reason, l.Solution, l.OwnerID, a.ID); err != nil {
				return err
			}
			changed = append(changed, intakeLineTitle(l.Key))
			// 换了负责人:告诉接手的人,并在动态里记一笔(自己接手的不必通知自己)
			if after := deref(l.OwnerID); after != "" && after != before && after != a.ID {
				title := intakeLineTitle(l.Key)
				var name string
				if err := tx.QueryRowContext(ctx, `SELECT COALESCE(NULLIF(display_name, ''), username) FROM users WHERE id = $1`, after).Scan(&name); err != nil {
					return err
				}
				if err := addEventTx(ctx, tx, pr.ID, "intake", "", a, "intake_line_assigned", map[string]any{
					"line": l.Key, "lineTitle": title, "user": name, "userId": after,
				}); err != nil {
					return err
				}
				if err := notifyTx(ctx, tx, after, "intake_line_assigned", pr.ID, "", "",
					"「"+pr.Name+"」的推进线「"+title+"」交给你负责", "intake_line_assigned:"+pr.ID+":"+l.Key+":"+after+":"+timeNowKey()); err != nil {
					return err
				}
			}
		}
		for _, n := range body.Nodes {
			if err := savePlanTx(ctx, tx, pr.ID, n.Line, n.Key, n.Status, n.Note, a.ID); err != nil {
				return err
			}
		}
		if len(body.Nodes) > 0 {
			changed = append(changed, "节点处理状态 ×"+itoa(len(body.Nodes)))
		}
		if len(changed) == 0 {
			return nil
		}
		return addEventTx(ctx, tx, pr.ID, "intake", "", a, "intake_solution_updated", map[string]any{"sections": changed})
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeIntake(w, r, a, pathID(r))
}

// ---- 申请 CTO 协助 ----

// handleIntakeSupport POST /api/projects/{id}/intake/cto-support —— PM 申请 CTO 协助，CTO 响应。
//
//	request  PM 发起申请(须写明需要协助的事项),通知全部 CTO
//	withdraw PM 撤回还没人响应的申请
//	join     CTO 响应,加入协助
//	release  PM 或协助中的 CTO 结束协助
func (s *postgresStore) handleIntakeSupport(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		Action string `json:"action"`
		Note   string `json:"note"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Note = trimRunes(body.Note, maxIntakeNote)
	if body.Action != "request" && body.Action != "withdraw" && body.Action != "join" && body.Action != "release" {
		writeError(w, http.StatusBadRequest, "action 不合法")
		return
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		ctx := r.Context()
		c, err := loadCaps(ctx, tx, pr.ID, a)
		if err != nil {
			return err
		}
		if _, err := intakeContextTx(pr); err != nil {
			return err
		}
		sup := parseSupport(pr.CtoSupport)
		who := sup.JoinedByName // 结束协助时,事件里要记下是谁
		now := time.Now()
		kind, text, user := "", "", ""
		switch body.Action {
		case "request":
			if !c.manage() {
				return noPermission()
			}
			if stages[0].Status != StageInProgress {
				return badRequest("只能在 PM 推进时申请 CTO 协助")
			}
			if sup.Status != SupportNone {
				return conflict("已经申请过 CTO 协助")
			}
			if body.Note == "" {
				return badRequest("申请 CTO 协助要写明需要协助的事项")
			}
			sup = CtoSupport{Status: SupportRequested, Reason: body.Note, RequestedByID: a.ID, RequestedByName: a.name(), RequestedAt: &now}
			kind, text = "cto_support_requested", "「"+pr.Name+"」申请 CTO 协助："+body.Note
		case "withdraw":
			if !c.manage() {
				return noPermission()
			}
			if sup.Status != SupportRequested {
				return conflict("没有等待响应的 CTO 协助申请")
			}
			sup = CtoSupport{Status: SupportNone}
			kind, text = "cto_support_withdrawn", "「"+pr.Name+"」撤回了 CTO 协助申请"
		case "join":
			if !c.CTO && !c.Admin {
				return noPermission()
			}
			if sup.Status != SupportRequested {
				return conflict("这个项目没有等待响应的 CTO 协助申请")
			}
			sup.Status, sup.JoinedByID, sup.JoinedByName, sup.JoinedAt = SupportJoined, a.ID, a.name(), &now
			kind, text, user = "cto_support_joined", a.name()+" 已加入「"+pr.Name+"」，协助需求承接", a.name()
		case "release":
			if !c.CTO && !c.Admin && !c.manage() {
				return noPermission()
			}
			if sup.Status != SupportJoined {
				return conflict("当前没有 CTO 在协助这个项目")
			}
			sup = CtoSupport{Status: SupportNone}
			kind, text, user = "cto_support_released", "「"+pr.Name+"」的 CTO 协助已结束", who
		}
		raw, _ := json.Marshal(sup)
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET cto_support = $2::jsonb WHERE id = $1`, pr.ID, string(raw)); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "intake", "", a, kind, map[string]any{"note": body.Note, "user": user}); err != nil {
			return err
		}
		// 申请与撤回告诉全部 CTO(系统里还没有 CTO 岗位时告诉管理员);响应与结束告诉 PM
		if kind == "cto_support_requested" || kind == "cto_support_withdrawn" {
			to, err := usersWithJobTx(ctx, tx, RoleCTO)
			if err != nil {
				return err
			}
			if len(to) == 0 {
				if to, err = usersWithRoleTx(ctx, tx, "admin"); err != nil {
					return err
				}
			}
			return notifyManyTx(ctx, tx, userIDs(to), kind, pr.ID, "", "", text, kind+":"+pr.ID+":"+timeNowKey())
		}
		pms, err := memberUserIDsByRoleTx(ctx, tx, pr.ID, RolePM)
		if err != nil {
			return err
		}
		return notifyManyTx(ctx, tx, pms, kind, pr.ID, "", "", text, kind+":"+pr.ID+":"+timeNowKey())
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeIntake(w, r, a, pathID(r))
}
