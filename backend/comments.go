package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
)

var mentionRe = regexp.MustCompile(`@([^\s@，,。；;：:！!？?、（）()「」]+)`)

// parseMentions 解析正文里的 @显示名 / @用户名,返回被提及的用户
func parseMentions(body string, users []*User) []*User {
	tokens := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(body, -1) {
		tokens[strings.TrimSpace(m[1])] = true
	}
	var out []*User
	seen := map[string]bool{}
	for _, u := range users {
		if seen[u.ID] {
			continue
		}
		if tokens[u.Username] || (u.DisplayName != "" && tokens[u.DisplayName]) {
			seen[u.ID] = true
			out = append(out, u)
		}
	}
	return out
}

const commentCols = `c.id, c.project_id, COALESCE(c.item_id,''), COALESCE(w.title,''), COALESCE(c.review_id,''),
	c.kind, c.body, c.structured, c.mentions, c.author_id, COALESCE(u.username,''), COALESCE(u.display_name,''), c.created_at`

func scanComment(sc scanner) (*Comment, error) {
	var c Comment
	var structured, mentions []byte
	var uname, dname string
	if err := sc.Scan(&c.ID, &c.ProjectID, &c.ItemID, &c.ItemTitle, &c.ReviewID, &c.Kind, &c.Body, &structured, &mentions,
		&c.AuthorID, &uname, &dname, &c.CreatedAt); err != nil {
		return nil, err
	}
	c.Structured, c.Mentions = rawOrNull(structured), rawOrNull(mentions)
	c.AuthorName, c.AuthorDisplay = uname, displayNameOr(dname, uname)
	return &c, nil
}

