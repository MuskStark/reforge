package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

// apiError 带 HTTP 状态码的业务错误;其余错误按 500 处理
type apiError struct {
	code int
	msg  string
}

func (e *apiError) Error() string { return e.msg }

func badRequest(msg string) error { return &apiError{http.StatusBadRequest, msg} }
func conflict(msg string) error   { return &apiError{http.StatusConflict, msg} }
func notFound(msg string) error   { return &apiError{http.StatusNotFound, msg} }
func noPermission() error         { return &apiError{http.StatusForbidden, "没有执行此操作的权限"} }

// writeErr 把业务错误翻译成状态码;非业务错误只回一句通用提示,细节进日志
func writeErr(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeError(w, ae.code, ae.msg)
		return
	}
	log.Printf("[api] 内部错误: %v", err)
	writeError(w, http.StatusInternalServerError, "服务异常，请稍后重试")
}

// withProjectLock 开事务并锁定项目行:同一项目的写操作在这里串行化。
// fn 拿到的是锁后的项目与阶段现状;成功时版本号 +1。
func (s *postgresStore) withProjectLock(ctx context.Context, projectID string, fn func(tx *sql.Tx, pr *Project, stages []ProjectStage) error) error {
	return s.withTx(ctx, func(tx *sql.Tx) error {
		pr, err := getProject(ctx, tx, projectID, true)
		if err != nil {
			return err
		}
		if pr == nil {
			return notFound("项目不存在")
		}
		stages, err := stagesTx(ctx, tx, projectID)
		if err != nil {
			return err
		}
		if err := fn(tx, pr, stages); err != nil {
			return err
		}
		return touchProject(ctx, tx, projectID)
	})
}

func stagesTx(ctx context.Context, q runner, projectID string) ([]ProjectStage, error) {
	rows, err := q.QueryContext(ctx, `SELECT seq, status, entered_at, exited_at, COALESCE(due_date::text,'')
		FROM project_stages WHERE project_id = $1 ORDER BY seq`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectStage{}
	for rows.Next() {
		var st ProjectStage
		var entered, exited sql.NullTime
		if err := rows.Scan(&st.Seq, &st.Status, &entered, &exited, &st.DueDate); err != nil {
			return nil, err
		}
		st.EnteredAt, st.ExitedAt = nullTimePtr(entered), nullTimePtr(exited)
		out = append(out, st)
	}
	return out, rows.Err()
}

func setStageStatusTx(ctx context.Context, q runner, projectID string, seq int, status string) error {
	_, err := q.ExecContext(ctx, `UPDATE project_stages SET status = $3,
		entered_at = CASE WHEN $3 = 'pending' THEN NULL
			WHEN $3 IN ('in_progress','in_review') THEN COALESCE(entered_at, now()) ELSE entered_at END,
		exited_at  = CASE WHEN $3 IN ('approved','skipped') THEN COALESCE(exited_at, now()) ELSE NULL END
		WHERE project_id = $1 AND seq = $2`, projectID, seq, status)
	return err
}

// missingRequiredTx 某阶段尚未完成的必交付物标题
func missingRequiredTx(ctx context.Context, q runner, projectID string, seq int) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT title FROM work_items
		WHERE project_id = $1 AND stage_seq = $2 AND required AND status NOT IN ('done','cancelled')
		ORDER BY sort_key`, projectID, seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// handlerMembersTx 项目内的经办成员
func handlerMembersTx(ctx context.Context, q runner, projectID string) ([]*User, error) {
	rows, err := q.QueryContext(ctx, `SELECT u.id, u.username, u.password_hash, u.role, u.display_name, u.department, u.job_role, u.created_at, u.must_change_password
		FROM project_members m JOIN users u ON u.id = m.user_id
		WHERE m.project_id = $1 AND m.role = 'handler' ORDER BY u.created_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt, &u.MustChangePassword); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

