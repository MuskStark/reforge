package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

// 需求承接里与评审相关的接口:技术点、评审人对技术点的结论、PMO 终审。
// 提交评估复用关卡引擎的 POST /api/projects/{id}/reviews;表决复用 POST /api/reviews/{id}/decide,
// 请求体里可以同时带上各技术点的结论(见 reviews_http.go)。

// pointEditableTx 技术点只能由项目管理者在 PM 推进时增删改:评估进行中改了,评审人的结论就对不上了。
// 返回项目当前的技术点数。
func pointEditableTx(ctx context.Context, q runner, pr *Project, stages []ProjectStage, c caps) (int, error) {
	if !c.manage() {
		return 0, noPermission()
	}
	if _, err := intakeContextTx(pr); err != nil {
		return 0, err
	}
	if stages[0].Status != StageInProgress {
		return 0, conflict("评估进行中不能改动技术点；需要调整请先撤回评审")
	}
	n := 0
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM intake_points WHERE project_id = $1`, pr.ID).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// pointInput 技术点的字段。PATCH 时没传的字段为 nil(保持不变)
type pointInput struct {
	Title *string
	Line  *string
	Note  *string
}

func decodePoint(w http.ResponseWriter, r *http.Request) (pointInput, bool) {
	var body struct {
		Title *string `json:"title"`
		Line  *string `json:"line"`
		Note  *string `json:"note"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return pointInput{}, false
	}
	in := pointInput{Title: body.Title, Line: body.Line, Note: body.Note}
	if in.Title != nil {
		t := trimRunes(*in.Title, 200)
		if t == "" {
			writeError(w, http.StatusBadRequest, "技术点名称不能为空")
			return pointInput{}, false
		}
		in.Title = &t
	}
	if in.Line != nil {
		l := strings.TrimSpace(*in.Line)
		if l != "" && !validIntakeLines[l] {
			writeError(w, http.StatusBadRequest, "技术点归属的推进线不合法")
			return pointInput{}, false
		}
		in.Line = &l
	}
	if in.Note != nil {
		n := trimRunes(*in.Note, maxIntakeNote)
		in.Note = &n
	}
	return in, true
}

func (s *postgresStore) handleCreatePoint(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	in, ok := decodePoint(w, r)
	if !ok || in.Title == nil {
		if ok {
			writeError(w, http.StatusBadRequest, "技术点名称不能为空")
		}
		return
	}
	line, note := "", ""
	if in.Line != nil {
		line = *in.Line
	}
	if in.Note != nil {
		note = *in.Note
	}
	var created *IntakePoint
	if !s.inProjectLock(w, r, pathID(r), func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		n, err := pointEditableTx(ctx, tx, pr, stages, c)
		if err != nil {
			return err
		}
		if n >= maxIntakePoints {
			return badRequest("技术点最多 " + itoa(maxIntakePoints) + " 个")
		}
		id := newID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO intake_points (id, project_id, line_key, title, note, sort_key, created_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`, id, pr.ID, line, *in.Title, note, n+1, a.ID); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "intake", id, a, "intake_point_added", map[string]any{"title": *in.Title, "line": line}); err != nil {
			return err
		}
		pt, err := scanPoint(tx.QueryRowContext(ctx, `SELECT `+pointCols+` FROM intake_points WHERE id = $1`, id))
		if err != nil {
			return err
		}
		pt.CreatedByName = a.name()
		created = pt
		return nil
	}) {
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// projectOfPoint 某个技术点所属的项目
func (s *postgresStore) projectOfPoint(w http.ResponseWriter, r *http.Request) (string, bool) {
	var id string
	err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM intake_points WHERE id = $1`, pathID(r)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "技术点不存在")
		return "", false
	}
	if err != nil {
		writeErr(w, r, err)
		return "", false
	}
	return id, true
}

