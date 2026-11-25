package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// intakeSchema 需求承接的表结构(幂等)。承接方案不放进 projects 的大字段,而是按粒度拆开:
// 整体把关与总述一行、三条推进线各一行、逐节点的处理状态、技术点及其评估结论、终审的历次结论。
// 关联到项目的表都带 ON DELETE CASCADE,删除流程时随项目一起清掉。
const intakeSchema = `
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lead_pm_id      TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS triage_done_at  TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS triage_by        TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS final_status    TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS final_review_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cto_support     JSONB NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS intake_passed_at TIMESTAMPTZ;   -- PMO 终审通过、承接完成的时间;为空说明没走完过承接

CREATE TABLE IF NOT EXISTS intake_reviews (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  completeness      TEXT NOT NULL DEFAULT '',   -- complete | gaps:流程是否完整
  completeness_note TEXT NOT NULL DEFAULT '',
  summary           TEXT NOT NULL DEFAULT '',   -- 综合方案总述
  updated_by        TEXT NOT NULL DEFAULT '',
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS intake_lines (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL,                     -- offline | interop | mobile
  reason     TEXT NOT NULL DEFAULT '',          -- 原因
  solution   TEXT NOT NULL DEFAULT '',          -- 解决方案
  owner_id   TEXT NOT NULL DEFAULT '',          -- 负责人(项目成员)
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, line_key)
);

CREATE TABLE IF NOT EXISTS intake_node_plans (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL,
  node_key   TEXT NOT NULL,                     -- 见 NodeRef.Key
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | planned | na
  note       TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, line_key, node_key)
);

CREATE TABLE IF NOT EXISTS intake_points (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  line_key   TEXT NOT NULL DEFAULT '',          -- 归属的推进线
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  sort_key   BIGINT NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intake_points_project ON intake_points (project_id, sort_key);

-- 评审人对技术点的结论:每一轮评审、每位评审人各一份,退回重提后另起一轮,历史保留
CREATE TABLE IF NOT EXISTS intake_assessments (
  review_id  TEXT NOT NULL REFERENCES gate_reviews(id) ON DELETE CASCADE,
  point_id   TEXT NOT NULL REFERENCES intake_points(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  verdict    TEXT NOT NULL,                     -- feasible | conditional | infeasible
  note       TEXT NOT NULL DEFAULT '',          -- 条件,或不可行时的替代方案
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (review_id, point_id, user_id)
);

CREATE TABLE IF NOT EXISTS intake_finals (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_id  TEXT NOT NULL DEFAULT '',          -- 终审对象:哪一轮技术可行性评估
  round      SMALLINT NOT NULL DEFAULT 0,
  decision   TEXT NOT NULL,                     -- passed | passed_with_notes | returned
  note       TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intake_finals_project ON intake_finals (project_id, decided_at DESC);`

// ---- 立项时的流程定义(自动诊断的基准) ----

// asIsStepsTx 立项时留存的流程定义(As-Is 快照)的步骤;没有快照时 ok 为 false
func asIsStepsTx(ctx context.Context, q runner, projectID string) ([]Step, bool, error) {
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT steps FROM process_versions
		WHERE project_id = $1 AND kind = 'as_is' ORDER BY version ASC LIMIT 1`, projectID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var steps []Step
	if err := json.Unmarshal(raw, &steps); err != nil {
		return nil, false, err
	}
	return steps, true, nil
}

// asIsStepsOf 一组项目各自的 As-Is 步骤(批量读取,按版本号取最早的一个)
func asIsStepsOf(ctx context.Context, q runner, projectIDs []string) (map[string][]Step, error) {
	out := map[string][]Step{}
	if len(projectIDs) == 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT ON (project_id) project_id, steps FROM process_versions
		WHERE project_id = ANY($1) AND kind = 'as_is' ORDER BY project_id, version ASC`, projectIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pid string
		var raw []byte
		if err := rows.Scan(&pid, &raw); err != nil {
			return nil, err
		}
		var steps []Step
		if err := json.Unmarshal(raw, &steps); err != nil {
			return nil, err
		}
		out[pid] = steps
	}
	return out, rows.Err()
}

// ---- 读取 ----

// intakeRow 承接的整体把关与总述(每个项目最多一行)
type intakeRow struct {
	Completeness     string
	CompletenessNote string
	Summary          string
	UpdatedBy        string
	UpdatedAt        *time.Time
}