// reviewersForTx 关卡的评审人:CTO 关卡 = 全部 CTO 岗位用户;经办关卡 = 项目内经办成员。
// 两者都为空时回退到系统管理员,流程不会因为缺人而卡死。
func reviewersForTx(ctx context.Context, q runner, projectID, role string) ([]*User, error) {
	var us []*User
	var err error
	if role == RoleCTO {
		us, err = usersWithJobTx(ctx, q, RoleCTO)
	} else {
		us, err = handlerMembersTx(ctx, q, projectID)
	}
	if err != nil {
		return nil, err
	}
	if len(us) > 0 {
		return us, nil
	}
	return usersWithRoleTx(ctx, q, "admin")
}

func processStepsTx(ctx context.Context, q runner, processID string) (*Process, error) {
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT steps FROM processes WHERE id = $1`, processID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, notFound("流程定义不存在")
	}
	if err != nil {
		return nil, err
	}
	p := &Process{ID: processID}
	if err := json.Unmarshal(raw, &p.Steps); err != nil {
		return nil, err
	}
	return p, nil
}

// currentStageOf 项目当前阶段的现状;阶段序号越界(数据异常)时返回 false
func currentStageOf(pr *Project, stages []ProjectStage) (ProjectStage, bool) {
	i := pr.CurrentStage - 1
	if i < 0 || i >= len(stages) {
		return ProjectStage{}, false
	}
	return stages[i], true
}

// advanceAfterApprovalTx 关卡通过:当前阶段记为通过、按需留版本快照、自动进入下一阶段
func advanceAfterApprovalTx(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, seq int, skipped bool) error {
	status := StageApproved
	if skipped {
		status = StageSkipped
	}
	if err := setStageStatusTx(ctx, tx, pr.ID, seq, status); err != nil {
		return err
	}
	if !skipped {
		if kind := pr.snapshotKind(seq); kind != "" {
			p, err := processStepsTx(ctx, tx, pr.ProcessID)
			if err != nil {
				return err
			}
			gate, _ := pr.stageAt(seq)
			note := gate.Gate + map[string]string{"to_be": "通过时的流程定义（To-Be 基线）", "published": "通过时发布的流程定义"}[kind]
			if err := snapshotVersionTx(ctx, tx, pr.ID, p, kind, note, ""); err != nil {
				return err
			}
		}
	}
	next := seq + 1
	if next > pr.stageCount() {
		return nil
	}
	// 下一阶段若已被占用(例如回退后重做),保持其现状
	nextStatus := StagePending
	if next-1 < len(stages) {
		nextStatus = stages[next-1].Status
	}
	if nextStatus == StagePending {
		if err := setStageStatusTx(ctx, tx, pr.ID, next, StageInProgress); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE projects SET current_stage = $2 WHERE id = $1`, pr.ID, next)
	return err
}

// ---- 关卡引擎 ----

