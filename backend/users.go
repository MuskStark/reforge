package main

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// passwordLimiter 改密码时原密码连续输错:15 分钟 5 次即锁(防止拿着别人的会话去猜原密码)
var passwordLimiter = newRateLimiter(5, 15*time.Minute, 15*time.Minute)

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

// UpdateUserLogin 管理员修改用户的登录名与系统角色（调用方负责吊销该用户的存量会话）
func (s *postgresStore) UpdateUserLogin(ctx context.Context, id, username, role string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET username = $2, role = $3 WHERE id = $1`,
		id, username, role)
	return err
}

// AdminResetPassword 管理员重置密码：设为临时密码并要求用户下次登录先改成自己的
func (s *postgresStore) AdminResetPassword(ctx context.Context, id, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = $2, must_change_password = TRUE WHERE id = $1`, id, hash)
	return err
}

// handleUserDirectory GET /api/users —— 登录可见的用户目录(指派任务、选成员时用;不含系统角色与口令)。
// 无岗位的纯提交人没有使用场景,也不该看到全员名单
func handleUserDirectory(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, ok := currentActor(w, r, st)
		if !ok {
			return
		}
		if a.isJobless() {
			writeError(w, http.StatusForbidden, "无岗位用户不能查看用户目录")
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

// handleAdminUpdateUser PATCH /api/admin/users/{id} —— 管理员修改用户名 / 系统角色 / 显示名 / 部门 / 岗位。
// 用户名与系统角色改动后吊销该账号全部存量会话（会话里快照了这两项，须重新登录生效）
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
			Username    *string `json:"username"`
			Role        *string `json:"role"`
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
				writeError(w, http.StatusBadRequest, "岗位无效（应为无岗位、PMO、CTO、PM、BH 或 TH）")
				return
			}
		}
		newName, newRole := target.Username, target.Role
		if body.Username != nil {
			newName = strings.TrimSpace(*body.Username)
			// 用户名规则与建号一致(2-32 字符)
			if n := len([]rune(newName)); n < 2 || n > 32 {
				writeError(w, http.StatusBadRequest, "用户名长度需在 2-32 个字符之间")
				return
			}
			if existing, err := st.GetUserByUsername(newName); err != nil {
				writeError(w, http.StatusInternalServerError, "更新失败: "+err.Error())
				return
			} else if existing != nil && existing.ID != target.ID {
				writeError(w, http.StatusConflict, "用户名已被占用")
				return
			}
		}
		if body.Role != nil {
			newRole = strings.TrimSpace(*body.Role)
			if newRole != "admin" && newRole != "member" {
				writeError(w, http.StatusBadRequest, "角色无效（应为 admin 或 member）")
				return
			}
			sd := sessions.get(bearerToken(r))
			if sd != nil && sd.UserID == target.ID && newRole != target.Role {
				writeError(w, http.StatusForbidden, "不能修改当前登录账号的系统角色")
				return
			}
			if target.Role == "admin" && newRole != "admin" {
				if n, err := st.CountAdmins(); err != nil {
					writeError(w, http.StatusInternalServerError, "更新失败: "+err.Error())
					return
				} else if n <= 1 {
					writeError(w, http.StatusForbidden, "系统至少需要保留一名管理员")
					return
				}
			}
		}
		if newName != target.Username || newRole != target.Role {
			if err := st.UpdateUserLogin(r.Context(), target.ID, newName, newRole); err != nil {
				if strings.Contains(err.Error(), "duplicate key") {
					writeError(w, http.StatusConflict, "用户名已被占用")
					return
				}
				requestLogger(r).Error("更新用户登录信息失败", "target", target.Username, "err", err)
				writeError(w, http.StatusInternalServerError, "更新失败，请稍后重试")
				return
			}
		}
		if name != target.DisplayName || dept != target.Department || job != target.JobRole {
			if err := st.UpdateUserProfile(r.Context(), target.ID, name, dept, job); err != nil {
				requestLogger(r).Error("更新用户资料失败", "target", target.Username, "err", err)
				writeError(w, http.StatusInternalServerError, "更新失败，请稍后重试")
				return
			}
		}
		// 登录名/角色快照在会话里,变更后旧会话全部吊销,须重新登录
		revoked := false
		if newName != target.Username || newRole != target.Role {
			sessions.revokeByUsername(target.Username)
			revoked = true
		}
		// 岗位与系统角色决定权限,改动一律留痕;用户名只记旧值与新值,密码永不入日志
		args := []any{"target", target.Username, "display", name, "job", job, "dept", dept, "role", newRole}
		if newName != target.Username {
			args = append(args, "new_username", newName)
		}
		if revoked {
			args = append(args, "note", "该账号的存量会话已吊销")
		}
		audit(r, "user.update", args...)
		updated, _ := st.GetUserByID(target.ID)
		writeJSON(w, http.StatusOK, updated)
	}
}

