package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const itemCols = `w.id, w.project_id, pr.name, COALESCE(w.stage_seq,0), w.type, w.title, w.body, w.status, w.priority,
	COALESCE(w.assignee_id,''), COALESCE(ua.display_name,''), COALESCE(ua.username,''),
	COALESCE(w.parent_id,''), COALESCE(w.due_date::text,''), w.block_reason, w.labels, w.checklist, w.required,
	w.done_at, w.sort_key, COALESCE(w.created_by,''), COALESCE(uc.display_name,''), COALESCE(uc.username,''),
	w.created_at, w.updated_at, w.version`

const itemFrom = ` FROM work_items w JOIN projects pr ON pr.id = w.project_id
	LEFT JOIN users ua ON ua.id = w.assignee_id
	LEFT JOIN users uc ON uc.id = w.created_by`

func scanItem(sc scanner) (*WorkItem, error) {
	var it WorkItem
	var labels, checklist []byte
	var done sql.NullTime
	var ad, au, cd, cu string
	if err := sc.Scan(&it.ID, &it.ProjectID, &it.ProjectName, &it.StageSeq, &it.Type, &it.Title, &it.Body, &it.Status, &it.Priority,
		&it.AssigneeID, &ad, &au, &it.ParentID, &it.DueDate, &it.BlockReason, &labels, &checklist, &it.Required,
		&done, &it.SortKey, &it.CreatedBy, &cd, &cu, &it.CreatedAt, &it.UpdatedAt, &it.Version); err != nil {
		return nil, err
	}
	it.AssigneeName, it.AssigneeDisplay = au, displayNameOr(ad, au)
	it.CreatedByName = displayNameOr(cd, cu)
	it.Labels, it.Checklist, it.DoneAt = rawOrNull(labels), rawOrNull(checklist), nullTimePtr(done)
	it.Children, it.Links = []WorkItem{}, []ItemLink{}
	return &it, nil
}