// submitReviewTx 提交当前阶段的评审。调用方已持有项目行锁。
func submitReviewTx(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps, summary string) (*GateReview, error) {
	if pr.Status != ProjActive {
		return nil, badRequest("项目不在进行中，无法提交评审")
	}
	cur, ok := currentStageOf(pr, stages)
	if !ok {
		return nil, conflict("项目的阶段数据异常，请刷新后重试")
	}
	t, _ := pr.stageAt(cur.Seq)
	if !c.manage() {
		return nil, noPermission()
	}
	if t.Gate == "" {
		return nil, badRequest("「" + t.Name + "」没有评审关卡")
	}
	if cur.Status != StageInProgress {
		return nil, conflict("当前阶段不在进行中（已在评审或已通过）")
	}
	missing, err := missingRequiredTx(ctx, tx, pr.ID, cur.Seq)
	if err != nil {
		return nil, err
	}
	if len(missing) > 0 {
		return nil, badRequest("还有必交付物未完成：" + strings.Join(missing, "、"))
	}
	if cur.Seq == 1 && (pr.Value == "" || pr.Complexity == "") {
		return nil, badRequest("请先在概览里填写改造价值与复杂度")
	}
	reviewers, err := reviewersForTx(ctx, tx, pr.ID, t.ReviewerRole)
	if err != nil {
		return nil, err
	}
	if len(reviewers) == 0 {
		return nil, badRequest("找不到可以评审的人，请先在用户管理里设置 CTO 岗位")
	}

	var last int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(round), 0) FROM gate_reviews WHERE project_id = $1 AND stage_seq = $2`,
		pr.ID, cur.Seq).Scan(&last); err != nil {
		return nil, err
	}
	rv := &GateReview{ID: newID(), ProjectID: pr.ID, StageSeq: cur.Seq, Round: last + 1, Status: ReviewPending,
		Summary: strings.TrimSpace(summary), SubmittedBy: a.ID, SubmittedByName: a.name(), SubmittedAt: time.Now(),
		Mode: t.Mode, ReviewerRole: t.ReviewerRole, Reviewers: []GateReviewer{}}
	if _, err := tx.ExecContext(ctx, `INSERT INTO gate_reviews (id, project_id, stage_seq, round, status, summary, submitted_by, submitted_at)
		VALUES ($1, $2, $3, $4, 'pending', $5, NULLIF($6,''), now())`,
		rv.ID, pr.ID, cur.Seq, rv.Round, rv.Summary, a.ID); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(reviewers))
	for _, u := range reviewers {
		if _, err := tx.ExecContext(ctx, `INSERT INTO gate_reviewers (review_id, user_id, role) VALUES ($1, $2, $3)
			ON CONFLICT (review_id, user_id) DO NOTHING`, rv.ID, u.ID, t.ReviewerRole); err != nil {
			return nil, err
		}
		names = append(names, displayName(u))
		rv.Reviewers = append(rv.Reviewers, GateReviewer{UserID: u.ID, Username: u.Username, DisplayName: displayName(u), Role: t.ReviewerRole, Decision: DecisionPending})
	}
	if err := setStageStatusTx(ctx, tx, pr.ID, cur.Seq, StageInReview); err != nil {
		return nil, err
	}
	if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_submitted", map[string]any{
		"stage": cur.Seq, "stageName": t.Name, "gate": t.Gate, "round": rv.Round, "summary": rv.Summary, "reviewers": names,
	}); err != nil {
		return nil, err
	}
	if err := notifyManyTx(ctx, tx, userIDs(reviewers), "review_submitted", pr.ID, "", rv.ID,
		"「"+pr.Name+"」提交了 "+t.Gate+"，请你评审", "review:"+rv.ID); err != nil {
		return nil, err
	}
	return rv, nil
}

func userIDs(us []*User) []string {
	out := make([]string, 0, len(us))
	for _, u := range us {
		out = append(out, u.ID)
	}
	return out
}

// decideReviewTx 评审人表决。调用方已持有项目行锁。返回这一轮评审的状态。
func decideReviewTx(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, reviewID string, a *actor, c caps, decision, comment string) (string, error) {
	rv, err := scanReview(tx.QueryRowContext(ctx, `SELECT `+reviewCols+` FROM gate_reviews r
		LEFT JOIN users su ON su.id = r.submitted_by WHERE r.id = $1`, reviewID), pr.template())
	if errors.Is(err, sql.ErrNoRows) {
		return "", notFound("评审不存在")
	}
	if err != nil {
		return "", err
	}
	if rv.ProjectID != pr.ID {
		return "", notFound("评审不存在")
	}
	if pr.Status != ProjActive {
		return "", conflict("项目已结束，评审不再受理")
	}
	// 先判资格:名单里的评审人,或有这类关卡表决权的人(例如新任 CTO);引导管理员走裁决
	isListed, err := reviewHasReviewerTx(ctx, tx, reviewID, a.ID)
	if err != nil {
		return "", err
	}
	if !isListed && !c.canReview(rv.ReviewerRole) && !c.Admin {
		return "", noPermission()
	}
	if rv.Status != ReviewPending {
		return "", conflict("这一轮评审已经结束")
	}
	if decision != DecisionApprove && decision != DecisionReject {
		return "", badRequest("表决只能是 approve 或 reject")
	}
	comment = strings.TrimSpace(comment)
	if decision == DecisionReject && comment == "" {
		return "", badRequest("驳回必须填写意见")
	}
	if a.ID == "" {
		// 环境变量引导的管理员没有用户行,无法作为评审人留票:直接做出管理员裁决
		if !c.Admin {
			return "", noPermission()
		}
		if decision == DecisionReject {
			if err := finishReviewTx(ctx, tx, pr, stages, rv, ReviewRejected, a); err != nil {
				return "", err
			}
			if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_admin_decided", map[string]any{"decision": decision, "comment": comment}); err != nil {
				return "", err
			}
			return ReviewRejected, nil
		}
		// 或签:管理员一票即过;会签:其余评审人待决票全部作废,视为通过
		if err := finishReviewTx(ctx, tx, pr, stages, rv, ReviewApproved, a); err != nil {
			return "", err
		}
		if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_admin_decided", map[string]any{"decision": decision, "comment": comment}); err != nil {
			return "", err
		}
		return ReviewApproved, nil
	}

	var existing string
	err = tx.QueryRowContext(ctx, `SELECT decision FROM gate_reviewers WHERE review_id = $1 AND user_id = $2`, reviewID, a.ID).Scan(&existing)
	switch {
	case err == nil:
		if existing != DecisionPending {
			return "", conflict("你已经表决过了")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE gate_reviewers SET decision = $3, comment = $4, decided_at = now()
			WHERE review_id = $1 AND user_id = $2`, reviewID, a.ID, decision, comment); err != nil {
			return "", err
		}
	case errors.Is(err, sql.ErrNoRows):
		// 不在本轮名单里(例如新上任的 CTO):只要有该类关卡的评审权即可补票
		if !c.canReview(rv.ReviewerRole) {
			return "", noPermission()
		}
		role := rv.ReviewerRole
		if !((role == RoleCTO && c.CTO) || (role == RoleHandler && c.Handler)) {
			role = "admin"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO gate_reviewers (review_id, user_id, role, decision, comment, decided_at)
			VALUES ($1, $2, $3, $4, $5, now())`, reviewID, a.ID, role, decision, comment); err != nil {
			return "", err
		}
	default:
		return "", err
	}

	var pending, approve, reject int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE decision = 'pending'),
		count(*) FILTER (WHERE decision = 'approve'), count(*) FILTER (WHERE decision = 'reject')
		FROM gate_reviewers WHERE review_id = $1`, reviewID).Scan(&pending, &approve, &reject); err != nil {
		return "", err
	}
	t, _ := pr.stageAt(rv.StageSeq)
	if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_voted", map[string]any{
		"stage": rv.StageSeq, "stageName": t.Name, "round": rv.Round, "decision": decision, "comment": comment,
	}); err != nil {
		return "", err
	}

	// 或签:首个表决人决定,通过即过、驳回即驳回,其余待决票作废
	// 会签:任一驳回即驳回;待决票清零且无驳回才通过
	outcome := ""
	if rv.Mode == ModeAny {
		if approve > 0 {
			outcome = ReviewApproved
		} else if reject > 0 {
			outcome = ReviewRejected
		}
	} else if reject > 0 {
		outcome = ReviewRejected
	} else if pending == 0 {
		outcome = ReviewApproved
	}
	if outcome == "" {
		return ReviewPending, nil
	}
	if err := finishReviewTx(ctx, tx, pr, stages, rv, outcome, a); err != nil {
		return "", err
	}
	return outcome, nil
}