func (s *postgresStore) handlePatchPoint(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	in, ok := decodePoint(w, r)
	if !ok {
		return
	}
	projectID, ok := s.projectOfPoint(w, r)
	if !ok {
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		if _, err := pointEditableTx(ctx, tx, pr, stages, c); err != nil {
			return err
		}
		var title string
		if err := tx.QueryRowContext(ctx, `SELECT title FROM intake_points WHERE id = $1 AND project_id = $2`, pathID(r), pr.ID).Scan(&title); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return notFound("技术点不存在")
			}
			return err
		}
		// 没传的字段保持不变
		if _, err := tx.ExecContext(ctx, `UPDATE intake_points SET
			title = COALESCE($2, title), line_key = COALESCE($3, line_key), note = COALESCE($4, note), updated_at = now()
			WHERE id = $1`, pathID(r), in.Title, in.Line, in.Note); err != nil {
			return err
		}
		if in.Title != nil {
			title = *in.Title
		}
		return addEventTx(ctx, tx, pr.ID, "intake", pathID(r), a, "intake_point_updated", map[string]any{"title": title})
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *postgresStore) handleDeletePoint(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	projectID, ok := s.projectOfPoint(w, r)
	if !ok {
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		if _, err := pointEditableTx(ctx, tx, pr, stages, c); err != nil {
			return err
		}
		var title string
		if err := tx.QueryRowContext(ctx, `SELECT title FROM intake_points WHERE id = $1 AND project_id = $2`, pathID(r), pr.ID).Scan(&title); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return notFound("技术点不存在")
			}
			return err
		}
		// 它在历次评审里的结论随它一起删(外键级联)
		if _, err := tx.ExecContext(ctx, `DELETE FROM intake_points WHERE id = $1`, pathID(r)); err != nil {
			return err
		}
		return addEventTx(ctx, tx, pr.ID, "intake", pathID(r), a, "intake_point_deleted", map[string]any{"title": title})
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// ---- 评审人对技术点的结论 ----

// assessmentInput 评审人对一个技术点的结论
type assessmentInput struct {
	PointID string `json:"pointId"`
	Verdict string `json:"verdict"`
	Note    string `json:"note"`
}

// reviewAccessTx 能否对这一轮评审表态(表决或给技术点下结论):本轮名单里的评审人,
// 或有这类关卡评审权的人(例如新上任的 CTO),或管理员。
// 与项目里其他接口一样,权限校验先于状态校验——无权的人拿不到评审的状态与技术点的内容。
func reviewAccessTx(ctx context.Context, q runner, pr *Project, reviewID string, a *actor, c caps) (*GateReview, error) {
	rv, err := loadReviewTx(ctx, q, pr, reviewID)
	if err != nil {
		return nil, err
	}
	listed := false
	if a.ID != "" {
		if listed, err = reviewHasReviewerTx(ctx, q, reviewID, a.ID); err != nil {
			return nil, err
		}
	}
	if !listed && !c.Admin && !c.canReview(rv.ReviewerRole) {
		return nil, noPermission()
	}
	return rv, nil
}

// saveAssessmentsTx 保存评审人对各技术点的结论(表决之前可以分次保存)。调用方已持有项目行锁。
// 每一轮评审、每位评审人各一份;只对承接阶段的技术可行性评估有意义。
func saveAssessmentsTx(ctx context.Context, tx *sql.Tx, pr *Project, rv *GateReview, a *actor, c caps, points []assessmentInput) error {
	if len(points) == 0 {
		return nil
	}
	if len(points) > maxIntakePoints {
		return badRequest("一次最多给出 " + itoa(maxIntakePoints) + " 个技术点的结论")
	}
	if _, err := reviewAccessTx(ctx, tx, pr, rv.ID, a, c); err != nil {
		return err
	}
	st, ok := pr.intakeStage()
	if !ok || st.Seq != rv.StageSeq {
		return badRequest("只有技术可行性评估可以给技术点下结论")
	}
	if pr.Status != ProjActive {
		return conflict("项目已结束，评估不再受理")
	}
	if rv.Status != ReviewPending {
		return conflict("这一轮评估已经结束")
	}
	if a.ID == "" {
		return badRequest("由服务器环境变量管理的管理员不能评估技术点，请用系统里的管理员账号")
	}
	for _, in := range points {
		if !validVerdicts[in.Verdict] {
			return badRequest("技术点的结论只能是可行、有条件可行或不可行")
		}
		var one int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM intake_points WHERE id = $1 AND project_id = $2`, in.PointID, pr.ID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return badRequest("有技术点不存在或已被删除，请刷新后重试")
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO intake_assessments (review_id, point_id, user_id, verdict, note, decided_at)
			VALUES ($1, $2, $3, $4, $5, now())
			ON CONFLICT (review_id, point_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict, note = EXCLUDED.note, decided_at = now()`,
			rv.ID, in.PointID, a.ID, in.Verdict, trimRunes(in.Note, maxIntakeNote)); err != nil {
			return err
		}
	}
	return addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "intake_assessed", map[string]any{
		"count": len(points), "round": rv.Round,
	})
}

