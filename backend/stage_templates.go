package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// stageTemplateSchema 阶段模板表,以及项目上的模板快照列(幂等)
const stageTemplateSchema = `
CREATE TABLE IF NOT EXISTS stage_templates (
  seq           SMALLINT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  gate          TEXT NOT NULL DEFAULT '',
  reviewer_role TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL DEFAULT '',
  required      JSONB NOT NULL DEFAULT '[]',
  tasks         JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ NOT NULL
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS template JSONB NOT NULL DEFAULT '[]';`

const templateCols = `key, name, gate, reviewer_role, mode, required, tasks`

// loadStageTemplates 当前生效的阶段模板(按阶段序号)。表里没有数据时用内置模板兜底。
func loadStageTemplates(ctx context.Context, q runner) ([]StageTemplate, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+templateCols+` FROM stage_templates ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StageTemplate{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		t.Seq = len(out) + 1
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return defaultStageTemplates(), nil
	}
	return out, nil
}

func scanTemplate(sc scanner) (*StageTemplate, error) {
	var t StageTemplate
	var req, tasks []byte
	if err := sc.Scan(&t.Key, &t.Name, &t.Gate, &t.ReviewerRole, &t.Mode, &req, &tasks); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(req, &t.Required)
	_ = json.Unmarshal(tasks, &t.Tasks)
	if t.Required == nil {
		t.Required = []string{}
	}
	if t.Tasks == nil {
		t.Tasks = []string{}
	}
	return &t, nil
}

// insertStageTemplates 在事务里按序号写入模板;ignoreConflicts 用于首次启动时容忍并发引导
func insertStageTemplates(ctx context.Context, tx *sql.Tx, tpl []StageTemplate, ignoreConflicts bool) error {
	conflict := ""
	if ignoreConflicts {
		conflict = " ON CONFLICT DO NOTHING"
	}
	for _, t := range tpl {
		req, _ := json.Marshal(t.Required)
		tasks, _ := json.Marshal(t.Tasks)
		if _, err := tx.ExecContext(ctx, `INSERT INTO stage_templates
			(seq, key, name, gate, reviewer_role, mode, required, tasks, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now())`+conflict,
			t.Seq, t.Key, t.Name, t.Gate, t.ReviewerRole, t.Mode, string(req), string(tasks)); err != nil {
			return err
		}
	}
	return nil
}

// ensureStageTemplates 首次启动时把内置模板写入 stage_templates。幂等。
func (s *postgresStore) ensureStageTemplates(ctx context.Context) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM stage_templates`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	return s.withTx(ctx, func(tx *sql.Tx) error {
		return insertStageTemplates(ctx, tx, defaultStageTemplates(), true)
	})
}

// replaceStageTemplates 用新模板整体替换旧模板。只改表:已立项的项目用自己的快照,不受影响。
func replaceStageTemplates(ctx context.Context, tx *sql.Tx, tpl []StageTemplate) error {
	// 同一时刻只有一个管理员能改模板(表里没有固定的行可以锁,用事务级咨询锁)
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(7231042)`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM stage_templates`); err != nil {
		return err
	}
	return insertStageTemplates(ctx, tx, tpl, false)
}

// projectTemplateTx 某项目立项时的模板快照
func projectTemplateTx(ctx context.Context, q runner, projectID string) ([]StageTemplate, error) {
	var raw []byte
	err := q.QueryRowContext(ctx, `SELECT template FROM projects WHERE id = $1`, projectID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultStageTemplates(), nil
	}
	if err != nil {
		return nil, err
	}
	return parseTemplate(raw), nil
}

// ---- 后台接口(仅系统管理员) ----

func registerStageTemplateRoutes(mux *http.ServeMux, st *postgresStore) {
	mux.HandleFunc("GET /api/admin/stage-templates", st.handleGetStageTemplates)
	mux.HandleFunc("PUT /api/admin/stage-templates", st.handlePutStageTemplates)
}

func (s *postgresStore) handleGetStageTemplates(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	// ?builtin=1:取内置模板(后台"恢复内置模板"用),不读表
	if r.URL.Query().Get("builtin") == "1" {
		writeJSON(w, http.StatusOK, defaultStageTemplates())
		return
	}
	tpl, err := loadStageTemplates(r.Context(), s.db)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, tpl)
}

// handlePutStageTemplates 整体替换阶段模板:请求体 {templates:[{key,name,gate,reviewerRole,mode,required,tasks}]}
func (s *postgresStore) handlePutStageTemplates(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body struct {
		Templates []StageTemplate `json:"templates"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	tpl, err := normalizeStageTemplates(body.Templates)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	err = s.withTx(r.Context(), func(tx *sql.Tx) error {
		return replaceStageTemplates(r.Context(), tx, tpl)
	})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	audit(r, "template.replace", "stages", len(tpl), "note", "只影响此后新建的项目")
	writeJSON(w, http.StatusOK, tpl)
}