// reviewHasReviewerTx 该用户是否在本轮评审人名单里
func reviewHasReviewerTx(ctx context.Context, q runner, reviewID, userID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM gate_reviewers WHERE review_id = $1 AND user_id = $2`, reviewID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// finishReviewTx 评审定论:更新评审单与阶段,通过则进入下一阶段
func finishReviewTx(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, rv *GateReview, outcome string, a *actor) error {
	if _, err := tx.ExecContext(ctx, `UPDATE gate_reviews SET status = $2, decided_at = now() WHERE id = $1`, rv.ID, outcome); err != nil {
		return err
	}
	t, _ := pr.stageAt(rv.StageSeq)
	members, err := memberUserIDsTx(ctx, tx, pr.ID)
	if err != nil {
		return err
	}
	if outcome == ReviewApproved {
		if err := advanceAfterApprovalTx(ctx, tx, pr, stages, rv.StageSeq, false); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_approved", map[string]any{
			"stage": rv.StageSeq, "stageName": t.Name, "gate": t.Gate, "round": rv.Round,
		}); err != nil {
			return err
		}
		text := "「" + pr.Name + "」的 " + t.Gate + " 已通过"
		if n := pr.nextStageName(rv.StageSeq); n != "" {
			text += "，进入「" + n + "」"
		}
		return notifyManyTx(ctx, tx, members, "review_approved", pr.ID, "", rv.ID, text, "review_result:"+rv.ID)
	}
	if err := setStageStatusTx(ctx, tx, pr.ID, rv.StageSeq, StageInProgress); err != nil {
		return err
	}
	if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_rejected", map[string]any{
		"stage": rv.StageSeq, "stageName": t.Name, "gate": t.Gate, "round": rv.Round,
	}); err != nil {
		return err
	}
	return notifyManyTx(ctx, tx, members, "review_rejected", pr.ID, "", rv.ID,
		"「"+pr.Name+"」的 "+t.Gate+" 被驳回，退回修改", "review_result:"+rv.ID)
}

// withdrawReviewTx 提交人撤回待决评审,阶段回到进行中
func withdrawReviewTx(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, reviewID string, a *actor, c caps) error {
	rv, err := scanReview(tx.QueryRowContext(ctx, `SELECT `+reviewCols+` FROM gate_reviews r
		LEFT JOIN users su ON su.id = r.submitted_by WHERE r.id = $1`, reviewID), pr.template())
	if errors.Is(err, sql.ErrNoRows) {
		return notFound("评审不存在")
	}
	if err != nil {
		return err
	}
	if rv.ProjectID != pr.ID {
		return notFound("评审不存在")
	}
	if !c.manage() {
		return noPermission()
	}
	if rv.Status != ReviewPending {
		return conflict("只有待决的评审可以撤回")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE gate_reviews SET status = 'withdrawn', decided_at = now() WHERE id = $1`, reviewID); err != nil {
		return err
	}
	if err := setStageStatusTx(ctx, tx, pr.ID, rv.StageSeq, StageInProgress); err != nil {
		return err
	}
	t, _ := pr.stageAt(rv.StageSeq)
	if err := addEventTx(ctx, tx, pr.ID, "review", rv.ID, a, "review_withdrawn", map[string]any{
		"stage": rv.StageSeq, "stageName": t.Name, "round": rv.Round,
	}); err != nil {
		return err
	}
	ids, err := reviewerUserIDsTx(ctx, tx, rv.ID)
	if err != nil {
		return err
	}
	return notifyManyTx(ctx, tx, ids, "review_withdrawn", pr.ID, "", rv.ID,
		"「"+pr.Name+"」的 "+t.Gate+" 第 "+itoa(rv.Round)+" 轮已被撤回", "review_withdrawn:"+rv.ID)
}