func (s *postgresStore) handleListComments(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT `+commentCols+`
		FROM comments c LEFT JOIN work_items w ON w.id = c.item_id LEFT JOIN users u ON u.id = c.author_id
		WHERE c.project_id = $1 ORDER BY c.created_at DESC LIMIT 200`, pathID(r))
	if err != nil {
		writeErr(w, err)
		return
	}
	defer rows.Close()
	out := []*Comment{}
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			writeErr(w, err)
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *postgresStore) handleCreateComment(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ItemID string `json:"itemId"`
		Body   string `json:"body"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Body = trimRunes(body.Body, 4000)
	if body.Body == "" {
		writeError(w, http.StatusBadRequest, "评论内容不能为空")
		return
	}
	users, err := s.ListUsers()
	if err != nil {
		writeErr(w, err)
		return
	}
	mentioned := parseMentions(body.Body, users)
	mIDs := make([]string, 0, len(mentioned))
	for _, u := range mentioned {
		mIDs = append(mIDs, u.ID)
	}
	mentionsJSON, _ := json.Marshal(mIDs)
	var out *Comment
	if !s.inProjectLock(w, r, pathID(r), func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		if !c.member() {
			return noPermission()
		}
		var assignee string
		if body.ItemID != "" {
			var pid string
			err := tx.QueryRowContext(ctx, `SELECT project_id, COALESCE(assignee_id,'') FROM work_items WHERE id = $1`, body.ItemID).Scan(&pid, &assignee)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && pid != pr.ID) {
				return badRequest("工作项不存在")
			}
			if err != nil {
				return err
			}
		}
		id := newID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO comments (id, project_id, item_id, kind, body, mentions, author_id, created_at)
			VALUES ($1, $2, NULLIF($3,''), 'comment', $4, $5::jsonb, $6, now())`,
			id, pr.ID, body.ItemID, body.Body, string(mentionsJSON), a.ID); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "comment", id, a, "comment_added", map[string]any{
			"itemId": body.ItemID, "excerpt": excerpt(body.Body, 80),
		}); err != nil {
			return err
		}
		for _, u := range mentioned {
			if u.ID == a.ID {
				continue
			}
			if err := notifyTx(ctx, tx, u.ID, "mentioned", pr.ID, body.ItemID, "",
				a.name()+" 在「"+pr.Name+"」提到了你", "mentioned:"+id+":"+u.ID); err != nil {
				return err
			}
		}
		if assignee != "" && assignee != a.ID {
			already := false
			for _, u := range mentioned {
				if u.ID == assignee {
					already = true
				}
			}
			if !already {
				if err := notifyTx(ctx, tx, assignee, "commented", pr.ID, body.ItemID, "",
					a.name()+" 评论了你负责的工作项", "commented:"+id+":"+assignee); err != nil {
					return err
				}
			}
		}
		cm, err := scanComment(tx.QueryRowContext(ctx, `SELECT `+commentCols+`
			FROM comments c LEFT JOIN work_items w ON w.id = c.item_id LEFT JOIN users u ON u.id = c.author_id
			WHERE c.id = $1`, id))
		out = cm
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// excerpt 取正文前 n 个字符(时间线摘要用)
func excerpt(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n]) + "…"
}

// handleProjectUpdate 项目简报:四栏进展 + 健康度。健康度随简报更新(同 Linear / Plane 的做法)。
func (s *postgresStore) handleProjectUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Progress string `json:"progress"`
		Next     string `json:"next"`
		Risks    string `json:"risks"`
		Help     string `json:"help"`
		Health   string `json:"health"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Progress, body.Next, body.Risks, body.Help = trimRunes(body.Progress, 2000), trimRunes(body.Next, 2000), trimRunes(body.Risks, 2000), trimRunes(body.Help, 2000)
	if body.Progress == "" && body.Next == "" && body.Risks == "" && body.Help == "" {
		writeError(w, http.StatusBadRequest, "简报内容不能为空")
		return
	}
	if !validHealths[body.Health] {
		writeError(w, http.StatusBadRequest, "健康度取值不合法")
		return
	}
	structured, _ := json.Marshal(map[string]string{
		"progress": body.Progress, "next": body.Next, "risks": body.Risks, "help": body.Help,
	})
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	text := body.Progress
	if body.Next != "" {
		text += "\n下期计划：" + body.Next
	}
	if body.Risks != "" {
		text += "\n风险与阻塞：" + body.Risks
	}
	if body.Help != "" {
		text += "\n需要的支持：" + body.Help
	}
	if !s.inProjectLock(w, r, pathID(r), func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		if !c.manage() {
			return noPermission()
		}
		if pr.Status != ProjActive {
			return badRequest("项目不在进行中，无需写简报")
		}
		id := newID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO comments (id, project_id, kind, body, structured, mentions, author_id, created_at)
			VALUES ($1, $2, 'update', $3, $4::jsonb, '[]', $5, now())`,
			id, pr.ID, text, string(structured), a.ID); err != nil {
			return err
		}
		previous := pr.Health
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET health = $2 WHERE id = $1`, pr.ID, body.Health); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "comment", id, a, "project_update", map[string]any{
			"health": body.Health, "previous": previous, "excerpt": excerpt(body.Progress, 80),
		}); err != nil {
			return err
		}
		if body.Health != "on_track" {
			ctos, err := usersWithJobTx(ctx, tx, RoleCTO)
			if err != nil {
				return err
			}
			label := map[string]string{"at_risk": "有风险", "off_track": "已偏离"}[body.Health]
			if err := notifyManyTx(ctx, tx, userIDs(ctos), "health", pr.ID, "", "",
				"「"+pr.Name+"」简报：健康度标为「"+label+"」", "health:"+id); err != nil {
				return err
			}
		}
		// 刚写过简报,清掉本周的"简报到期"提醒
		_, err := tx.ExecContext(ctx, `DELETE FROM notifications
			WHERE user_id = $2 AND dedupe_key LIKE 'update_due:' || $1 || ':%'`, pr.ID, a.ID)
		return err
	}) {
		return
	}
	s.writeProject(w, r, a, pathID(r))
}