// assessmentProblemTx 通过之前核对这位评审人的结论是否齐备:每个技术点都要有结论;
// 附条件的要写明条件,不可行的要给出替代方案。返回第一处问题(空串 = 没有问题)。
func assessmentProblemTx(ctx context.Context, q runner, projectID, reviewID, userID string) (string, error) {
	rows, err := q.QueryContext(ctx, `SELECT p.title, COALESCE(a.verdict, ''), COALESCE(a.note, '') FROM intake_points p
		LEFT JOIN intake_assessments a ON a.point_id = p.id AND a.review_id = $2 AND a.user_id = $3
		WHERE p.project_id = $1 ORDER BY p.sort_key, p.created_at, p.id`, projectID, reviewID, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var title, verdict, note string
		if err := rows.Scan(&title, &verdict, &note); err != nil {
			return "", err
		}
		if verdict == "" {
			return "「" + title + "」还没有结论", nil
		}
		if p := verdictProblem(verdict, note); p != "" {
			return "「" + title + "」" + p, nil
		}
	}
	return "", rows.Err()
}

// loadReviewTx 读一轮评审并确认它属于这个项目
func loadReviewTx(ctx context.Context, q runner, pr *Project, reviewID string) (*GateReview, error) {
	rv, err := scanReview(q.QueryRowContext(ctx, `SELECT `+reviewCols+` FROM gate_reviews r
		LEFT JOIN users su ON su.id = r.submitted_by WHERE r.id = $1`, reviewID), pr.template())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("评审不存在")
	}
	if err != nil {
		return nil, err
	}
	if rv.ProjectID != pr.ID {
		return nil, notFound("评审不存在")
	}
	return rv, nil
}

// handleSaveAssessment PUT /api/reviews/{id}/assessment —— 评审人先保存对各技术点的结论,最后再表决
func (s *postgresStore) handleSaveAssessment(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	var body struct {
		Points []assessmentInput `json:"points"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	projectID, ok := s.projectOfReview(w, r)
	if !ok {
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		rv, err := loadReviewTx(ctx, tx, pr, pathID(r))
		if err != nil {
			return err
		}
		return saveAssessmentsTx(ctx, tx, pr, rv, a, c, body.Points)
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// satisfyRequiredTx 承接阶段提交评估时,把模板里配置的必交付物(如「分析报告」)记为已完成:
// 它们已经由结构化的承接方案满足,不必再手工勾一遍。每条留一条事件。
func satisfyRequiredTx(ctx context.Context, q runner, projectID string, seq int, a *actor) error {
	rows, err := q.QueryContext(ctx, `SELECT id, title, status FROM work_items
		WHERE project_id = $1 AND stage_seq = $2 AND required AND status NOT IN ('done','cancelled') ORDER BY sort_key`, projectID, seq)
	if err != nil {
		return err
	}
	type pending struct{ id, title, status string }
	list := []pending{}
	for rows.Next() {
		var it pending
		if err := rows.Scan(&it.id, &it.title, &it.status); err != nil {
			rows.Close()
			return err
		}
		list = append(list, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, it := range list {
		if _, err := q.ExecContext(ctx, `UPDATE work_items SET status = 'done', done_at = now(), updated_at = now() WHERE id = $1`, it.id); err != nil {
			return err
		}
		if err := addEventTx(ctx, q, projectID, "item", it.id, a, "item_status", map[string]any{
			"title": it.title, "from": it.status, "to": ItemDone, "reason": "需求承接方案已提交技术可行性评估",
		}); err != nil {
			return err
		}
	}
	return nil
}

// awaitFinalTx 需求承接:技术可行性评估通过后不直接进入下一阶段,等 PMO 终审(见 handleIntakeFinal)。
// 阶段保持在评审中,项目记上「等终审」;全体成员知道评估已通过,PMO 收到终审待办。
func awaitFinalTx(ctx context.Context, tx *sql.Tx, pr *Project, st StageTemplate, rv *GateReview, a *actor, members []string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET final_status = $2, final_review_id = $3 WHERE id = $1`, pr.ID, FinalPending, rv.ID); err != nil {
		return err
	}
	conclusion, err := roundConclusionTx(ctx, tx, rv.ID)
	if err != nil {
		return err
	}
	if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_approved", map[string]any{
		"stage": rv.StageSeq, "stageName": st.Name, "gate": st.Gate, "round": rv.Round, "awaitingFinal": true, "conclusion": conclusion,
	}); err != nil {
		return err
	}
	if err := notifyManyTx(ctx, tx, members, "review_approved", pr.ID, "", rv.ID,
		"「"+pr.Name+"」的技术可行性评估已通过，等待 PMO 终审", "review_result:"+rv.ID); err != nil {
		return err
	}
	pmos, err := usersWithJobTx(ctx, tx, RoleViewer)
	if err != nil {
		return err
	}
	// 系统里还没有 PMO 岗位时由管理员兜底;管理员始终知会
	admins, err := usersWithRoleTx(ctx, tx, "admin")
	if err != nil {
		return err
	}
	return notifyManyTx(ctx, tx, uniq(append(userIDs(pmos), userIDs(admins)...)), "intake_final_pending", pr.ID, "", rv.ID,
		"「"+pr.Name+"」的技术可行性评估已通过，请你终审", "intake_final_pending:"+rv.ID)
}

