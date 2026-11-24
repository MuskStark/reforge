package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// store 流程存储接口（JSON 文件 / PostgreSQL 两种实现共用）
type store interface {
	List() ([]*Process, error)
	Get(id string) (*Process, error)
	Create(p *Process) (*Process, error)
	Delete(id string) (bool, error)
	ListSystems() ([]SystemOption, error)
	CreateSystem(name string) (*SystemOption, error)
	DeleteSystem(id string) (bool, error)
	CountUsers() (int, error)
	// CreateUser 创建用户：u.Role 非空用显式角色（管理员创建），
	// 否则原子判定——表为空时 admin（首个注册用户即管理员）
	CreateUser(u *User) error
	GetUserByUsername(username string) (*User, error)
	GetUserByID(id string) (*User, error)
	ListUsers() ([]*User, error)
	DeleteUser(id string) (bool, error)
	// CountAdmins 管理员数量（最后一个管理员删除保护）
	CountAdmins() (int, error)
	Update(p *Process) error
	Close() error
}

const schema = `
CREATE TABLE IF NOT EXISTS processes (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	applicant   TEXT NOT NULL DEFAULT '',
	steps       JSONB NOT NULL,
	created_at  TIMESTAMPTZ NOT NULL,
	updated_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processes_created_at ON processes (created_at DESC);

CREATE TABLE IF NOT EXISTS systems (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_systems_name ON systems (name);

CREATE TABLE IF NOT EXISTS users (
	id            TEXT PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role          TEXT NOT NULL DEFAULT 'member',
	display_name  TEXT NOT NULL DEFAULT '',
	department    TEXT NOT NULL DEFAULT '',
	job_role      TEXT NOT NULL DEFAULT 'handler',
	must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
	created_at    TIMESTAMPTZ NOT NULL
);`