// reviewerUserIDsTx 某轮评审的全部评审人
func reviewerUserIDsTx(ctx context.Context, q runner, reviewID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT user_id FROM gate_reviewers WHERE review_id = $1`, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// listReviewsTx 某项目的全部评审轮次(新到旧)
func listReviewsTx(ctx context.Context, q runner, projectID string) ([]*GateReview, error) {
	tpl, err := projectTemplateTx(ctx, q, projectID)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT `+reviewCols+` FROM gate_reviews r
		LEFT JOIN users su ON su.id = r.submitted_by
		WHERE r.project_id = $1 ORDER BY r.stage_seq DESC, r.round DESC`, projectID)
	if err != nil {
		return nil, err
	}
	// 显式空切片:没有记录时也要返回 [] 而不是 null
	out := []*GateReview{}
	ids := []string{}
	for rows.Next() {
		rv, err := scanReview(rows, tpl)
		if err != nil {
			rows.Close()
			return nil, err
		}
		rv.Reviewers = []GateReviewer{}
		out = append(out, rv)
		ids = append(ids, rv.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}
	vrows, err := q.QueryContext(ctx, `SELECT `+reviewerCols+` FROM gate_reviewers gr
		LEFT JOIN users u ON u.id = gr.user_id WHERE gr.review_id = ANY($1)
		ORDER BY gr.decided_at NULLS LAST, u.username`, ids)
	if err != nil {
		return nil, err
	}
	defer vrows.Close()
	byID := map[string]*GateReview{}
	for _, rv := range out {
		byID[rv.ID] = rv
	}
	for vrows.Next() {
		var rid string
		var g GateReviewer
		var dn string
		var decided sql.NullTime
		if err := vrows.Scan(&rid, &g.UserID, &g.Username, &dn, &g.Role, &g.Decision, &g.Comment, &decided); err != nil {
			return nil, err
		}
		g.DisplayName, g.DecidedAt = displayNameOr(dn, g.Username), nullTimePtr(decided)
		if rv := byID[rid]; rv != nil {
			rv.Reviewers = append(rv.Reviewers, g)
		}
	}
	return out, vrows.Err()
}