// roundConclusionTx 这一轮评估的总体结论:全部可行 = 通过;有附条件或不可行(已给替代方案)= 有条件通过
func roundConclusionTx(ctx context.Context, q runner, reviewID string) (string, error) {
	var withConditions int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM intake_assessments
		WHERE review_id = $1 AND verdict <> $2`, reviewID, VerdictFeasible).Scan(&withConditions); err != nil {
		return "", err
	}
	if withConditions > 0 {
		return "conditional", nil
	}
	return "pass", nil
}

// ---- PMO 终审 ----

// handleIntakeFinal POST /api/projects/{id}/intake/final —— PMO 终审:整体流程 + 承接方案 + CTO 的技术可行性评估。
//
//	passed             通过归档:承接阶段通过,进入下一阶段
//	passed_with_notes  有保留通过:同上,保留意见与附带的条件随方案留档
//	returned           退回整改:回到 PM 推进,PM 调整后重新提交评估
func (s *postgresStore) handleIntakeFinal(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		Decision string `json:"decision"`
		Note     string `json:"note"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Note = trimRunes(body.Note, maxIntakeNote)
	if !validFinalDecisions[body.Decision] {
		writeError(w, http.StatusBadRequest, "终审结论不合法")
		return
	}
	// 退回要写明原因与整改要求;有保留通过要写明保留意见
	if body.Note == "" && body.Decision != FinalPassed {
		what := "退回整改必须写明原因与整改要求"
		if body.Decision == FinalPassedNotes {
			what = "有保留通过必须写明保留意见"
		}
		writeError(w, http.StatusBadRequest, what)
		return
	}
	err := s.withProjectLock(r.Context(), pathID(r), func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		ctx := r.Context()
		c, err := loadCaps(ctx, tx, pr.ID, a)
		if err != nil {
			return err
		}
		if !c.finalReview() {
			return noPermission()
		}
		st, err := intakeContextTx(pr)
		if err != nil {
			return err
		}
		if pr.FinalStatus != FinalPending || pr.FinalReviewID == "" {
			return conflict("当前没有等你终审的技术可行性评估")
		}
		rv, err := loadReviewTx(ctx, tx, pr, pr.FinalReviewID)
		if err != nil {
			return err
		}
		finalID := newID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO intake_finals (id, project_id, review_id, round, decision, note, decided_by, decided_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, now())`, finalID, pr.ID, rv.ID, rv.Round, body.Decision, body.Note, a.ID); err != nil {
			return err
		}
		// 无论通过还是退回,这一轮都不再等终审
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET final_status = '', final_review_id = '' WHERE id = $1`, pr.ID); err != nil {
			return err
		}
		audience, err := memberUserIDsTx(ctx, tx, pr.ID)
		if err != nil {
			return err
		}
		if ctos, err := usersWithJobTx(ctx, tx, RoleCTO); err != nil {
			return err
		} else {
			audience = append(audience, userIDs(ctos)...)
		}
		detail := map[string]any{"stage": st.Seq, "stageName": st.Name, "gate": st.Gate, "round": rv.Round,
			"decision": body.Decision, "note": body.Note, "reviewId": rv.ID}
		if body.Decision == FinalReturned {
			if err := setStageStatusTx(ctx, tx, pr.ID, st.Seq, StageInProgress); err != nil {
				return err
			}
			if err := addEventTx(ctx, tx, pr.ID, "intake", finalID, a, "intake_final_returned", detail); err != nil {
				return err
			}
			return notifyManyTx(ctx, tx, uniq(audience), "intake_final_returned", pr.ID, "", "",
				"「"+pr.Name+"」被 PMO 退回整改："+body.Note, "intake_final_returned:"+finalID)
		}
		// 通过:承接阶段记为通过并进入下一阶段,与普通关卡通过走同一条路
		if err := advanceAfterApprovalTx(ctx, tx, pr, stages, st.Seq, false); err != nil {
			return err
		}
		// 记下承接完成的时间:之后判断「这个项目有没有走完过承接」只看它(见 intakeLegacy)
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET intake_passed_at = now() WHERE id = $1`, pr.ID); err != nil {
			return err
		}
		// 协助只为这一段而设:承接完成后,还在等待响应或正在进行 CTO 协助一并结束
		if sup := parseSupport(pr.CtoSupport); sup.Status != SupportNone {
			if _, err := tx.ExecContext(ctx, `UPDATE projects SET cto_support = '{"status":"none"}'::jsonb WHERE id = $1`, pr.ID); err != nil {
				return err
			}
			if err := addEventTx(ctx, tx, pr.ID, "intake", "", a, "cto_support_released", map[string]any{
				"user": sup.JoinedByName, "note": "承接完成，协助自动结束",
			}); err != nil {
				return err
			}
		}
		if err := addEventTx(ctx, tx, pr.ID, "intake", finalID, a, "intake_final_passed", detail); err != nil {
			return err
		}
		text := "「" + pr.Name + "」通过 PMO 终审"
		if body.Decision == FinalPassedNotes {
			text += "（有保留通过）"
		}
		if n := pr.nextStageName(st.Seq); n != "" {
			text += "，进入「" + n + "」"
		}
		return notifyManyTx(ctx, tx, uniq(audience), "intake_final_passed", pr.ID, "", "", text, "intake_final_passed:"+finalID)
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	s.writeIntake(w, r, a, pathID(r))
}

// uniq 去重,保持原顺序
func uniq(ids []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// finalLabel 终审结论的中文名(界面、导出与提示共用)
func finalLabel(decision string) string {
	switch decision {
	case FinalPassed:
		return "通过归档"
	case FinalPassedNotes:
		return "有保留通过"
	case FinalReturned:
		return "退回整改"
	}
	return decision
}

// verdictLabel 技术点结论的中文名
func verdictLabel(verdict string) string {
	switch verdict {
	case VerdictFeasible:
		return "可行"
	case VerdictConditional:
		return "有条件可行"
	case VerdictInfeasible:
		return "不可行"
	}
	return verdict
}

// phaseLabel 承接环节的中文名
func phaseLabel(phase string) string {
	switch phase {
	case PhaseTriage:
		return "待 PMO 初级分析"
	case PhaseAssign:
		return "待指派 PM"
	case PhaseAdvance:
		return "PM 推进中"
	case PhaseAssess:
		return "CTO 评估中"
	case PhaseFinal:
		return "待 PMO 终审"
	case PhaseDone:
		return "承接完成"
	}
	return phase
}
