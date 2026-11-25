package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

// inProjectLock 项目接口的公共骨架:取登录人 → 开事务并锁项目行 → 解析其在该项目的能力 → 执行 fn。
// 出错时已写好响应,返回 false。
func (s *postgresStore) inProjectLock(w http.ResponseWriter, r *http.Request, projectID string,
	fn func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error) bool {
	a, ok := currentActor(w, r, s)
	if !ok {
		return false
	}
	err := s.withProjectLock(r.Context(), projectID, func(tx *sql.Tx, pr *Project, stages []ProjectStage) error {
		c, err := loadCaps(r.Context(), tx, pr.ID, a)
		if err != nil {
			return err
		}
		return fn(r.Context(), tx, pr, stages, a, c)
	})
	if err != nil {
		writeErr(w, r, err)
		return false
	}
	return true
}

// projectOfReview 评审所属的项目
func (s *postgresStore) projectOfReview(w http.ResponseWriter, r *http.Request) (string, bool) {
	var id string
	err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM gate_reviews WHERE id = $1`, pathID(r)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "评审不存在")
		return "", false
	}
	if err != nil {
		writeErr(w, r, err)
		return "", false
	}
	return id, true
}

func (s *postgresStore) handleSubmitReview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Summary string `json:"summary"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	var out *GateReview
	if !s.inProjectLock(w, r, pathID(r), func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		var err error
		out, err = submitReviewTx(ctx, tx, pr, stages, a, c, trimRunes(body.Summary, 2000))
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *postgresStore) handleDecideReview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Decision string `json:"decision"`
		Comment  string `json:"comment"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	projectID, ok := s.projectOfReview(w, r)
	if !ok {
		return
	}
	outcome := ""
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		var err error
		outcome, err = decideReviewTx(ctx, tx, pr, stages, pathID(r), a, c, body.Decision, trimRunes(body.Comment, 2000))
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": outcome})
}

func (s *postgresStore) handleWithdrawReview(w http.ResponseWriter, r *http.Request) {
	projectID, ok := s.projectOfReview(w, r)
	if !ok {
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		return withdrawReviewTx(ctx, tx, pr, stages, pathID(r), a, c)
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *postgresStore) handleListReviews(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	list, err := listReviewsTx(r.Context(), s.db, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *postgresStore) handlePendingReviews(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	list, err := myPendingReviews(r.Context(), s, a)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}