// pendingReviewView 待我评审列表里的一行
type pendingReviewView struct {
	*GateReview
	ProjectName string `json:"projectName"`
	Priority    string `json:"priority"`
	WaitingDays int    `json:"waitingDays"`
	MyDecision  string `json:"myDecision"`
}

// myPendingReviews 我还能表决的待决评审
func myPendingReviews(ctx context.Context, s *postgresStore, a *actor) ([]*pendingReviewView, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+reviewCols+`, pr.name, pr.priority, pr.template
		FROM gate_reviews r
		JOIN projects pr ON pr.id = r.project_id
		LEFT JOIN users su ON su.id = r.submitted_by
		WHERE r.status = 'pending' AND pr.status = 'active'
		ORDER BY r.stage_seq DESC, r.round DESC, r.submitted_at ASC`)
	if err != nil {
		return nil, err
	}
	type loaded struct {
		rv          *GateReview
		projectName string
		priority    string
	}
	var all []loaded
	for rows.Next() {
		rv := &GateReview{Reviewers: []GateReviewer{}}
		var subName string
		var decided sql.NullTime
		var tplRaw []byte
		var x loaded
		if err := rows.Scan(&rv.ID, &rv.ProjectID, &rv.StageSeq, &rv.Round, &rv.Status, &rv.Summary,
			&rv.SubmittedBy, &subName, &rv.SubmittedAt, &decided, &x.projectName, &x.priority, &tplRaw); err != nil {
			rows.Close()
			return nil, err
		}
		rv.SubmittedByName, rv.DecidedAt = subName, nullTimePtr(decided)
		if t, ok := templateAt(parseTemplate(tplRaw), rv.StageSeq); ok {
			rv.Mode, rv.ReviewerRole = t.Mode, t.ReviewerRole
		}
		x.rv = rv
		all = append(all, x)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	filtered := []*pendingReviewView{}
	for _, x := range all {
		c, err := loadCaps(ctx, s.db, x.rv.ProjectID, a)
		if err != nil {
			return nil, err
		}
		if !c.canReview(x.rv.ReviewerRole) {
			continue
		}
		var mine sql.NullString
		_ = s.db.QueryRowContext(ctx, `SELECT decision FROM gate_reviewers WHERE review_id = $1 AND user_id = $2`, x.rv.ID, a.ID).Scan(&mine)
		if mine.Valid && mine.String != DecisionPending {
			continue // 我已投票,等其他人
		}
		filtered = append(filtered, &pendingReviewView{
			GateReview: x.rv, ProjectName: x.projectName, Priority: x.priority, MyDecision: DecisionPending,
			WaitingDays: int(time.Since(x.rv.SubmittedAt).Hours() / 24),
		})
	}
	return filtered, nil
}
