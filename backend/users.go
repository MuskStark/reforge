package main

import (
	"context"
	"net/http"
	"strings"
	"unicode/utf8"
)

// trimRunes 去首尾空白并限制字符数
func trimRunes(s string, max int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max])
	}
	return s
}

// UpdateUserProfile 管理员修改用户的显示名、部门、岗位
func (s *postgresStore) UpdateUserProfile(ctx context.Context, id, displayName, department, jobRole string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET display_name = $2, department = $3, job_role = $4 WHERE id = $1`,
		id, displayName, department, jobRole)
	return err
}

// handleUserDirectory GET /api/users —— 登录可见的用户目录(指派任务、选成员时用;不含系统角色与口令)
func handleUserDirectory(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if currentUser(w, r) == nil {
			return
		}
		users, err := st.ListUsers()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
			return
		}
		out := make([]map[string]any, 0, len(users))
		for _, u := range users {
			out = append(out, map[string]any{
				"id": u.ID, "username": u.Username,
				"displayName": displayName(u), "department": u.Department, "jobRole": u.JobRole,
			})
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleAdminUpdateUser PATCH /api/admin/users/{id} —— 管理员修改显示名 / 部门 / 岗位
func handleAdminUpdateUser(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		target, err := st.GetUserByID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "更新失败: "+err.Error())
			return
		}
		if target == nil {
			writeError(w, http.StatusNotFound, "用户不存在")
			return
		}
		var body struct {
			DisplayName *string `json:"displayName"`
			Department  *string `json:"department"`
			JobRole     *string `json:"jobRole"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		name, dept, job := target.DisplayName, target.Department, target.JobRole
		if body.DisplayName != nil {
			name = trimRunes(*body.DisplayName, 32)
		}
		if body.Department != nil {
			dept = trimRunes(*body.Department, 64)
		}
		if body.JobRole != nil {
			job = strings.TrimSpace(*body.JobRole)
			if !validJobRoles[job] {
				writeError(w, http.StatusBadRequest, "岗位无效（应为 CTO、项目经理、经办、开发实施或观察者）")
				return
			}
		}
		if err := st.UpdateUserProfile(r.Context(), target.ID, name, dept, job); err != nil {
			writeError(w, http.StatusInternalServerError, "更新失败: "+err.Error())
			return
		}
		updated, _ := st.GetUserByID(target.ID)
		writeJSON(w, http.StatusOK, updated)
	}
}
