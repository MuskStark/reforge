package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
)

const versionCols = `v.id, v.process_id, COALESCE(v.project_id,''), v.version, v.kind, v.metrics, v.note,
	COALESCE(NULLIF(u.display_name,''), u.username, '系统'), v.created_at`

func scanVersion(sc scanner, withSteps bool) (*ProcessVersion, error) {
	var v ProcessVersion
	var metrics []byte
	var steps sql.NullString
	dest := []any{&v.ID, &v.ProcessID, &v.ProjectID, &v.Version, &v.Kind, &metrics, &v.Note, &v.CreatedByName, &v.CreatedAt}
	if withSteps {
		dest = append(dest, &steps)
	}
	if err := sc.Scan(dest...); err != nil {
		return nil, err
	}
	v.Metrics = rawOrNull(metrics)
	if withSteps && steps.Valid {
		v.Steps = json.RawMessage(steps.String)
	}
	return &v, nil
}

// handleVersions 流程版本列表:As-Is、To-Be 基线、已发布,每个版本带当时的流程改善指标
func (s *postgresStore) handleVersions(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT `+versionCols+` FROM process_versions v
		LEFT JOIN users u ON u.id = v.created_by WHERE v.project_id = $1 ORDER BY v.version ASC`, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer rows.Close()
	out := []*ProcessVersion{}
	for rows.Next() {
		v, err := scanVersion(rows, false)
		if err != nil {
			writeErr(w, r, err)
			return
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleVersionSteps 某个版本的完整步骤
func (s *postgresStore) handleVersionSteps(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	n, err := strconv.Atoi(r.PathValue("version"))
	if err != nil || n < 1 {
		writeError(w, http.StatusBadRequest, "版本号不合法")
		return
	}
	v, err := scanVersion(s.db.QueryRowContext(r.Context(), `SELECT `+versionCols+`, v.steps::text
		FROM process_versions v LEFT JOIN users u ON u.id = v.created_by
		WHERE v.project_id = $1 AND v.version = $2`, pathID(r), n), true)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "版本不存在")
		return
	}
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleCompare 立项时的 As-Is 与当前工作副本(To-Be)的流程改善指标对比
func (s *postgresStore) handleCompare(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	pr, err := getProject(r.Context(), s.db, pathID(r), false)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if pr == nil {
		writeError(w, http.StatusNotFound, "项目不存在")
		return
	}
	asIs, err := scanVersion(s.db.QueryRowContext(r.Context(), `SELECT `+versionCols+` FROM process_versions v
		LEFT JOIN users u ON u.id = v.created_by
		WHERE v.project_id = $1 AND v.kind = 'as_is' ORDER BY v.version ASC LIMIT 1`, pr.ID), false)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeErr(w, r, err)
		return
	}
	p, err := processStepsTx(r.Context(), s.db, pr.ProcessID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"asIs":    asIs, // 没有快照时为 null
		"current": ComputeMetrics(p.Steps),
	})
}
