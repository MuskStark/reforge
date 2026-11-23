package main

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"time"
)

// timeNowKey 需要每次触发都通知一次的场景用的幂等键后缀(精确到毫秒)
func timeNowKey() string { return time.Now().Format("20060102150405.000") }

type notificationView struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	ReviewID  string     `json:"reviewId"`
	Title     string     `json:"title"`
	ReadAt    *time.Time `json:"readAt"`
	CreatedAt time.Time  `json:"createdAt"`
}

// handleNotifications GET /api/notifications?unread=1 —— 我的通知;响应 {list, unread}
func (s *postgresStore) handleNotifications(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	if a.ID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"list": []*notificationView{}, "unread": 0})
		return
	}
	where := ` WHERE n.user_id = $1`
	if r.URL.Query().Get("unread") == "1" {
		where += ` AND n.read_at IS NULL`
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT n.id, n.kind, COALESCE(n.project_id,''), COALESCE(n.item_id,''),
		COALESCE(n.review_id,''), n.title, n.read_at, n.created_at FROM notifications n`+where+
		` ORDER BY n.created_at DESC LIMIT 100`, a.ID)
	if err != nil {
		writeErr(w, err)
		return
	}
	defer rows.Close()
	list := []*notificationView{}
	for rows.Next() {
		var n notificationView
		if err := rows.Scan(&n.ID, &n.Kind, &n.ProjectID, &n.ItemID, &n.ReviewID, &n.Title, &n.ReadAt, &n.CreatedAt); err != nil {
			writeErr(w, err)
			return
		}
		list = append(list, &n)
	}
	if err := rows.Err(); err != nil {
		writeErr(w, err)
		return
	}
	var unread int
	_ = s.db.QueryRowContext(r.Context(), `SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`, a.ID).Scan(&unread)
	writeJSON(w, http.StatusOK, map[string]any{"list": list, "unread": unread})
}

// handleReadNotifications POST /api/notifications/read —— {id} 标记单条已读;{all:true} 全部已读
func (s *postgresStore) handleReadNotifications(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	var body struct {
		ID  string `json:"id"`
		All bool   `json:"all"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if a.ID != "" {
		var err error
		if body.All {
			_, err = s.db.ExecContext(r.Context(), `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, a.ID)
		} else if body.ID != "" {
			_, err = s.db.ExecContext(r.Context(), `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = $2`, a.ID, body.ID)
		}
		if err != nil {
			writeErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- 定时调度:逾期、评审积压、简报到期 ----

// startScheduler 每分钟扫描一次。单实例部署;多实例时同一通知有幂等键兜底,不会重复入库。
func startScheduler(st *postgresStore) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			func() {
				defer func() {
					if v := recover(); v != nil {
						log.Printf("[scheduler] panic: %v", v)
					}
				}()
				if err := runScheduledJobs(context.Background(), st); err != nil {
					log.Printf("[scheduler] 执行失败: %v", err)
				}
			}()
		}
	}()
}

// runScheduledJobs 依次执行各项扫描;每项只发当日一次通知(dedupe_key 带日期)
func runScheduledJobs(ctx context.Context, st *postgresStore) error {
	if err := scanOverdueItems(ctx, st); err != nil {
		return err
	}
	if err := scanOverdueStages(ctx, st); err != nil {
		return err
	}
	if err := scanReviewAging(ctx, st); err != nil {
		return err
	}
	return scanUpdateDue(ctx, st)
}

func todayKey() string { return time.Now().Format("20060102") }

// scanOverdueItems 逾期且未完成的工作项:通知负责人;同时知会该项目的项目经理
func scanOverdueItems(ctx context.Context, st *postgresStore) error {
	rows, err := st.db.QueryContext(ctx, `SELECT w.id, w.project_id, pr.name, w.title, COALESCE(w.assignee_id,''), w.due_date::text
		FROM work_items w JOIN projects pr ON pr.id = w.project_id
		WHERE pr.status = 'active' AND w.status IN ('todo','in_progress','blocked','in_review')
		  AND w.due_date IS NOT NULL AND w.due_date < CURRENT_DATE
		ORDER BY w.due_date`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct{ id, pid, pname, title, assignee, due string }
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.pid, &x.pname, &x.title, &x.assignee, &x.due); err != nil {
			return err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		err := st.withTx(ctx, func(tx *sql.Tx) error {
			if x.assignee != "" {
				if err := notifyTx(ctx, tx, x.assignee, "overdue", x.pid, x.id, "",
					"「"+x.title+"」已逾期（截止 "+x.due+"）", "item_overdue:"+x.id+":"+todayKey()); err != nil {
					return err
				}
			}
			pms, err := memberUserIDsByRoleTx(ctx, tx, x.pid, RolePM)
			if err != nil {
				return err
			}
			return notifyManyTx(ctx, tx, pms, "overdue", x.pid, x.id, "",
				"「"+x.pname+"」的工作项「"+x.title+"」已逾期", "item_overdue_pm")
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func memberUserIDsByRoleTx(ctx context.Context, q runner, projectID, role string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT user_id FROM project_members WHERE project_id = $1 AND role = $2`, projectID, role)
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

// scanOverdueStages 当前阶段已过截止日:通知项目经理,知会 CTO
func scanOverdueStages(ctx context.Context, st *postgresStore) error {
	rows, err := st.db.QueryContext(ctx, `SELECT pr.id, pr.name, pr.current_stage, ps.due_date::text, pr.template
		FROM projects pr JOIN project_stages ps ON ps.project_id = pr.id AND ps.seq = pr.current_stage
		WHERE pr.status = 'active' AND ps.status IN ('in_progress','in_review')
		  AND ps.due_date IS NOT NULL AND ps.due_date < CURRENT_DATE`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		pid, pname string
		seq        int
		due        string
		tpl        []byte
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.pid, &x.pname, &x.seq, &x.due, &x.tpl); err != nil {
			return err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		err := st.withTx(ctx, func(tx *sql.Tx) error {
			pms, err := memberUserIDsByRoleTx(ctx, tx, x.pid, RolePM)
			if err != nil {
				return err
			}
			text := "「" + x.pname + "」的阶段「" + stageNameIn(parseTemplate(x.tpl), x.seq) + "」已逾期（截止 " + x.due + "）"
			if err := notifyManyTx(ctx, tx, pms, "overdue", x.pid, "", "", text, "stage_overdue:"+todayKey()); err != nil {
				return err
			}
			ctos, err := usersWithJobTx(ctx, tx, RoleCTO)
			if err != nil {
				return err
			}
			return notifyManyTx(ctx, tx, userIDs(ctos), "overdue", x.pid, "", "", text, "stage_overdue_cto:"+todayKey())
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// scanReviewAging 待决超过 3 天的评审:提醒还没投票的评审人,知会管理员
func scanReviewAging(ctx context.Context, st *postgresStore) error {
	rows, err := st.db.QueryContext(ctx, `SELECT r.id, pr.id, pr.name, r.stage_seq, pr.template
		FROM gate_reviews r JOIN projects pr ON pr.id = r.project_id
		WHERE r.status = 'pending' AND pr.status = 'active' AND r.submitted_at < now() - interval '3 days'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		rid, pid, pname string
		seq             int
		tpl             []byte
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.rid, &x.pid, &x.pname, &x.seq, &x.tpl); err != nil {
			return err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		err := st.withTx(ctx, func(tx *sql.Tx) error {
			ids, err := reviewerUserIDsTx(ctx, tx, x.rid)
			if err != nil {
				return err
			}
			t, _ := templateAt(parseTemplate(x.tpl), x.seq)
			text := "「" + x.pname + "」的 " + t.Gate + " 已等待超过 3 天"
			if err := notifyManyTx(ctx, tx, ids, "review_aging", x.pid, "", x.rid, text, "review_aging:"+x.rid+":"+todayKey()); err != nil {
				return err
			}
			admins, err := usersWithRoleTx(ctx, tx, "admin")
			if err != nil {
				return err
			}
			return notifyManyTx(ctx, tx, userIDs(admins), "review_aging", x.pid, "", x.rid, text, "review_aging_admin:"+x.rid+":"+todayKey())
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// scanUpdateDue 在途项目超过 7 天没有简报:每周提醒一次项目经理
func scanUpdateDue(ctx context.Context, st *postgresStore) error {
	year, week := time.Now().ISOWeek()
	key := func(pid string) string { return "update_due:" + pid + ":" + itoa(year) + itoa(week) }
	rows, err := st.db.QueryContext(ctx, `SELECT pr.id, pr.name,
		(SELECT max(c.created_at) FROM comments c WHERE c.project_id = pr.id AND c.kind = 'update')
		FROM projects pr WHERE pr.status = 'active' AND pr.current_stage > 1`) // 分析立项阶段较短,不要求简报
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		pid, pname string
		last       sql.NullTime
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.pid, &x.pname, &x.last); err != nil {
			return err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, x := range all {
		if x.last.Valid && time.Since(x.last.Time) < 7*24*time.Hour {
			continue
		}
		err := st.withTx(ctx, func(tx *sql.Tx) error {
			pms, err := memberUserIDsByRoleTx(ctx, tx, x.pid, RolePM)
			if err != nil {
				return err
			}
			return notifyManyTx(ctx, tx, pms, "update_due", x.pid, "", "",
				"「"+x.pname+"」已超过 7 天没有简报，请更新进展", key(x.pid))
		})
		if err != nil {
			return err
		}
	}
	return nil
}