// handleAdminResetPassword POST /api/admin/users/{id}/password —— 管理员重置任意用户的密码。
// 重置的是临时密码:该账号的会话全部吊销,下次登录必须先改成自己的密码(与建号流程一致)。
// 自己的密码走自助通道,这里不受理。
func handleAdminResetPassword(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin(w, r) {
			return
		}
		target, err := st.GetUserByID(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "重置失败: "+err.Error())
			return
		}
		if target == nil {
			writeError(w, http.StatusNotFound, "用户不存在")
			return
		}
		var body struct {
			Password string `json:"password"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		if len(body.Password) < 6 || len(body.Password) > 64 {
			writeError(w, http.StatusBadRequest, "密码长度需在 6-64 个字符之间")
			return
		}
		if sd := sessions.get(bearerToken(r)); sd != nil && sd.UserID == target.ID {
			writeError(w, http.StatusForbidden, "不能在这里重置自己的密码，请在个人信息中修改")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcrypt.DefaultCost)
		if err != nil {
			requestLogger(r).Error("密码加密失败", "err", err)
			writeError(w, http.StatusInternalServerError, "密码加密失败")
			return
		}
		if err := st.AdminResetPassword(r.Context(), target.ID, string(hash)); err != nil {
			requestLogger(r).Error("重置用户密码失败", "target", target.Username, "err", err)
			writeError(w, http.StatusInternalServerError, "重置失败，请稍后重试")
			return
		}
		sessions.revokeByUsername(target.Username)
		// 只记操作不记口令
		audit(r, "user.password_reset", "target", target.Username, "note", "临时密码已下发，该账号的存量会话已吊销")
		updated, _ := st.GetUserByID(target.ID)
		writeJSON(w, http.StatusOK, updated)
	}
}

// ---- 个人信息与密码(用户自助) ----

// UpdateOwnProfile 用户自己修改显示名与部门。系统角色与岗位仍由管理员维护,这里不碰。
func (s *postgresStore) UpdateOwnProfile(ctx context.Context, id, displayName, department string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET display_name = $2, department = $3 WHERE id = $1`,
		id, displayName, department)
	return err
}

// ChangePassword 换掉密码散列,同时清除"首次登录必须改密码"的标记
func (s *postgresStore) ChangePassword(ctx context.Context, id, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1`, id, hash)
	return err
}

// selfUser 当前会话对应的用户行,连同会话令牌一起返回。
// 环境变量引导的管理员没有用户行(密码在服务器配置里),写 403 并返回 false。
func selfUser(w http.ResponseWriter, r *http.Request, st *postgresStore) (*User, string, bool) {
	token := bearerToken(r)
	sd := sessions.get(token)
	if sd == nil {
		writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
		return nil, "", false
	}
	if sd.UserID == "" {
		writeError(w, http.StatusForbidden, "当前账号由服务器环境变量管理，个人信息和密码需在服务器配置中修改")
		return nil, "", false
	}
	u, err := st.GetUserByID(sd.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取失败: "+err.Error())
		return nil, "", false
	}
	if u == nil {
		writeError(w, http.StatusUnauthorized, "账号不存在或已删除")
		return nil, "", false
	}
	return u, token, true
}

// handleUpdateOwnProfile PATCH /api/auth/profile —— 用户修改自己的显示名与部门
func handleUpdateOwnProfile(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _, ok := selfUser(w, r, st)
		if !ok {
			return
		}
		var body struct {
			DisplayName *string `json:"displayName"`
			Department  *string `json:"department"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		name, dept := u.DisplayName, u.Department
		if body.DisplayName != nil {
			name = trimRunes(*body.DisplayName, 32)
			if name == "" {
				writeError(w, http.StatusBadRequest, "显示名不能为空")
				return
			}
		}
		if body.Department != nil {
			dept = trimRunes(*body.Department, 64)
		}
		if err := st.UpdateOwnProfile(r.Context(), u.ID, name, dept); err != nil {
			requestLogger(r).Error("保存个人信息失败", "err", err)
			writeError(w, http.StatusInternalServerError, "保存失败，请稍后重试")
			return
		}
		audit(r, "user.profile_update", "display", name, "dept", dept)
		updated, _ := st.GetUserByID(u.ID)
		writeJSON(w, http.StatusOK, publicUser(updated))
	}
}

// handleChangePassword POST /api/auth/password —— 用户修改自己的密码。
// 管理员建号时设定的初始密码,必须经此换成自己的密码后账号才能正常使用。
// 原密码输错按失败限流;改完后吊销该账号的其余会话。
func handleChangePassword(st *postgresStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, token, ok := selfUser(w, r, st)
		if !ok {
			return
		}
		var body struct {
			OldPassword string `json:"oldPassword"`
			NewPassword string `json:"newPassword"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		if l := len(body.NewPassword); l < 6 || l > 64 {
			writeError(w, http.StatusBadRequest, "新密码长度需在 6-64 个字符之间")
			return
		}
		rlKey := "pwd:" + u.ID
		if !passwordLimiter.allow(rlKey) {
			writeError(w, http.StatusTooManyRequests, "尝试次数过多,请 15 分钟后再试")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(body.OldPassword)) != nil {
			passwordLimiter.hit(rlKey)
			// 只记"原密码不对",新旧密码都不进日志
			requestLogger(r).Warn("audit", "action", "auth.password_wrong", "user", u.Username)
			writeError(w, http.StatusBadRequest, "原密码不正确")
			return
		}
		if subtleEqual(body.OldPassword, body.NewPassword) {
			writeError(w, http.StatusBadRequest, "新密码不能与原密码相同")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcrypt.DefaultCost)
		if err != nil {
			requestLogger(r).Error("密码加密失败", "err", err)
			writeError(w, http.StatusInternalServerError, "密码加密失败")
			return
		}
		if err := st.ChangePassword(r.Context(), u.ID, string(hash)); err != nil {
			requestLogger(r).Error("修改密码失败", "err", err)
			writeError(w, http.StatusInternalServerError, "修改失败，请稍后重试")
			return
		}
		sessions.clearMustChange(token)
		sessions.revokeOthers(token, u.Username)
		audit(r, "auth.password_change", "note", "该账号的其他会话已吊销")
		updated, _ := st.GetUserByID(u.ID)
		writeJSON(w, http.StatusOK, publicUser(updated))
	}
}
