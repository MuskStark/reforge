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
	// 技术可行性评估可以在表决的同一笔请求里带上各技术点的结论,先存结论再表决
	var body struct {
		Decision string            `json:"decision"`
		Comment  string            `json:"comment"`
		Points   []assessmentInput `json:"points"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	projectID, ok := s.projectOfReview(w, r)
	if !ok {
		return
	}
	reviewID := pathID(r)
	outcome := ""
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		// 需求承接的技术可行性评估:表决的同一笔请求里可以带上各技术点的结论。先判资格——权限校验先于
		// 状态校验,无权的人拿不到评估的内容;再存结论、核对是否齐备。表决本身仍走 decideReviewTx
		if st, ok := pr.intakeStage(); ok && currentStageOfIs(pr, stages, st.Seq) {
			rv, err := reviewAccessTx(ctx, tx, pr, reviewID, a, c)
			if err != nil {
				return err
			}
			// 状态校验在权限之后、结论是否齐备之前:已结束的项目与评审,不论结论如何都不再受理
			if pr.Status != ProjActive {
				return conflict("项目已结束，评审不再受理")
			}
			if rv.Status != ReviewPending {
				return conflict("这一轮评审已经结束")
			}
			if err := saveAssessmentsTx(ctx, tx, pr, rv, a, c, body.Points); err != nil {
				return err
			}
			// 要通过,每个技术点都得有结论:附条件的写明条件,不可行的给出替代方案
			if body.Decision == DecisionApprove && a.ID != "" {
				problem, err := assessmentProblemTx(ctx, tx, pr.ID, reviewID, a.ID)
				if err != nil {
					return err
				}
				if problem != "" {
					return badRequest("还不能通过：" + problem)
				}
			}
		} else if len(body.Points) > 0 {
			return badRequest("只有技术可行性评估可以给技术点下结论")
		}
		var err error
		outcome, err = decideReviewTx(ctx, tx, pr, stages, reviewID, a, c, body.Decision, trimRunes(body.Comment, 2000))
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": outcome})
}

// currentStageOfIs 项目当前阶段是否正是指定序号的阶段、且在评审中
func currentStageOfIs(pr *Project, stages []ProjectStage, seq int) bool {
	cur, ok := currentStageOf(pr, stages)
	return ok && cur.Seq == seq && cur.Status == StageInReview
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