func queryItems(ctx context.Context, q runner, query string, args ...any) ([]*WorkItem, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*WorkItem{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// attachLinks 给一组工作项补上关系:out = 我阻塞/关联的别人;in = 别人阻塞我
func attachLinks(ctx context.Context, q runner, items []*WorkItem) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.ID)
	}
	byID := map[string]*WorkItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	rows, err := q.QueryContext(ctx, `SELECT l.from_id, l.to_id, l.kind, w.title, w.status
		FROM work_item_links l JOIN work_items w ON w.id = l.to_id
		WHERE l.from_id = ANY($1)
		UNION
		SELECT l.from_id, l.to_id, l.kind, w.title, w.status
		FROM work_item_links l JOIN work_items w ON w.id = l.from_id
		WHERE l.to_id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var from, to, kind, title, status string
		if err := rows.Scan(&from, &to, &kind, &title, &status); err != nil {
			return err
		}
		if it := byID[from]; it != nil {
			it.Links = append(it.Links, ItemLink{ToID: to, ToTitle: title, ToStatus: status, Kind: kind, Direction: "out"})
		}
		if it := byID[to]; it != nil {
			it.Links = append(it.Links, ItemLink{ToID: from, ToTitle: title, ToStatus: status, Kind: kind, Direction: "in"})
		}
	}
	return rows.Err()
}

// nestItems 平铺列表 → 父子结构(保持原顺序)
func nestItems(flat []*WorkItem) []*WorkItem {
	byID := map[string]*WorkItem{}
	for _, it := range flat {
		byID[it.ID] = it
	}
	out := []*WorkItem{}
	for _, it := range flat {
		if it.ParentID != "" {
			if parent := byID[it.ParentID]; parent != nil {
				parent.Children = append(parent.Children, *it)
				continue
			}
		}
		out = append(out, it)
	}
	return out
}

func (s *postgresStore) handleListItems(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	flat, err := queryItems(r.Context(), s.db, `SELECT `+itemCols+itemFrom+` WHERE w.project_id = $1
		ORDER BY w.stage_seq NULLS LAST, w.sort_key, w.created_at`, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if err := attachLinks(r.Context(), s.db, flat); err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, nestItems(flat))
}

func (s *postgresStore) handleMyItems(w http.ResponseWriter, r *http.Request) {
	a, ok := currentActor(w, r, s)
	if !ok {
		return
	}
	if a.ID == "" {
		writeJSON(w, http.StatusOK, []*WorkItem{})
		return
	}
	flat, err := queryItems(r.Context(), s.db, `SELECT `+itemCols+itemFrom+`
		WHERE w.assignee_id = $1 AND w.status IN ('todo','in_progress','blocked','in_review') AND pr.status = 'active'
		ORDER BY w.due_date NULLS LAST, w.created_at`, a.ID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, flat)
}

// canTouchItem 能否改动一条工作项:项目管理 者,或(仍是项目参与者的)负责人 / 创建人
func canTouchItem(c caps, it *WorkItem, a *actor) bool {
	return c.manage() || (c.member() && (it.AssigneeID == a.ID || it.CreatedBy == a.ID))
}

// validChecklist 校验清单结构 [{id,text,done}]
func validChecklist(raw []byte) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var list []struct {
		ID   string `json:"id"`
		Text string `json:"text"`
		Done bool   `json:"done"`
	}
	return json.Unmarshal(raw, &list) == nil && len(list) <= 50
}

func (s *postgresStore) handleCreateItem(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type       string          `json:"type"`
		Title      string          `json:"title"`
		Body       string          `json:"body"`
		StageSeq   int             `json:"stageSeq"`
		Priority   string          `json:"priority"`
		AssigneeID string          `json:"assigneeId"`
		ParentID   string          `json:"parentId"`
		DueDate    string          `json:"dueDate"`
		Checklist  json.RawMessage `json:"checklist"`
		Required   *bool           `json:"required"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	body.Title = trimRunes(body.Title, 200)
	if body.Title == "" {
		writeError(w, http.StatusBadRequest, "标题不能为空")
		return
	}
	if body.Type == "" {
		body.Type = ItemTask
	}
	if !validItemTypes[body.Type] {
		writeError(w, http.StatusBadRequest, "工作项类型不合法")
		return
	}
	if body.Priority == "" {
		body.Priority = "medium"
	}
	if !validPriorities[body.Priority] {
		writeError(w, http.StatusBadRequest, "优先级取值不合法")
		return
	}
	if body.DueDate != "" && !validDate(body.DueDate) {
		writeError(w, http.StatusBadRequest, "截止日格式应为 YYYY-MM-DD")
		return
	}
	if !validChecklist(body.Checklist) {
		writeError(w, http.StatusBadRequest, "清单格式不正确")
		return
	}
	checklist := "[]"
	if len(body.Checklist) > 0 && string(body.Checklist) != "null" {
		checklist = string(body.Checklist)
	}
	var created *WorkItem
	if !s.inProjectLock(w, r, pathID(r), func(ctx context.Context, tx *sql.Tx, pr *Project, stages []ProjectStage, a *actor, c caps) error {
		if !c.member() {
			return noPermission()
		}
		if body.AssigneeID != "" {
			u, err := s.GetUserByID(body.AssigneeID)
			if err != nil {
				return err
			}
			if u == nil {
				return badRequest("被指派人不存在")
			}
		}
		seq := body.StageSeq
		if seq == 0 {
			seq = pr.CurrentStage
		}
		if seq < 1 || seq > pr.stageCount() {
			return badRequest("所属阶段不合法")
		}
		if body.ParentID != "" {
			var parentProject string
			err := tx.QueryRowContext(ctx, `SELECT project_id FROM work_items WHERE id = $1`, body.ParentID).Scan(&parentProject)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && parentProject != pr.ID) {
				return badRequest("父工作项不存在")
			}
			if err != nil {
				return err
			}
		}
		required := false
		if body.Required != nil {
			if *body.Required && !c.manage() {
				return noPermission()
			}
			required = *body.Required
		}
		id := newID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO work_items
			(id, project_id, stage_seq, type, title, body, status, priority, assignee_id, parent_id, due_date, checklist, required, sort_key, created_by, created_at, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, NULLIF($8,''), NULLIF($9,''), NULLIF($10,'')::date, $11::jsonb, $12,
			        (SELECT COALESCE(MAX(sort_key), 0) + 1 FROM work_items WHERE project_id = $2), $13, now(), now())`,
			id, pr.ID, seq, body.Type, body.Title, trimRunes(body.Body, 8000), body.Priority,
			body.AssigneeID, body.ParentID, body.DueDate, checklist, required, a.ID); err != nil {
			return err
		}
		if err := addEventTx(ctx, tx, pr.ID, "item", id, a, "item_created", map[string]any{
			"title": body.Title, "type": body.Type, "stage": pr.stageName(seq), "assignee": body.AssigneeID != "",
		}); err != nil {
			return err
		}
		if body.AssigneeID != "" {
			if err := notifyTx(ctx, tx, body.AssigneeID, "item_assigned", pr.ID, id, "",
				"「"+pr.Name+"」给你指派了「"+body.Title+"」", "item_assigned:"+id+":"+body.AssigneeID+":"+timeNowKey()); err != nil {
				return err
			}
		}
		it, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, id))
		created = it
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *postgresStore) handlePatchItem(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title       *string         `json:"title"`
		Body        *string         `json:"body"`
		Status      *string         `json:"status"`
		Priority    *string         `json:"priority"`
		AssigneeID  *string         `json:"assigneeId"`
		StageSeq    *int            `json:"stageSeq"`
		DueDate     *string         `json:"dueDate"`
		BlockReason *string         `json:"blockReason"`
		Checklist   json.RawMessage `json:"checklist"`
		Required    *bool           `json:"required"`
		Version     *int            `json:"version"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if body.Status != nil && !validItemStatuses[*body.Status] {
		writeError(w, http.StatusBadRequest, "工作项状态不合法")
		return
	}
	if body.Priority != nil && !validPriorities[*body.Priority] {
		writeError(w, http.StatusBadRequest, "优先级取值不合法")
		return
	}
	if body.DueDate != nil && *body.DueDate != "" && !validDate(*body.DueDate) {
		writeError(w, http.StatusBadRequest, "截止日格式应为 YYYY-MM-DD")
		return
	}
	if !validChecklist(body.Checklist) {
		writeError(w, http.StatusBadRequest, "清单格式不正确")
		return
	}
	var projectID string
	if err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM work_items WHERE id = $1`, pathID(r)).Scan(&projectID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "工作项不存在")
		} else {
			writeErr(w, r, err)
		}
		return
	}
	var updated *WorkItem
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		it, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, pathID(r)))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("工作项不存在")
		}
		if err != nil {
			return err
		}
		if !canTouchItem(c, it, a) {
			return noPermission()
		}
		if body.Version != nil && *body.Version != it.Version {
			return conflict("这条工作项刚被别人改过，请刷新后重试")
		}
		// 非项目管理者只能改自己负责的条目的内容与状态,不能改归属、必交付物标记
		ownerOnly := !c.manage()
		if ownerOnly && (body.AssigneeID != nil || body.StageSeq != nil || body.Required != nil) {
			return noPermission()
		}
		changes := []string{}
		newStatus := it.Status
		if body.Status != nil {
			newStatus = *body.Status
		}
		if newStatus == ItemBlocked && strings.TrimSpace(firstNonEmpty(deref(body.BlockReason), it.BlockReason)) == "" {
			return badRequest("标记为阻塞时必须填写原因")
		}
		set := func(label, sql string, args ...any) error {
			if _, err := tx.ExecContext(ctx, `UPDATE work_items SET `+sql+`, updated_at = now() WHERE id = $1`, append([]any{it.ID}, args...)...); err != nil {
				return err
			}
			changes = append(changes, label)
			return nil
		}
		if body.Title != nil {
			t := trimRunes(*body.Title, 200)
			if t == "" {
				return badRequest("标题不能为空")
			}
			if err := set("标题", "title = $2", t); err != nil {
				return err
			}
		}
		if body.Body != nil {
			if err := set("说明", "body = $2", trimRunes(*body.Body, 8000)); err != nil {
				return err
			}
		}
		if body.Priority != nil {
			if err := set("优先级", "priority = $2", *body.Priority); err != nil {
				return err
			}
		}
		if body.StageSeq != nil {
			if *body.StageSeq < 1 || *body.StageSeq > pr.stageCount() {
				return badRequest("所属阶段不合法")
			}
			if err := set("所属阶段", "stage_seq = $2", *body.StageSeq); err != nil {
				return err
			}
		}
		if body.DueDate != nil {
			if err := set("截止日", "due_date = NULLIF($2,'')::date", *body.DueDate); err != nil {
				return err
			}
		}
		if body.Checklist != nil && (len(body.Checklist) > 0 && string(body.Checklist) != "null") {
			if err := set("清单", "checklist = $2::jsonb", string(body.Checklist)); err != nil {
				return err
			}
		}
		if body.Required != nil {
			if err := set("必交付物", "required = $2", *body.Required); err != nil {
				return err
			}
		}
		if body.Status != nil {
			doneAt := any(nil)
			if newStatus == ItemDone {
				doneAt = time.Now()
			}
			if _, err := tx.ExecContext(ctx, `UPDATE work_items SET status = $2, done_at = COALESCE($3, CASE WHEN $2 = 'done' THEN done_at END),
				block_reason = CASE WHEN $2 = 'blocked' THEN COALESCE(NULLIF($4,''), block_reason) ELSE '' END,
				updated_at = now() WHERE id = $1`, it.ID, newStatus, doneAt, deref(body.BlockReason)); err != nil {
				return err
			}
			// 状态变更单独记一条 item_status 事件,不再并入 item_updated,避免同一动作出现两条
			if err := addEventTx(ctx, tx, pr.ID, "item", it.ID, a, "item_status", map[string]any{
				"title": it.Title, "from": it.Status, "to": newStatus, "reason": deref(body.BlockReason),
			}); err != nil {
				return err
			}
		} else if body.BlockReason != nil {
			if err := set("阻塞原因", "block_reason = $2", trimRunes(*body.BlockReason, 1000)); err != nil {
				return err
			}
		}
		if body.AssigneeID != nil {
			if *body.AssigneeID != "" {
				u, err := s.GetUserByID(*body.AssigneeID)
				if err != nil {
					return err
				}
				if u == nil {
					return badRequest("被指派人不存在")
				}
			}
			if err := set("负责人", "assignee_id = NULLIF($2,'')", *body.AssigneeID); err != nil {
				return err
			}
			if *body.AssigneeID != "" && *body.AssigneeID != it.AssigneeID {
				if err := notifyTx(ctx, tx, *body.AssigneeID, "item_assigned", pr.ID, it.ID, "",
					"「"+pr.Name+"」给你指派了「"+it.Title+"」", "item_assigned:"+it.ID+":"+*body.AssigneeID+":"+timeNowKey()); err != nil {
					return err
				}
			}
		}
		// 带 version 时做乐观并发:有人在我之后改过,整笔回滚
		if body.Version != nil {
			res, err := tx.ExecContext(ctx, `UPDATE work_items SET version = version + 1 WHERE id = $1 AND version = $2`, it.ID, *body.Version)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return conflict("这条工作项刚被别人改过，请刷新后重试")
			}
		} else if _, err := tx.ExecContext(ctx, `UPDATE work_items SET version = version + 1 WHERE id = $1`, it.ID); err != nil {
			return err
		}
		if len(changes) > 0 {
			if err := addEventTx(ctx, tx, pr.ID, "item", it.ID, a, "item_updated", map[string]any{"title": it.Title, "changes": changes}); err != nil {
				return err
			}
		}
		out, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, it.ID))
		updated = out
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func itemStatusLabel(status string) string {
	return map[string]string{
		ItemTodo: "待办", ItemInProgress: "进行中", ItemBlocked: "阻塞", ItemInReview: "待验收", ItemDone: "完成", ItemCancelled: "已取消",
	}[status]
}

func (s *postgresStore) handleDeleteItem(w http.ResponseWriter, r *http.Request) {
	var projectID string
	if err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM work_items WHERE id = $1`, pathID(r)).Scan(&projectID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "工作项不存在")
		} else {
			writeErr(w, r, err)
		}
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		it, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, pathID(r)))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("工作项不存在")
		}
		if err != nil {
			return err
		}
		// 删除比修改严一格:项目管理者或创建人;必交付物不允许删,只能由管理者取消必交付标记
		if !(c.manage() || (c.member() && it.CreatedBy == a.ID)) {
			return noPermission()
		}
		if it.Required {
			return badRequest("必交付物不能删除；如不适用，请由 PM 取消其「必交付」标记")
		}
		var parent sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT parent_id FROM work_items WHERE id = $1`, it.ID).Scan(&parent); err != nil {
			return err
		}
		var reassign any
		if parent.Valid {
			reassign = parent.String
		}
		if _, err := tx.ExecContext(ctx, `UPDATE work_items SET parent_id = $2 WHERE parent_id = $1`, it.ID, reassign); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM work_item_links WHERE from_id = $1 OR to_id = $1`, it.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE comments SET item_id = NULL WHERE item_id = $1`, it.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM work_items WHERE id = $1`, it.ID); err != nil {
			return err
		}
		return addEventTx(ctx, tx, pr.ID, "item", it.ID, a, "item_deleted", map[string]any{"title": it.Title})
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *postgresStore) handleLinkItem(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToID string `json:"toId"`
		Kind string `json:"kind"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if body.Kind != "blocks" && body.Kind != "relates" {
		writeError(w, http.StatusBadRequest, "关系类型应为 blocks 或 relates")
		return
	}
	from := pathID(r)
	if from == body.ToID {
		writeError(w, http.StatusBadRequest, "不能关联到自己")
		return
	}
	var projectID string
	if err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM work_items WHERE id = $1`, from).Scan(&projectID); err != nil {
		writeError(w, http.StatusNotFound, "工作项不存在")
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		if !c.member() {
			return noPermission()
		}
		var toProject string
		if err := tx.QueryRowContext(ctx, `SELECT project_id FROM work_items WHERE id = $1`, body.ToID).Scan(&toProject); err != nil {
			return badRequest("被关联的工作项不存在")
		}
		if toProject != pr.ID {
			return badRequest("只能关联同一项目内的工作项")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO work_item_links (from_id, to_id, kind) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, from, body.ToID, body.Kind); err != nil {
			return err
		}
		return nil
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *postgresStore) handleUnlinkItem(w http.ResponseWriter, r *http.Request) {
	toID, kind := r.URL.Query().Get("toId"), r.URL.Query().Get("kind")
	from := pathID(r)
	var projectID string
	if err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM work_items WHERE id = $1`, from).Scan(&projectID); err != nil {
		writeError(w, http.StatusNotFound, "工作项不存在")
		return
	}
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, _ *Project, _ []ProjectStage, _ *actor, c caps) error {
		if !c.member() {
			return noPermission()
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM work_item_links WHERE from_id = $1 AND to_id = $2 AND kind = $3`, from, toID, kind)
		return err
	}) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleSplitItem 把一条工作项按成员拆成多条,每条一个负责人;原条目保留为汇总父项