func loadIntakeRowTx(ctx context.Context, q runner, projectID string) (intakeRow, error) {
	var row intakeRow
	var updated sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT completeness, completeness_note, summary, updated_by, updated_at
		FROM intake_reviews WHERE project_id = $1`, projectID).Scan(&row.Completeness, &row.CompletenessNote, &row.Summary, &row.UpdatedBy, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return intakeRow{}, nil
	}
	row.UpdatedAt = nullTimePtr(updated)
	return row, err
}

// lineRow 一条推进线的原因、方案与负责人
type lineRow struct {
	Reason    string
	Solution  string
	OwnerID   string
	UpdatedBy string
	UpdatedAt *time.Time
}

func loadLinesTx(ctx context.Context, q runner, projectID string) (map[string]lineRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT line_key, reason, solution, owner_id, updated_by, updated_at
		FROM intake_lines WHERE project_id = $1`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]lineRow{}
	for rows.Next() {
		var key string
		var lr lineRow
		var updated sql.NullTime
		if err := rows.Scan(&key, &lr.Reason, &lr.Solution, &lr.OwnerID, &lr.UpdatedBy, &updated); err != nil {
			return nil, err
		}
		lr.UpdatedAt = nullTimePtr(updated)
		out[key] = lr
	}
	return out, rows.Err()
}

// planRow 一个节点在一条推进线里的处理状态
type planRow struct {
	Status    string
	Note      string
	UpdatedBy string
	UpdatedAt *time.Time
}

func loadPlansTx(ctx context.Context, q runner, projectID string) (map[string]map[string]planRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT line_key, node_key, status, note, updated_by, updated_at
		FROM intake_node_plans WHERE project_id = $1`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]planRow{}
	for rows.Next() {
		var line, key string
		var pr planRow
		var updated sql.NullTime
		if err := rows.Scan(&line, &key, &pr.Status, &pr.Note, &pr.UpdatedBy, &updated); err != nil {
			return nil, err
		}
		pr.UpdatedAt = nullTimePtr(updated)
		if out[line] == nil {
			out[line] = map[string]planRow{}
		}
		out[line][key] = pr
	}
	return out, rows.Err()
}

const pointCols = `id, line_key, title, note, created_by, created_at, updated_at`

func scanPoint(sc scanner) (*IntakePoint, error) {
	var pt IntakePoint
	if err := sc.Scan(&pt.ID, &pt.Line, &pt.Title, &pt.Note, &pt.CreatedBy, &pt.CreatedAt, &pt.UpdatedAt); err != nil {
		return nil, err
	}
	pt.Assessments = []IntakeAssessment{}
	return &pt, nil
}

// loadPointsTx 项目的全部技术点(按录入顺序)
func loadPointsTx(ctx context.Context, q runner, projectID string) ([]*IntakePoint, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+pointCols+` FROM intake_points WHERE project_id = $1
		ORDER BY sort_key, created_at, id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*IntakePoint{}
	for rows.Next() {
		pt, err := scanPoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pt)
	}
	return out, rows.Err()
}

