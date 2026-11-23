package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// runner 同时覆盖 *sql.DB 与 *sql.Tx,使同一份 SQL 既能单语句执行也能放进事务
type runner interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// scanner 兼容 *sql.Rows 与 *sql.Row
type scanner interface {
	Scan(dest ...any) error
}

// projectSchema 流程项目的表结构(幂等);含义见 docs/process-management-architecture.md 第 7 节
const projectSchema = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS department   TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_role     TEXT NOT NULL DEFAULT 'handler';

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  process_id    TEXT NOT NULL REFERENCES processes(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  current_stage SMALLINT NOT NULL DEFAULT 1,
  priority      TEXT NOT NULL DEFAULT 'medium',
  value         TEXT NOT NULL DEFAULT '',
  complexity    TEXT NOT NULL DEFAULT '',
  analysis      JSONB NOT NULL DEFAULT '{}',
  health        TEXT NOT NULL DEFAULT 'on_track',
  due_date      DATE,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);
-- 一个流程同时只有一个在途项目
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_active ON projects (process_id)
  WHERE status IN ('active', 'on_hold');
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status, current_stage);

CREATE TABLE IF NOT EXISTS project_stages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq        SMALLINT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  entered_at TIMESTAMPTZ,
  exited_at  TIMESTAMPTZ,
  due_date   DATE,
  UNIQUE (project_id, seq)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,
  added_by   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS gate_reviews (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  stage_seq    SMALLINT NOT NULL,
  round        SMALLINT NOT NULL DEFAULT 1,
  status       TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  decided_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reviews_project ON gate_reviews (project_id, stage_seq, round DESC);

CREATE TABLE IF NOT EXISTS gate_reviewers (
  review_id  TEXT NOT NULL REFERENCES gate_reviews(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL,
  decision   TEXT NOT NULL DEFAULT 'pending',
  comment    TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  PRIMARY KEY (review_id, user_id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  stage_seq    SMALLINT,
  type         TEXT NOT NULL DEFAULT 'task',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     TEXT NOT NULL DEFAULT 'medium',
  assignee_id  TEXT REFERENCES users(id),
  parent_id    TEXT REFERENCES work_items(id),
  due_date     DATE,
  block_reason TEXT NOT NULL DEFAULT '',
  labels       JSONB NOT NULL DEFAULT '[]',
  checklist    JSONB NOT NULL DEFAULT '[]',
  required     BOOLEAN NOT NULL DEFAULT false,
  done_at      TIMESTAMPTZ,
  sort_key     BIGINT NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_items_project ON work_items (project_id, stage_seq, status);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON work_items (assignee_id, status);

CREATE TABLE IF NOT EXISTS work_item_links (
  from_id TEXT NOT NULL REFERENCES work_items(id),
  to_id   TEXT NOT NULL REFERENCES work_items(id),
  kind    TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  item_id    TEXT REFERENCES work_items(id),
  review_id  TEXT REFERENCES gate_reviews(id),
  kind       TEXT NOT NULL DEFAULT 'comment',
  body       TEXT NOT NULL,
  structured JSONB NOT NULL DEFAULT '{}',
  mentions   JSONB NOT NULL DEFAULT '[]',
  author_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS process_versions (
  id         TEXT PRIMARY KEY,
  process_id TEXT NOT NULL REFERENCES processes(id),
  project_id TEXT REFERENCES projects(id),
  version    INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  steps      JSONB NOT NULL,
  metrics    JSONB NOT NULL DEFAULT '{}',
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (process_id, version)
);

CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  source_id  TEXT UNIQUE,
  project_id TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'project',
  target_id  TEXT NOT NULL DEFAULT '',
  actor_id   TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON events (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  project_id TEXT,
  item_id    TEXT,
  review_id  TEXT,
  title      TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);`

const projectCols = `pr.id, pr.process_id, pr.name, pr.status, pr.current_stage, pr.priority,
	pr.value, pr.complexity, pr.analysis, pr.health, COALESCE(pr.due_date::text, ''),
	pr.started_at, pr.completed_at, pr.version, pr.created_by, pr.created_at, pr.updated_at, pr.template`

func scanProject(sc scanner) (*Project, error) {
	var pr Project
	var analysis, tpl []byte
	var started, completed sql.NullTime
	if err := sc.Scan(&pr.ID, &pr.ProcessID, &pr.Name, &pr.Status, &pr.CurrentStage, &pr.Priority,
		&pr.Value, &pr.Complexity, &analysis, &pr.Health, &pr.DueDate,
		&started, &completed, &pr.Version, &pr.CreatedBy, &pr.CreatedAt, &pr.UpdatedAt, &tpl); err != nil {
		return nil, err
	}
	pr.Analysis = rawOrNull(analysis)
	pr.tpl = parseTemplate(tpl)
	if started.Valid {
		t := started.Time
		pr.StartedAt = &t
	}
	if completed.Valid {
		t := completed.Time
		pr.CompletedAt = &t
	}
	return &pr, nil
}

// displayNameOr 显示名为空时回退用户名
func displayNameOr(name, fallback string) string {
	if strings.TrimSpace(name) != "" {
		return name
	}
	return fallback
}

// rawOrNull JSONB 列读出为字节,空值或非法内容一律回落为 null 字面量
func rawOrNull(b []byte) json.RawMessage {
	if !json.Valid(b) {
		return json.RawMessage("null")
	}
	return json.RawMessage(b)
}

// ---- 事件与通知(事务内调用) ----

func addEventTx(ctx context.Context, q runner, projectID, scope, targetID string, a *actor, kind string, detail map[string]any) error {
	detailJSON, _ := json.Marshal(detail)
	actorID, actorName := "", "系统"
	if a != nil {
		actorID, actorName = a.ID, a.name()
	}
	_, err := q.ExecContext(ctx, `INSERT INTO events (project_id, scope, target_id, actor_id, actor_name, kind, detail, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
		projectID, scope, targetID, actorID, actorName, kind, string(detailJSON))
	return err
}

// notifyTx 写站内通知;(user_id, dedupe_key) 唯一,重复触发不会刷屏。userID 为空(引导管理员)时跳过。
func notifyTx(ctx context.Context, q runner, userID, kind, projectID, itemID, reviewID, title, dedupeKey string) error {
	if userID == "" {
		return nil
	}
	_, err := q.ExecContext(ctx, `INSERT INTO notifications (id, user_id, kind, project_id, item_id, review_id, title, dedupe_key, created_at)
		VALUES ($1, $2, $3, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''), $7, $8, now())
		ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
		newID(), userID, kind, projectID, itemID, reviewID, title, dedupeKey)
	return err
}

// notifyManyTx 给多个用户发同一条通知;keyFn 为每个人生成幂等键(为空则按通知 ID 去重)
func notifyManyTx(ctx context.Context, q runner, userIDs []string, kind, projectID, itemID, reviewID, title, keyPrefix string) error {
	for _, uid := range userIDs {
		if err := notifyTx(ctx, q, uid, kind, projectID, itemID, reviewID, title, keyPrefix+":"+uid); err != nil {
			return err
		}
	}
	return nil
}

// memberUserIDsTx 项目全体成员(PM / 经办 / 开发 / 观察者)的用户 ID,去重
func memberUserIDsTx(ctx context.Context, q runner, projectID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT user_id FROM project_members WHERE project_id = $1`, projectID)
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

// usersWithRoleTx 某系统角色的用户(评审人缺位时的兜底)
func usersWithRoleTx(ctx context.Context, q runner, sysRole string) ([]*User, error) {
	rows, err := q.QueryContext(ctx, userCols+` WHERE role = $1 ORDER BY created_at`, sysRole)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

// usersWithJobTx 某岗位的全部用户
func usersWithJobTx(ctx context.Context, q runner, job string) ([]*User, error) {
	rows, err := q.QueryContext(ctx, userCols+` WHERE job_role = $1 ORDER BY created_at`, job)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

// ---- 项目创建与存量迁移 ----

// legacyFollow 旧跟进字段到项目的迁移映射
type legacyFollow struct {
	Status      string
	Current     int
	StageStatus map[int]string // seq → 阶段状态
	Value       string
	Complexity  string
	Priority    string
	Analysis    json.RawMessage
	DueDate     string
	PMUserID    string
	Edited      bool // 存量流程是否被原地编辑过(As-Is 快照可能已含改动)
}

// legacyFromProcess 按架构文档 5.4 的映射把 processes 上的旧跟进字段翻译成项目状态
func legacyFromProcess(p *Process, edited bool) *legacyFollow {
	l := &legacyFollow{Status: ProjActive, Current: 1, StageStatus: map[int]string{}, Priority: "medium", Analysis: json.RawMessage(`{}`)}
	var an struct{ Value, Complexity, Priority string }
	if json.Valid(p.Analysis) {
		_ = json.Unmarshal(p.Analysis, &an)
		l.Analysis = json.RawMessage(p.Analysis)
	}
	l.Value, l.Complexity = an.Value, an.Complexity
	if an.Priority != "" {
		l.Priority = levelCode(an.Priority)
	}
	l.DueDate, l.PMUserID, l.Edited = p.DueDate, p.AssigneeID, edited
	cur := "in_progress"
	if l.PMUserID == "" {
		cur = StagePending
	}
	// 映射按内置的七阶段口径定义:存量流程一律按内置模板建项目,与后台当前的模板无关
	switch p.FollowStatus {
	case "done":
		last := len(defaultStageTemplates())
		l.Status, l.Current = ProjDone, last
		for n := 1; n < last; n++ {
			l.StageStatus[n] = StageApproved
		}
	case "review":
		l.Current = 6
		for n := 1; n <= 5; n++ {
			l.StageStatus[n] = StageApproved
		}
		l.StageStatus[6] = StageInProgress
	default:
		// analyzing / unassigned / following / shelved:已有跟进人且推进过阶段的,说明项目早已启动
		// (旧系统搁置后不保留搁置前的状态,只能由跟进人与阶段推断)
		n := 1
		started := l.PMUserID != "" && p.Stage > 0
		if started {
			n = p.Stage + 1
			for k := 1; k < n; k++ {
				l.StageStatus[k] = StageApproved
			}
		}
		if p.FollowStatus == "shelved" {
			l.Status = ProjOnHold
		}
		l.Current = n
		l.StageStatus[n] = cur
		if started {
			l.StageStatus[n] = StageInProgress
		}
	}
	return l
}

// createProjectTx 为一条流程建立项目:项目行、各阶段、模板工作项、As-Is 快照与事件。
// 调用方负责事务。l 非 nil 时按旧跟进数据迁入。tpl 是立项时采用的阶段模板,会快照进项目行。
func createProjectTx(ctx context.Context, tx *sql.Tx, p *Process, a *actor, l *legacyFollow, tpl []StageTemplate) (string, error) {
	id := newID()
	now := time.Now()
	byID, status, cur := "", ProjActive, 1
	value, complexity, priority, due := "", "", "medium", ""
	analysis := json.RawMessage(`{}`)
	var startedAt, completedAt *time.Time
	stageStatus := make([]string, len(tpl)+1)
	for i := range stageStatus {
		stageStatus[i] = StagePending
	}
	note := "立项时的流程定义（As-Is）"

	if a != nil {
		byID = a.ID
	}
	if l != nil {
		status, cur, value, complexity, priority, due = l.Status, l.Current, l.Value, l.Complexity, l.Priority, l.DueDate
		analysis = l.Analysis
		for k, v := range l.StageStatus {
			stageStatus[k] = v
		}
		if l.PMUserID != "" {
			startedAt = &now
		}
		if status == ProjDone {
			completedAt = &now
		}
		if l.Edited {
			note += "；注意：存量流程曾被原地编辑，此快照可能已含改动"
		}
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO projects
		(id, process_id, name, status, current_stage, priority, value, complexity, analysis, health, due_date,
		 started_at, completed_at, version, created_by, created_at, updated_at, template)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'on_track', NULLIF($10,'')::date, $11, $12, 1, $13, now(), now(), $14::jsonb)`,
		id, p.ID, p.Name, status, cur, priority, value, complexity, string(analysis), due, startedAt, completedAt, byID,
		templateJSON(tpl)); err != nil {
		return "", err
	}

	// 阶段行 + 模板工作项
	sortKey := int64(0)
	for _, t := range tpl {
		st := stageStatus[t.Seq]
		var entered, exited any
		switch st {
		case StageInProgress, StageInReview:
			entered = now
		case StageApproved, StageSkipped:
			entered, exited = now, now
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO project_stages (id, project_id, seq, status, entered_at, exited_at, due_date)
			VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7,'')::date)`,
			newID(), id, t.Seq, st, entered, exited, due); err != nil {
			return "", err
		}
		stagePassed := st == StageApproved || st == StageSkipped
		addItem := func(typ, title string, required bool) error {
			sortKey++
			itemStatus, doneAt := ItemTodo, any(nil)
			if required && stagePassed {
				itemStatus, doneAt = ItemDone, now
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO work_items
				(id, project_id, stage_seq, type, title, status, required, sort_key, created_by, created_at, updated_at, done_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)`,
				newID(), id, t.Seq, typ, title, itemStatus, required, sortKey, byID, doneAt)
			return err
		}
		for _, title := range t.Required {
			if err := addItem(ItemDeliverable, title, true); err != nil {
				return "", err
			}
		}
		for _, title := range t.Tasks {
			if err := addItem(ItemTask, title, false); err != nil {
				return "", err
			}
		}
	}

	if err := snapshotVersionTx(ctx, tx, id, p, "as_is", note, byID); err != nil {
		return "", err
	}
	if err := addEventTx(ctx, tx, id, "project", "", a, "project_created", map[string]any{
		"name": p.Name, "migrated": l != nil,
	}); err != nil {
		return "", err
	}
	if l != nil && l.PMUserID != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO project_members (project_id, user_id, role, added_by, created_at)
			VALUES ($1, $2, 'pm', $3, now()) ON CONFLICT DO NOTHING`, id, l.PMUserID, byID); err != nil {
			return "", err
		}
	}
	return id, nil
}

// snapshotVersionTx 把流程当前定义存为不可变快照,并记下此刻的流程改善指标
func snapshotVersionTx(ctx context.Context, q runner, projectID string, p *Process, kind, note, byID string) error {
	var max int
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM process_versions WHERE process_id = $1`, p.ID).Scan(&max); err != nil {
		return err
	}
	steps, err := json.Marshal(p.Steps)
	if err != nil {
		return err
	}
	metrics, _ := json.Marshal(ComputeMetrics(p.Steps))
	_, err = q.ExecContext(ctx, `INSERT INTO process_versions
		(id, process_id, project_id, version, kind, steps, metrics, note, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, now())`,
		newID(), p.ID, projectID, max+1, kind, string(steps), string(metrics), note, byID)
	return err
}

// EnsureProjects 为"还没有项目"的流程补建项目,并把旧跟进时间线迁入统一事件流。幂等。
func (s *postgresStore) EnsureProjects(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+listCols+` FROM processes p
		LEFT JOIN users u ON u.id = p.assignee_id
		WHERE NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.process_id = p.id)
		ORDER BY p.created_at ASC`)
	if err != nil {
		return 0, err
	}
	var list []*Process
	for rows.Next() {
		p, err := scanProcess(rows)
		if err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	edited := map[string]bool{}
	if erows, err := s.db.QueryContext(ctx, `SELECT DISTINCT process_id FROM followup_events
		WHERE kind IN ('edited_form','edited_chart')`); err == nil {
		for erows.Next() {
			var id string
			if erows.Scan(&id) == nil {
				edited[id] = true
			}
		}
		erows.Close()
	}

	created := 0
	for _, p := range list {
		err := s.withTx(ctx, func(tx *sql.Tx) error {
			_, err := createProjectTx(ctx, tx, p, nil, legacyFromProcess(p, edited[p.ID]), defaultStageTemplates())
			return err
		})
		if err != nil {
			return created, fmt.Errorf("为流程「%s」建立项目失败: %w", p.Name, err)
		}
		created++
	}

	// 旧时间线 → 统一事件流:事件挂在流程对应的项目上,原流程 ID 记在 target_id。
	// source_id 唯一,重复执行不会重复导入。
	if _, err := s.db.ExecContext(ctx, `INSERT INTO events
		(source_id, project_id, scope, target_id, actor_id, actor_name, kind, detail, created_at)
		SELECT e.id, pr.id, 'process', e.process_id, e.actor_id, e.actor_name, 'legacy_' || e.kind, e.detail, e.created_at
		FROM followup_events e JOIN projects pr ON pr.process_id = e.process_id
		ON CONFLICT (source_id) DO NOTHING`); err != nil {
		return created, err
	}
	return created, nil
}

func (s *postgresStore) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// CreateProjectForProcess 流程提交后自动立项(新提交流程进入阶段 1,等待指派项目经理)。
// 立项时把当前生效的阶段模板快照进项目,之后后台再改模板也不影响这个项目。
func (s *postgresStore) CreateProjectForProcess(ctx context.Context, p *Process) (string, error) {
	var id string
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		tpl, err := loadStageTemplates(ctx, tx)
		if err != nil {
			return err
		}
		id, err = createProjectTx(ctx, tx, p, nil, nil, tpl)
		return err
	})
	return id, err
}

// ---- 读取 ----

type projectBundle struct {
	procs   map[string]*Process
	stages  map[string][]ProjectStage
	rounds  map[string]map[int]int
	members map[string][]MemberView
	reviews map[string]*GateReview
	stats   map[string]*ItemStats
}

func nullTimePtr(ns sql.NullTime) *time.Time {
	if !ns.Valid {
		return nil
	}
	t := ns.Time
	return &t
}

// loadBundle 批量加载一组项目的关联数据(避免逐项目 N+1 查询)
func loadBundle(ctx context.Context, q runner, ids []string) (*projectBundle, error) {
	b := &projectBundle{
		procs:   map[string]*Process{},
		stages:  map[string][]ProjectStage{},
		rounds:  map[string]map[int]int{},
		members: map[string][]MemberView{},
		reviews: map[string]*GateReview{},
		stats:   map[string]*ItemStats{},
	}
	if len(ids) == 0 {
		return b, nil
	}

	// 传入的是项目 ID;流程定义要按其 process_id 去取
	rows, err := q.QueryContext(ctx, `SELECT process_id FROM projects WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	var procIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		procIDs = append(procIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(procIDs) > 0 {
		prows, err := q.QueryContext(ctx, `SELECT `+listCols+` FROM processes p
			LEFT JOIN users u ON u.id = p.assignee_id WHERE p.id = ANY($1)`, procIDs)
		if err != nil {
			return nil, err
		}
		for prows.Next() {
			p, err := scanProcess(prows)
			if err != nil {
				prows.Close()
				return nil, err
			}
			b.procs[p.ID] = p
		}
		prows.Close()
		if err := prows.Err(); err != nil {
			return nil, err
		}
	}

	rows, err = q.QueryContext(ctx, `SELECT project_id, seq, status, entered_at, exited_at, COALESCE(due_date::text,'')
		FROM project_stages WHERE project_id = ANY($1) ORDER BY project_id, seq`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid string
		var st ProjectStage
		var entered, exited sql.NullTime
		if err := rows.Scan(&pid, &st.Seq, &st.Status, &entered, &exited, &st.DueDate); err != nil {
			rows.Close()
			return nil, err
		}
		st.EnteredAt, st.ExitedAt = nullTimePtr(entered), nullTimePtr(exited)
		b.stages[pid] = append(b.stages[pid], st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `SELECT project_id, stage_seq, count(*) FROM gate_reviews
		WHERE project_id = ANY($1) GROUP BY project_id, stage_seq`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid string
		var seq, n int
		if err := rows.Scan(&pid, &seq, &n); err != nil {
			rows.Close()
			return nil, err
		}
		if b.rounds[pid] == nil {
			b.rounds[pid] = map[int]int{}
		}
		b.rounds[pid][seq] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `SELECT m.project_id, m.user_id, u.username, u.display_name, m.role, m.created_at
		FROM project_members m JOIN users u ON u.id = m.user_id
		WHERE m.project_id = ANY($1) ORDER BY m.created_at, u.username`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid string
		var m MemberView
		var dn string
		if err := rows.Scan(&pid, &m.UserID, &m.Username, &dn, &m.Role, &m.AddedAt); err != nil {
			rows.Close()
			return nil, err
		}
		m.DisplayName = displayNameOr(dn, m.Username)
		b.members[pid] = append(b.members[pid], m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 每个项目最近一轮评审(最新阶段的最高轮次)
	rows, err = q.QueryContext(ctx, `SELECT DISTINCT ON (r.project_id) `+reviewCols+`
		FROM gate_reviews r
		LEFT JOIN users su ON su.id = r.submitted_by
		WHERE r.project_id = ANY($1)
		ORDER BY r.project_id, r.stage_seq DESC, r.round DESC`, ids)
	if err != nil {
		return nil, err
	}
	var reviewIDs []string
	for rows.Next() {
		rv, err := scanReview(rows, nil)
		if err != nil {
			rows.Close()
			return nil, err
		}
		rv.Reviewers = []GateReviewer{}
		b.reviews[rv.ProjectID] = rv
		reviewIDs = append(reviewIDs, rv.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(reviewIDs) > 0 {
		rvrows, err := q.QueryContext(ctx, `SELECT `+reviewerCols+` FROM gate_reviewers gr
			LEFT JOIN users u ON u.id = gr.user_id
			WHERE gr.review_id = ANY($1)
			ORDER BY gr.decided_at NULLS LAST, u.username`, reviewIDs)
		if err != nil {
			return nil, err
		}
		byID := map[string]*GateReview{}
		for _, rv := range b.reviews {
			rv.Reviewers = []GateReviewer{}
			byID[rv.ID] = rv
		}
		for rvrows.Next() {
			var rid string
			var g GateReviewer
			var dn string
			var decided sql.NullTime
			if err := rvrows.Scan(&rid, &g.UserID, &g.Username, &dn, &g.Role, &g.Decision, &g.Comment, &decided); err != nil {
				rvrows.Close()
				return nil, err
			}
			g.DisplayName, g.DecidedAt = displayNameOr(dn, g.Username), nullTimePtr(decided)
			if rv := byID[rid]; rv != nil {
				rv.Reviewers = append(rv.Reviewers, g)
			}
		}
		rvrows.Close()
		if err := rvrows.Err(); err != nil {
			return nil, err
		}
	}

	rows, err = q.QueryContext(ctx, `SELECT project_id,
		count(*),
		count(*) FILTER (WHERE status = 'done'),
		count(*) FILTER (WHERE status IN ('todo','in_progress','blocked','in_review') AND due_date IS NOT NULL AND due_date < CURRENT_DATE),
		count(*) FILTER (WHERE status = 'blocked'),
		count(*) FILTER (WHERE required AND status NOT IN ('done','cancelled'))
		FROM work_items WHERE project_id = ANY($1) AND parent_id IS NULL GROUP BY project_id`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid string
		var st ItemStats
		if err := rows.Scan(&pid, &st.Total, &st.Done, &st.Overdue, &st.Blocked, &st.OpenRequired); err != nil {
			rows.Close()
			return nil, err
		}
		b.stats[pid] = &st
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `SELECT project_id, title FROM work_items
		WHERE project_id = ANY($1) AND required AND status NOT IN ('done','cancelled') ORDER BY sort_key`, ids)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var pid, title string
		if err := rows.Scan(&pid, &title); err != nil {
			rows.Close()
			return nil, err
		}
		if st := b.stats[pid]; st != nil {
			st.Missing = append(st.Missing, title)
		}
	}
	rows.Close()
	return b, rows.Err()
}

const reviewCols = `r.id, r.project_id, r.stage_seq, r.round, r.status, r.summary,
	COALESCE(r.submitted_by, ''), COALESCE(NULLIF(su.display_name, ''), su.username, ''), r.submitted_at, r.decided_at`

// scanReview 读一轮评审。tpl 是所属项目的模板快照,用来得出这一轮的表决方式与评审角色;
// 传 nil 时留空,由调用方按项目补上。
func scanReview(sc scanner, tpl []StageTemplate) (*GateReview, error) {
	var rv GateReview
	var subName string
	var decided sql.NullTime
	if err := sc.Scan(&rv.ID, &rv.ProjectID, &rv.StageSeq, &rv.Round, &rv.Status, &rv.Summary,
		&rv.SubmittedBy, &subName, &rv.SubmittedAt, &decided); err != nil {
		return nil, err
	}
	rv.SubmittedByName = subName
	rv.DecidedAt = nullTimePtr(decided)
	if t, ok := templateAt(tpl, rv.StageSeq); ok {
		rv.Mode, rv.ReviewerRole = t.Mode, t.ReviewerRole
	}
	return &rv, nil
}

const reviewerCols = `gr.review_id, gr.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''),
	gr.role, gr.decision, gr.comment, gr.decided_at`

// view 把项目、关联数据与调用者能力拼成 API 视图
func (b *projectBundle) view(pr *Project, users []*User, c caps) *ProjectView {
	v := &ProjectView{Project: *pr, HandlerHints: []HandlerHint{}}
	p := b.procs[pr.ProcessID]
	if p != nil {
		v.Applicant = p.Applicant
		v.Metrics = ComputeMetrics(p.Steps)
		for _, s := range p.Steps {
			if s.Countersign {
				v.CountersignN++
			}
		}
		if users != nil {
			v.HandlerHints = HandlerHints(p, users)
		}
	}
	if v.HandlerHints == nil {
		v.HandlerHints = []HandlerHint{}
	}
	v.Stages = []StageView{}
	stages := map[int]ProjectStage{}
	for _, st := range b.stages[pr.ID] {
		stages[st.Seq] = st
	}
	for _, t := range pr.template() {
		sv := StageView{Seq: t.Seq, Key: t.Key, Name: t.Name, Gate: t.Gate, ReviewerRole: t.ReviewerRole, Mode: t.Mode, Status: StagePending}
		if st, ok := stages[t.Seq]; ok {
			sv.Status, sv.EnteredAt, sv.ExitedAt, sv.DueDate = st.Status, st.EnteredAt, st.ExitedAt, st.DueDate
		}
		sv.Rounds = b.rounds[pr.ID][t.Seq]
		v.Stages = append(v.Stages, sv)
	}
	v.Members = b.members[pr.ID]
	if v.Members == nil {
		v.Members = []MemberView{}
	}
	for _, m := range v.Members {
		if m.Role == RolePM {
			v.HasPM = true
		}
	}
	v.Review = b.reviews[pr.ID]
	if v.Review != nil {
		// 批量加载时不知道项目模板,这里按项目自己的快照补上这一轮的规则
		if t, ok := pr.stageAt(v.Review.StageSeq); ok {
			v.Review.Mode, v.Review.ReviewerRole = t.Mode, t.ReviewerRole
		}
	}
	if st := b.stats[pr.ID]; st != nil {
		v.Stats = *st
	}
	if v.Stats.Missing == nil {
		v.Stats.Missing = []string{}
	}
	v.PendingOn = pendingOnOf(pr.template(), pr, stages[pr.CurrentStage], v.HasPM)
	v.Can = c.flags()
	return v
}

// pendingOnOf 推导"待谁处理":admin(待指派) | pm | cto | handler | ""。tpl 是项目的模板快照
func pendingOnOf(tpl []StageTemplate, pr *Project, cur ProjectStage, hasPM bool) string {
	if pr.Status != ProjActive {
		return ""
	}
	if cur.Status == StageInReview {
		if t, ok := templateAt(tpl, cur.Seq); ok && t.ReviewerRole != "" {
			return t.ReviewerRole
		}
		return RolePM
	}
	if !hasPM {
		return "admin"
	}
	return RolePM
}

// listProjects 按条件取项目行
func listProjects(ctx context.Context, q runner, where string, args ...any) ([]*Project, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+projectCols+` FROM projects pr `+where+` ORDER BY pr.updated_at DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Project
	for rows.Next() {
		pr, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pr)
	}
	return out, rows.Err()
}

// getProject 取单个项目;forUpdate 时锁行
func getProject(ctx context.Context, q runner, id string, forUpdate bool) (*Project, error) {
	suffix := ` WHERE pr.id = $1`
	if forUpdate {
		suffix += ` FOR UPDATE`
	}
	pr, err := scanProject(q.QueryRowContext(ctx, `SELECT `+projectCols+` FROM projects pr`+suffix, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return pr, err
}

// touchProject 更新时间与版本号(事务内调用)
func touchProject(ctx context.Context, q runner, id string) error {
	_, err := q.ExecContext(ctx, `UPDATE projects SET version = version + 1, updated_at = now() WHERE id = $1`, id)
	return err
}

// processesByID 批量取流程定义
func (s *postgresStore) processesByIDs(ctx context.Context, ids []string) ([]*Process, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+listCols+` FROM processes p
		LEFT JOIN users u ON u.id = p.assignee_id WHERE p.id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Process
	for rows.Next() {
		p, err := scanProcess(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// projectIDForProcess 流程对应的项目 ID(在途优先)
func projectIDForProcess(ctx context.Context, q runner, processID string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM projects WHERE process_id = $1
		ORDER BY (status IN ('active','on_hold')) DESC, created_at DESC LIMIT 1`, processID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}