func (s *postgresStore) handleSplitItem(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserIDs []string `json:"userIds"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	if len(body.UserIDs) == 0 {
		writeError(w, http.StatusBadRequest, "请选择至少一位成员")
		return
	}
	from := pathID(r)
	var projectID string
	if err := s.db.QueryRowContext(r.Context(), `SELECT project_id FROM work_items WHERE id = $1`, from).Scan(&projectID); err != nil {
		writeError(w, http.StatusNotFound, "工作项不存在")
		return
	}
	var out []*WorkItem
	if !s.inProjectLock(w, r, projectID, func(ctx context.Context, tx *sql.Tx, pr *Project, _ []ProjectStage, a *actor, c caps) error {
		if !c.manage() {
			return noPermission()
		}
		src, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, from))
		if errors.Is(err, sql.ErrNoRows) {
			return notFound("工作项不存在")
		}
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, uid := range body.UserIDs {
			if uid == "" || seen[uid] {
				continue
			}
			seen[uid] = true
			u, err := s.GetUserByID(uid)
			if err != nil {
				return err
			}
			if u == nil {
				return badRequest("成员不存在")
			}
			id := newID()
			if _, err := tx.ExecContext(ctx, `INSERT INTO work_items
				(id, project_id, stage_seq, type, title, body, status, priority, assignee_id, parent_id, due_date, sort_key, created_by, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, 'todo', $7, $8, $9, $10,
				        (SELECT COALESCE(MAX(sort_key), 0) + 1 FROM work_items WHERE project_id = $2), $11, now(), now())`,
				id, pr.ID, src.StageSeq, src.Type, src.Title, src.Body, src.Priority, u.ID, src.ID, nilIfEmpty(src.DueDate), a.ID); err != nil {
				return err
			}
			if err := notifyTx(ctx, tx, u.ID, "item_assigned", pr.ID, id, "",
				"「"+pr.Name+"」给你指派了「"+src.Title+"」", "item_assigned:"+id+":"+u.ID+":"+timeNowKey()); err != nil {
				return err
			}
			child, err := scanItem(tx.QueryRowContext(ctx, `SELECT `+itemCols+itemFrom+` WHERE w.id = $1`, id))
			if err != nil {
				return err
			}
			out = append(out, child)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE work_items SET assignee_id = NULL, version = version + 1, updated_at = now() WHERE id = $1`, src.ID); err != nil {
			return err
		}
		return addEventTx(ctx, tx, pr.ID, "item", src.ID, a, "item_split", map[string]any{"title": src.Title, "count": len(out)})
	}) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