// loadAssessmentsTx 某一轮评审里各评审人对技术点的结论,按技术点归并
func loadAssessmentsTx(ctx context.Context, q runner, reviewID string) (map[string][]IntakeAssessment, error) {
	out := map[string][]IntakeAssessment{}
	if reviewID == "" {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT a.point_id, a.user_id, COALESCE(NULLIF(u.display_name, ''), u.username, ''), a.verdict, a.note, a.decided_at
		FROM intake_assessments a LEFT JOIN users u ON u.id = a.user_id
		WHERE a.review_id = $1 ORDER BY a.point_id, a.decided_at`, reviewID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pointID string
		var as IntakeAssessment
		if err := rows.Scan(&pointID, &as.UserID, &as.UserName, &as.Verdict, &as.Note, &as.DecidedAt); err != nil {
			return nil, err
		}
		out[pointID] = append(out[pointID], as)
	}
	return out, rows.Err()
}

// loadFinalsTx PMO 终审的历次结论(新到旧)
func loadFinalsTx(ctx context.Context, q runner, projectID string) ([]*IntakeFinal, error) {
	rows, err := q.QueryContext(ctx, `SELECT f.id, f.review_id, f.round, f.decision, f.note,
		COALESCE(NULLIF(u.display_name, ''), u.username, ''), f.decided_at
		FROM intake_finals f LEFT JOIN users u ON u.id = f.decided_by
		WHERE f.project_id = $1 ORDER BY f.decided_at DESC, f.id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*IntakeFinal{}
	for rows.Next() {
		var f IntakeFinal
		if err := rows.Scan(&f.ID, &f.ReviewID, &f.Round, &f.Decision, &f.Note, &f.DecidedByName, &f.DecidedAt); err != nil {
			return nil, err
		}
		out = append(out, &f)
	}
	return out, rows.Err()
}

// ---- 写入(事务内调用;传 nil 的字段保持不变) ----

func saveIntakeReviewTx(ctx context.Context, q runner, projectID string, completeness, completenessNote, summary *string, by string) error {
	if _, err := q.ExecContext(ctx, `INSERT INTO intake_reviews (project_id, updated_by, updated_at)
		VALUES ($1, $2, now()) ON CONFLICT (project_id) DO NOTHING`, projectID, by); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE intake_reviews SET
		completeness      = COALESCE($2, completeness),
		completeness_note = COALESCE($3, completeness_note),
		summary           = COALESCE($4, summary),
		updated_by = $5, updated_at = now()
		WHERE project_id = $1`, projectID, completeness, completenessNote, summary, by)
	return err
}

func saveLineTx(ctx context.Context, q runner, projectID, line string, reason, solution, ownerID *string, by string) error {
	if _, err := q.ExecContext(ctx, `INSERT INTO intake_lines (project_id, line_key, updated_by, updated_at)
		VALUES ($1, $2, $3, now()) ON CONFLICT (project_id, line_key) DO NOTHING`, projectID, line, by); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE intake_lines SET
		reason     = COALESCE($3, reason),
		solution   = COALESCE($4, solution),
		owner_id   = COALESCE($5, owner_id),
		updated_by = $6, updated_at = now()
		WHERE project_id = $1 AND line_key = $2`, projectID, line, reason, solution, ownerID, by)
	return err
}

func savePlanTx(ctx context.Context, q runner, projectID, line, nodeKey, status string, note *string, by string) error {
	if _, err := q.ExecContext(ctx, `INSERT INTO intake_node_plans (project_id, line_key, node_key, status, updated_by, updated_at)
		VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (project_id, line_key, node_key) DO NOTHING`,
		projectID, line, nodeKey, status, by); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `UPDATE intake_node_plans SET status = $4, note = COALESCE($5, note),
		updated_by = $6, updated_at = now() WHERE project_id = $1 AND line_key = $2 AND node_key = $3`,
		projectID, line, nodeKey, status, note, by)
	return err
}