// newStore 依据 DATABASE_URL（默认本机 Docker Postgres）建立存储；
// 表为空且存在历史 JSON 文件时自动做一次数据迁移。
func newStore(dsn string) (*postgresStore, error) {
	if dsn == "" {
		dsn = "postgres://flow:flow@127.0.0.1:5432/flow?sslmode=disable"
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(time.Hour)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("连接数据库失败（请先执行 docker compose up -d）: %w", err)
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化表结构失败: %w", err)
	}
	// 跟进体系增量迁移(幂等):存量流程自动落入「需求分析」
	if _, err := db.ExecContext(ctx, `
ALTER TABLE processes ADD COLUMN IF NOT EXISTS follow_status TEXT NOT NULL DEFAULT 'analyzing';
ALTER TABLE processes ADD COLUMN IF NOT EXISTS assignee_id TEXT;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS due_date TEXT;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS stage SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE processes ADD COLUMN IF NOT EXISTS analysis JSONB;
CREATE TABLE IF NOT EXISTS followup_events (
	id          TEXT PRIMARY KEY,
	process_id  TEXT NOT NULL,
	actor_id    TEXT NOT NULL,
	actor_name  TEXT NOT NULL DEFAULT '',
	kind        TEXT NOT NULL,
	detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fe_process ON followup_events (process_id, created_at DESC);
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;`); err != nil {
		db.Close()
		return nil, fmt.Errorf("跟进表迁移失败: %w", err)
	}

	if _, err := db.ExecContext(ctx, projectSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("流程项目表初始化失败: %w", err)
	}
	if _, err := db.ExecContext(ctx, stageTemplateSchema+channelSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("阶段模板 / 通知渠道表初始化失败: %w", err)
	}

	s := &postgresStore{db: db}
	// 首次启动:把内置的阶段模板写进配置表,之后管理员可以在后台修改
	if err := s.ensureStageTemplates(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("阶段模板初始化失败: %w", err)
	}
	if err := s.migrateFromJSON("data/processes.json"); err != nil {
		db.Close()
		return nil, err
	}
	// 存量流程补建流程项目(幂等):旧跟进字段迁入项目,旧时间线迁入统一事件流
	if n, err := s.EnsureProjects(context.Background()); err != nil {
		db.Close()
		return nil, fmt.Errorf("流程项目迁移失败: %w", err)
	} else if n > 0 {
		log.Printf("已为 %d 条存量流程建立流程项目", n)
	}
	if err := s.SeedSystemsFromProcesses(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

type postgresStore struct {
	db *sql.DB
}

// userCols 用户表的查询列(与 User 字段扫描顺序一致)
const userCols = `SELECT id, username, password_hash, role, display_name, department, job_role, created_at, must_change_password FROM users`

// defaultJobRole 岗位为空或非法时回落为经办
func defaultJobRole(r string) string {
	if !validJobRoles[r] {
		return RoleHandler
	}
	return r
}

const listCols = `p.id, p.name, p.description, p.applicant, p.steps,
	p.created_at, p.updated_at, p.follow_status, p.assignee_id,
	COALESCE(u.username, ''), COALESCE(p.due_date, ''), p.stage, COALESCE(p.analysis, NULL)`

func scanProcess(row interface{ Scan(...any) error }) (*Process, error) {
	var p Process
	var steps, analysis []byte
	var assigneeID, dueDate sql.NullString
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.Applicant, &steps, &p.CreatedAt, &p.UpdatedAt,
		&p.FollowStatus, &assigneeID, &p.AssigneeName, &dueDate, &p.Stage, &analysis); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(steps, &p.Steps); err != nil {
		return nil, fmt.Errorf("解析步骤数据失败: %w", err)
	}
	if assigneeID.Valid {
		p.AssigneeID = assigneeID.String
	}
	if dueDate.Valid {
		p.DueDate = dueDate.String
	}
	p.Analysis = analysis
	return &p, nil
}

func (s *postgresStore) List() ([]*Process, error) {
	rows, err := s.db.Query("SELECT " + listCols + " FROM processes p LEFT JOIN users u ON u.id = p.assignee_id ORDER BY p.created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Process{}
	for rows.Next() {
		p, err := scanProcess(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *postgresStore) Get(id string) (*Process, error) {
	p, err := scanProcess(s.db.QueryRow("SELECT "+listCols+" FROM processes p LEFT JOIN users u ON u.id = p.assignee_id WHERE p.id = $1", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

func (s *postgresStore) Create(p *Process) (*Process, error) {
	if p.ID == "" {
		p.ID = newID()
	}
	steps, err := json.Marshal(p.Steps)
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec(
		`INSERT INTO processes (id, name, description, applicant, steps, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		p.ID, p.Name, p.Description, p.Applicant, steps, p.CreatedAt, p.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// Delete 删除一条流程。每条提交流程都自动立了项,所以连同它的流程项目及全部关联记录一并删除
// (阶段、成员、评审、工作项、评论、版本快照、事件、通知),不留孤儿项目。单条语句里父子行一起删,
// 自引用的外键(工作项的父项)先把父子关系解开,不依赖数据库的延迟检查。
func (s *postgresStore) Delete(id string) (bool, error) {
	deleted := false
	err := s.withTx(context.Background(), func(tx *sql.Tx) error {
		var one int
		err := tx.QueryRow(`SELECT 1 FROM processes WHERE id = $1`, id).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		projects := `(SELECT id FROM projects WHERE process_id = $1)`
		items := `(SELECT id FROM work_items WHERE project_id IN ` + projects + `)`
		reviews := `(SELECT id FROM gate_reviews WHERE project_id IN ` + projects + `)`
		for _, q := range []string{
			`DELETE FROM work_item_links WHERE from_id IN ` + items + ` OR to_id IN ` + items,
			`DELETE FROM comments WHERE project_id IN ` + projects + ` OR item_id IN ` + items + ` OR review_id IN ` + reviews,
			`DELETE FROM gate_reviewers WHERE review_id IN ` + reviews,
			`DELETE FROM gate_reviews WHERE project_id IN ` + projects,
			`UPDATE work_items SET parent_id = NULL WHERE parent_id IN ` + items,
			`DELETE FROM work_items WHERE project_id IN ` + projects,
			`DELETE FROM process_versions WHERE process_id = $1 OR project_id IN ` + projects,
			`DELETE FROM notifications WHERE project_id IN ` + projects + ` OR item_id IN ` + items + ` OR review_id IN ` + reviews,
			`DELETE FROM events WHERE project_id IN ` + projects,
			`DELETE FROM project_stages WHERE project_id IN ` + projects,
			`DELETE FROM project_members WHERE project_id IN ` + projects,
			`DELETE FROM projects WHERE process_id = $1`,
		} {
			if _, err := tx.Exec(q, id); err != nil {
				return err
			}
		}
		res, err := tx.Exec(`DELETE FROM processes WHERE id = $1`, id)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		deleted = n > 0
		return nil
	})
	return deleted, err
}

// ---- 线上系统库 ----

func (s *postgresStore) ListSystems() ([]SystemOption, error) {
	rows, err := s.db.Query("SELECT id, name, created_at FROM systems ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SystemOption{}
	for rows.Next() {
		var so SystemOption
		if err := rows.Scan(&so.ID, &so.Name, &so.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, so)
	}
	return out, rows.Err()
}

// CreateSystem 按名称幂等创建（已存在则原样返回，保证下拉去重）
func (s *postgresStore) CreateSystem(name string) (*SystemOption, error) {
	var so SystemOption
	err := s.db.QueryRow("SELECT id, name, created_at FROM systems WHERE name = $1", name).
		Scan(&so.ID, &so.Name, &so.CreatedAt)
	if err == nil {
		return &so, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	so = SystemOption{ID: newID(), Name: name, CreatedAt: time.Now()}
	_, err = s.db.Exec("INSERT INTO systems (id, name, created_at) VALUES ($1, $2, $3)",
		so.ID, so.Name, so.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &so, nil
}

func (s *postgresStore) DeleteSystem(id string) (bool, error) {
	res, err := s.db.Exec("DELETE FROM systems WHERE id = $1", id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *postgresStore) CountUsers() (int, error) {
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM users").Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// CreateUser 创建用户：
//   - u.Role 非空（管理员在后台创建）：使用显式角色；这类账号的密码由管理员设定，
//     MustChangePassword 为 true，首次登录必须先改密码
//   - u.Role 为空（公开注册引导）：单条 INSERT 原子判定——表为空 → admin，否则 member
func (s *postgresStore) CreateUser(u *User) error {
	if u.ID == "" {
		u.ID = newID()
	}
	u.CreatedAt = time.Now()
	u.DisplayName = strings.TrimSpace(u.DisplayName)
	u.Department = strings.TrimSpace(u.Department)
	u.JobRole = defaultJobRole(u.JobRole)
	if u.Role == "admin" || u.Role == "member" {
		_, err := s.db.Exec(
			`INSERT INTO users (id, username, password_hash, role, display_name, department, job_role, must_change_password, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			u.ID, u.Username, u.PasswordHash, u.Role, u.DisplayName, u.Department, u.JobRole, u.MustChangePassword, u.CreatedAt)
		return err
	}
	return s.db.QueryRow(`
		INSERT INTO users (id, username, password_hash, role, display_name, department, job_role, must_change_password, created_at)
		VALUES ($1, $2, $3,
		        CASE WHEN (SELECT count(*) FROM users) = 0 THEN 'admin' ELSE 'member' END,
		        $4, $5, $6, FALSE, $7)
		RETURNING role`, u.ID, u.Username, u.PasswordHash, u.DisplayName, u.Department, u.JobRole, u.CreatedAt,
	).Scan(&u.Role)
}
func (s *postgresStore) GetUserByID(id string) (*User, error) {
	var u User
	err := s.db.QueryRow(userCols+` WHERE id = $1`, id).
		Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt, &u.MustChangePassword)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
func (s *postgresStore) DeleteUser(id string) (bool, error) {
	res, err := s.db.Exec("DELETE FROM users WHERE id = $1", id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *postgresStore) CountAdmins() (int, error) {
	var n int
	if err := s.db.QueryRow("SELECT count(*) FROM users WHERE role = 'admin'").Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func (s *postgresStore) GetUserByUsername(username string) (*User, error) {
	var u User
	err := s.db.QueryRow(userCols+` WHERE username = $1`, username).
		Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt, &u.MustChangePassword)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
func (s *postgresStore) ListUsers() ([]*User, error) {
	rows, err := s.db.Query(userCols + " ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.DisplayName, &u.Department, &u.JobRole, &u.CreatedAt, &u.MustChangePassword); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

// SeedSystemsFromProcesses 首次启用系统库时，从既有流程的 systemName 归集去重播种
func (s *postgresStore) SeedSystemsFromProcesses() error {
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM systems").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	list, err := s.List()
	if err != nil {
		return err
	}
	names := map[string]bool{}
	for _, p := range list {
		for _, step := range p.Steps {
			if name := step.Online.SystemName; name != "" {
				names[name] = true
			}
			for _, party := range step.Parties {
				for _, sub := range party.SubSteps {
					if name := sub.Online.SystemName; name != "" {
						names[name] = true
					}
				}
			}
		}
	}
	for name := range names {
		if _, err := s.CreateSystem(name); err != nil {
			return err
		}
	}
	if len(names) > 0 {
		log.Printf("已从既有流程归集 %d 个线上系统名称", len(names))
	}
	return nil
}

func (s *postgresStore) Close() error { return s.db.Close() }

func (s *postgresStore) Update(p *Process) error {
	steps, err := json.Marshal(p.Steps)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE processes SET name = $2, description = $3, applicant = $4,
		steps = $5::jsonb, updated_at = now() WHERE id = $1`,
		p.ID, p.Name, p.Description, p.Applicant, string(steps))
	return err
}

func (s *postgresStore) ListLegacyEvents() ([]*FollowEvent, error) {
	rows, err := s.db.Query(`SELECT id, process_id, actor_id, actor_name, kind, detail, created_at
		FROM followup_events ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*FollowEvent{}
	for rows.Next() {
		var e FollowEvent
		var detail []byte
		if err := rows.Scan(&e.ID, &e.ProcessID, &e.ActorID, &e.ActorName, &e.Kind, &detail, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Detail = detail
		list = append(list, &e)
	}
	return list, rows.Err()
}

// Overview 大屏一期聚合:累计收集 / 跟进中(含待验收) / 完成 / 本月新增

// migrateFromJSON 首次切换到数据库时，把 JSON 文件中的历史数据导入；
// 仅当表为空且文件存在时执行，导入完成后将文件改名为 .migrated 防止重复。
func (s *postgresStore) migrateFromJSON(path string) error {
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM processes").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return nil
	}
	var items []*Process
	if err := json.Unmarshal(data, &items); err != nil {
		return fmt.Errorf("历史 JSON 数据解析失败: %w", err)
	}
	for _, p := range items {
		if p.ID == "" {
			p.ID = newID()
		}
		if _, err := s.Create(p); err != nil {
			return fmt.Errorf("迁移流程 %q 失败: %w", p.Name, err)
		}
	}
	log.Printf("已从 %s 迁移 %d 条历史流程至 PostgreSQL", path, len(items))
	return os.Rename(path, path+".migrated")
}

// newID 生成 32 位十六进制随机 ID
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
