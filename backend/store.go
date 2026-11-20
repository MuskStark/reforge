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
	// CreateUser 原子创建用户：表为空时角色自动为 admin（首个注册用户即管理员）
	CreateUser(u *User) error
	GetUserByUsername(username string) (*User, error)
	ListUsers() ([]*User, error)
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
	created_at    TIMESTAMPTZ NOT NULL
);`

// newStore 依据 DATABASE_URL（默认本机 Docker Postgres）建立存储；
// 表为空且存在历史 JSON 文件时自动做一次数据迁移。
func newStore(dsn string) (store, error) {
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

	s := &postgresStore{db: db}
	if err := s.migrateFromJSON("data/processes.json"); err != nil {
		db.Close()
		return nil, err
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

const listCols = "id, name, description, applicant, steps, created_at, updated_at"

func scanProcess(row interface{ Scan(...any) error }) (*Process, error) {
	var p Process
	var steps []byte
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.Applicant, &steps, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(steps, &p.Steps); err != nil {
		return nil, fmt.Errorf("解析步骤数据失败: %w", err)
	}
	return &p, nil
}

func (s *postgresStore) List() ([]*Process, error) {
	rows, err := s.db.Query("SELECT " + listCols + " FROM processes ORDER BY created_at DESC")
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
	p, err := scanProcess(s.db.QueryRow("SELECT "+listCols+" FROM processes WHERE id = $1", id))
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

func (s *postgresStore) Delete(id string) (bool, error) {
	res, err := s.db.Exec("DELETE FROM processes WHERE id = $1", id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
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

// CreateUser 单条 INSERT 原子判定角色：表为空 → admin，否则 member（规避并发竞态）
func (s *postgresStore) CreateUser(u *User) error {
	if u.ID == "" {
		u.ID = newID()
	}
	u.CreatedAt = time.Now()
	return s.db.QueryRow(`
		INSERT INTO users (id, username, password_hash, role, created_at)
		VALUES ($1, $2, $3,
		        CASE WHEN (SELECT count(*) FROM users) = 0 THEN 'admin' ELSE 'member' END,
		        $4)
		RETURNING role`, u.ID, u.Username, u.PasswordHash, u.CreatedAt,
	).Scan(&u.Role)
}

func (s *postgresStore) GetUserByUsername(username string) (*User, error) {
	var u User
	err := s.db.QueryRow(
		"SELECT id, username, password_hash, role, created_at FROM users WHERE username = $1", username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *postgresStore) ListUsers() ([]*User, error) {
	rows, err := s.db.Query("SELECT id, username, password_hash, role, created_at FROM users ORDER BY created_at ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.CreatedAt); err != nil {
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