// isProjectMemberTx 这个人是不是项目的参与成员(PM / BH / TH;只读的 PMO 成员不算)
func isProjectMemberTx(ctx context.Context, q runner, projectID, userID string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> $3`,
		projectID, userID, RoleViewer).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// syncLeadTx 维护主负责 PM:显式指定的仍在 PM 名单里就保持;否则取最早到岗的 PM;没有 PM 则清空。
// 返回当前的主负责 PM。
func syncLeadTx(ctx context.Context, q runner, projectID string) (string, error) {
	var cur, first string
	if err := q.QueryRowContext(ctx, `SELECT lead_pm_id FROM projects WHERE id = $1`, projectID).Scan(&cur); err != nil {
		return "", err
	}
	err := q.QueryRowContext(ctx, `SELECT user_id FROM project_members WHERE project_id = $1 AND role = $2
		ORDER BY created_at, user_id LIMIT 1`, projectID, RolePM).Scan(&first)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if first == "" {
		if cur == "" {
			return "", nil
		}
		first = ""
	} else if cur != "" {
		var one int
		err := q.QueryRowContext(ctx, `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = $3`,
			projectID, cur, RolePM).Scan(&one)
		if err == nil {
			return cur, nil // 指定的主负责仍在,保持
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	if _, err := q.ExecContext(ctx, `UPDATE projects SET lead_pm_id = $2 WHERE id = $1`, projectID, first); err != nil {
		return "", err
	}
	return first, nil
}

// setLeadTx 把某位 PM 设为主负责
func setLeadTx(ctx context.Context, q runner, projectID, userID string) error {
	_, err := q.ExecContext(ctx, `UPDATE projects SET lead_pm_id = $2 WHERE id = $1`, projectID, userID)
	return err
}

// ---- 视图 ----

// intakeSummaryOf 项目列表里的承接摘要。asIs 是立项时的步骤(没有快照时退回当前流程)
func intakeSummaryOf(pr *Project, st StageTemplate, cur ProjectStage, hasPM bool, asIs []Step, p *Process) *IntakeSummary {
	if len(asIs) == 0 && p != nil {
		asIs = p.Steps
	}
	d := Diagnose(asIs)
	phase := intakePhase(pr, cur, hasPM)
	return &IntakeSummary{
		Phase: phase, Seq: st.Seq,
		TriageDone:   pr.TriageDoneAt != nil,
		FinalPending: pr.FinalStatus == FinalPending,
		Offline:      len(d.Offline), Interop: len(d.Interop), Mobile: len(d.Mobile),
		Legacy: intakeLegacy(pr, phase),
	}
}

// IntakeOverview 数据大屏上的需求承接:全池诊断(已立项流程的三类节点合计),与承接环节上的积压
type IntakeOverview struct {
	Projects        int `json:"projects"` // 第一个阶段是承接阶段的已立项流程数
	Offline         int `json:"offline"`
	Interop         int `json:"interop"`
	Mobile          int `json:"mobile"`
	OfflineAffected int `json:"offlineAffected"` // 有这类节点的流程数
	InteropAffected int `json:"interopAffected"`
	MobileAffected  int `json:"mobileAffected"`
	Triage          int `json:"triage"` // 待 PMO 初级分析或指派 PM 的在途项目
	Final           int `json:"final"`  // 技术可行性评估已通过、等 PMO 终审的在途项目
}

// intakePoolItem 全池诊断里的一条流程
type intakePoolItem struct {
	Pr    *Project
	Stage ProjectStage // 承接阶段(序号 1)的现状
	HasPM bool
	Steps []Step // 立项时的流程
}

// intakePoolSum 全池诊断的合计:只数第一个阶段是承接阶段的流程,每条按立项时的流程诊断一遍再相加
func intakePoolSum(items []intakePoolItem) *IntakeOverview {
	out := &IntakeOverview{}
	for _, it := range items {
		if _, ok := it.Pr.intakeStage(); !ok {
			continue
		}
		out.Projects++
		d := Diagnose(it.Steps)
		if n := len(d.Offline); n > 0 {
			out.Offline, out.OfflineAffected = out.Offline+n, out.OfflineAffected+1
		}
		if n := len(d.Interop); n > 0 {
			out.Interop, out.InteropAffected = out.Interop+n, out.InteropAffected+1
		}
		if n := len(d.Mobile); n > 0 {
			out.Mobile, out.MobileAffected = out.Mobile+n, out.MobileAffected+1
		}
		// 积压只算在途项目
		if it.Pr.Status != ProjActive {
			continue
		}
		switch intakePhase(it.Pr, it.Stage, it.HasPM) {
		case PhaseTriage, PhaseAssign:
			out.Triage++
		case PhaseFinal:
			out.Final++
		}
	}
	return out
}

// intakePool 大屏的全池诊断:读出全部未取消的项目及其立项时的流程,交给 intakePoolSum 合计。
// 没有快照的存量项目退回当前流程(与项目列表里的诊断同一口径)。
func (s *postgresStore) intakePool(ctx context.Context) (*IntakeOverview, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT pr.id, pr.process_id, pr.status, pr.current_stage, pr.template, pr.final_status, pr.triage_done_at,
		COALESCE(st.status, ''), COALESCE((SELECT bool_or(m.role = 'pm') FROM project_members m WHERE m.project_id = pr.id), false)
		FROM projects pr LEFT JOIN project_stages st ON st.project_id = pr.id AND st.seq = 1
		WHERE pr.status <> 'cancelled' ORDER BY pr.created_at, pr.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []intakePoolItem{}
	ids := []string{}
	for rows.Next() {
		var id, processID, status, final, stageStatus string
		var seq int
		var raw []byte
		var triaged *time.Time
		var hasPM bool
		if err := rows.Scan(&id, &processID, &status, &seq, &raw, &final, &triaged, &stageStatus, &hasPM); err != nil {
			return nil, err
		}
		items = append(items, intakePoolItem{
			Pr:    &Project{ID: id, ProcessID: processID, Status: status, CurrentStage: seq, tpl: parseTemplate(raw), FinalStatus: final, TriageDoneAt: triaged},
			Stage: ProjectStage{Seq: 1, Status: stageStatus},
			HasPM: hasPM,
		})
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	asIs, err := asIsStepsOf(ctx, s.db, ids)
	if err != nil {
		return nil, err
	}
	// 只有缺快照的存量项目才需要读当前流程(要读全部流程定义,不便宜),所以等到用得上再读
	var current map[string][]Step
	for i := range items {
		items[i].Steps = asIs[items[i].Pr.ID]
		if len(items[i].Steps) > 0 || items[i].Pr.ProcessID == "" {
			continue
		}
		if current == nil {
			procs, err := s.List()
			if err != nil {
				return nil, err
			}
			current = map[string][]Step{}
			for _, p := range procs {
				current[p.ID] = p.Steps
			}
		}
		items[i].Steps = current[items[i].Pr.ProcessID]
	}
	return intakePoolSum(items), nil
}

// intakeMissing 提交技术可行性评估前还差什么。d 是立项时的诊断。
func intakeMissing(d Diagnosis, row intakeRow, lines map[string]lineRow, points []*IntakePoint, valueOK, complexityOK bool) []string {
	out := []string{}
	if !validCompleteness[row.Completeness] {
		out = append(out, "还没确认流程是否完整")
	}
	for _, key := range intakeLineKeys {
		if d.count(key) == 0 {
			continue // 没有这类节点,不必写原因与方案
		}
		title := intakeLineTitle(key)
		if strings.TrimSpace(lines[key].Reason) == "" {
			out = append(out, "「"+title+"」还没写原因")
		}
		if strings.TrimSpace(lines[key].Solution) == "" {
			out = append(out, "「"+title+"」还没写解决方案")
		}
	}
	if d.hasAny() {
		if strings.TrimSpace(row.Summary) == "" {
			out = append(out, "还没写综合方案总述")
		}
		if len(points) == 0 {
			out = append(out, "还没有供 CTO 评估的技术点")
		}
	}
	if !valueOK {
		out = append(out, "还没评估改造价值")
	}
	if !complexityOK {
		out = append(out, "还没评估复杂度")
	}
	return out
}

// intakeMissingTx 在事务里读出承接方案并判断还差什么;asIs 是立项时的步骤
func intakeMissingTx(ctx context.Context, q runner, pr *Project, asIs []Step) ([]string, error) {
	row, err := loadIntakeRowTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	lines, err := loadLinesTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	points, err := loadPointsTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	return intakeMissing(Diagnose(asIs), row, lines, points, validLevel(pr.Value), validLevel(pr.Complexity)), nil
}

// leadPmOf 主负责 PM 的 ID 与显示名:显式指定的仍在 PM 名单里就用它;否则取最早到岗的 PM
// (成员列表按加入时间排序)。没有 PM 时返回空。
func leadPmOf(pr *Project, members []MemberView) (string, string) {
	lead := pr.LeadPmID
	for _, m := range members {
		if m.Role == RolePM && (lead == "" || lead == m.UserID) {
			return m.UserID, m.DisplayName
		}
	}
	return "", ""
}

// userNames 用户 ID → 显示名
func userNames(users []*User) map[string]string {
	out := make(map[string]string, len(users))
	for _, u := range users {
		out[u.ID] = displayName(u)
	}
	return out
}

// buildIntakeView 承接的完整视图。names 用来把各类经办人的 ID 翻成显示名。
func buildIntakeView(ctx context.Context, q runner, pr *Project, st StageTemplate, cur ProjectStage, hasPM bool,
	p *Process, asIs []Step, a *actor, c caps, names map[string]string) (*IntakeView, error) {
	base := Diagnose(asIs)
	phase := intakePhase(pr, cur, hasPM)
	v := &IntakeView{
		Phase: phase, Seq: st.Seq, Legacy: intakeLegacy(pr, phase), StageName: st.Name, Gate: st.Gate,
		ReviewerRole: st.ReviewerRole, Mode: st.Mode, ReviewStatus: "",
		TriageDoneAt: pr.TriageDoneAt, TriageByName: names[pr.TriageBy],
		FinalPending: pr.FinalStatus == FinalPending,
		AsIs:         base,
		Current:      Diagnosis{Offline: []NodeRef{}, Interop: []NodeRef{}, Mobile: []NodeRef{}},
		Lines:        []LineView{}, Points: []*IntakePoint{}, Finals: []*IntakeFinal{}, Missing: []string{},
		CtoSupport: parseSupport(pr.CtoSupport),
		OwnLines:   []string{},
		Can:        map[string]bool{},
	}
	if p != nil {
		v.Current = Diagnose(p.Steps)
	}
	row, err := loadIntakeRowTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	v.Completeness, v.CompletenessNote, v.Summary = row.Completeness, row.CompletenessNote, row.Summary
	lines, err := loadLinesTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	plans, err := loadPlansTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	for _, key := range intakeLineKeys {
		lr := lines[key]
		lv := LineView{
			Key: key, Reason: lr.Reason, Solution: lr.Solution,
			OwnerID: lr.OwnerID, OwnerName: names[lr.OwnerID], UpdatedByName: names[lr.UpdatedBy], UpdatedAt: lr.UpdatedAt,
			Nodes: []NodeView{}, Remaining: v.Current.count(key),
		}
		for _, ref := range base.refs(key) {
			pl := plans[key][ref.Key]
			if pl.Status == "" {
				pl.Status = PlanPending
			}
			lv.Nodes = append(lv.Nodes, NodeView{NodeRef: ref, Status: pl.Status, Note: pl.Note, UpdatedByName: names[pl.UpdatedBy], UpdatedAt: pl.UpdatedAt})
		}
		v.Lines = append(v.Lines, lv)
	}
	points, err := loadPointsTx(ctx, q, pr.ID)
	if err != nil {
		return nil, err
	}
	var rid, rstatus string
	var round int
	if err := q.QueryRowContext(ctx, `SELECT id, round, status FROM gate_reviews
		WHERE project_id = $1 AND stage_seq = $2 ORDER BY round DESC LIMIT 1`, pr.ID, st.Seq).Scan(&rid, &round, &rstatus); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	v.ReviewID, v.Round, v.ReviewStatus = rid, round, rstatus
	if rid != "" {
		assess, err := loadAssessmentsTx(ctx, q, rid)
		if err != nil {
			return nil, err
		}
		for _, pt := range points {
			pt.Assessments = assess[pt.ID]
			if pt.Assessments == nil {
				pt.Assessments = []IntakeAssessment{}
			}
		}
	}
	// 复评时带上上一轮的结论,CTO 可以沿用,只重新评变过的技术点
	if rstatus == ReviewPending && round > 1 {
		var prev string
		if err := q.QueryRowContext(ctx, `SELECT id FROM gate_reviews WHERE project_id = $1 AND stage_seq = $2 AND round = $3`,
			pr.ID, st.Seq, round-1).Scan(&prev); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		carried, err := loadAssessmentsTx(ctx, q, prev)
		if err != nil {
			return nil, err
		}
		for _, pt := range points {
			pt.PrevAssessments = carried[pt.ID]
		}
	}
	for _, pt := range points {
		pt.CreatedByName = names[pt.CreatedBy]
	}
	v.Points = points
	if v.Finals, err = loadFinalsTx(ctx, q, pr.ID); err != nil {
		return nil, err
	}
	v.Missing = intakeMissing(base, row, lines, points, validLevel(pr.Value), validLevel(pr.Complexity))

	live := pr.Status == ProjActive
	pendingHere := live && cur.Status == StageInReview && rstatus == ReviewPending
	editable := live && cur.Status == StageInProgress
	listed := false
	if pendingHere && a != nil && a.ID != "" {
		if listed, err = reviewHasReviewerTx(ctx, q, rid, a.ID); err != nil {
			return nil, err
		}
	}
	// 推进线的负责人(项目里的 BH / TH)可以改自己那一条;PM、CTO、管理员能改全部
	if editable && a != nil {
		for _, key := range intakeLineKeys {
			if lines[key].OwnerID != "" && lines[key].OwnerID == a.ID {
				v.OwnLines = append(v.OwnLines, key)
			}
		}
	}
	v.Can = map[string]bool{
		"triage":     c.triage() && live && !hasPM && cur.Status == StagePending,
		"assign":     c.assign(),
		"edit":       c.manage() && editable,
		"editLines":  len(v.OwnLines) > 0,
		"requestCto": c.manage() && editable,
		"joinCto":    c.CTO && v.CtoSupport.Status == SupportRequested,
		"assess":     pendingHere && (listed || c.Admin || c.canReview(st.ReviewerRole)),
		"final":      c.finalReview() && live && pr.FinalStatus == FinalPending,
		"manage":     c.manage(),
	}
	return v, nil
}
