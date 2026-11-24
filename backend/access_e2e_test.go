package main

import (
	"strings"
	"testing"
)

// 端到端:流程的权限分配(管理员全部 / CTO 查看全部并分配科技侧经办 / 项目经理分配业务侧经办)
// 与用户自助(修改个人信息、修改密码、首次登录强制改密码)。走真实路由表与真实 PostgreSQL。

// submitProject 匿名提交一条流程,返回自动立项的项目 ID
func (e *env) submitProject(adminToken, name string) string {
	e.t.Helper()
	if code, _ := e.req("", "POST", "/api/processes", processPayload(name)); code != 201 {
		e.t.Fatalf("提交流程期望 201,得到 %d", code)
	}
	_, projects := e.list(adminToken, "/api/projects")
	for _, raw := range projects {
		if p := raw.(map[string]any); p["name"] == name {
			return p["id"].(string)
		}
	}
	e.t.Fatalf("提交后没有找到项目「%s」", name)
	return ""
}

// member 增删项目成员,返回状态码
func (e *env) member(token, pid, userID, role, action string) int {
	e.t.Helper()
	code, _ := e.req(token, "PUT", "/api/projects/"+pid+"/members",
		map[string]any{"userId": userID, "role": role, "action": action})
	return code
}

// hasMember 项目当前是否有这个人的这个角色
func (e *env) hasMember(token, pid, userID, role string) bool {
	e.t.Helper()
	for _, raw := range dig(e.must(token, "GET", "/api/projects/"+pid, nil), "members").([]any) {
		m := raw.(map[string]any)
		if m["userId"] == userID && m["role"] == role {
			return true
		}
	}
	return false
}

// 期望状态码;不符时用 what 说明是哪条规则
func (e *env) expectCode(code, want int, what string) {
	e.t.Helper()
	if code != want {
		e.t.Fatalf("%s: 期望 %d,得到 %d", what, want, code)
	}
}

func TestAssignmentRules(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	cto, _ := e.createUser(admin, "张技术", RoleCTO)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	h1, h1ID := e.createUser(admin, "王经办", RoleHandler)
	_, h2ID := e.createUser(admin, "赵经办", RoleHandler)
	d1, d1ID := e.createUser(admin, "钱开发", RoleDev)
	_, d2ID := e.createUser(admin, "吴开发", RoleDev)
	v2, v2ID := e.createUser(admin, "李观察二", RoleViewer)
	_, v1ID := e.createUser(admin, "孙观察", RoleViewer)
	_, pm2ID := e.createUser(admin, "周经理", RolePM)

	pid := e.submitProject(admin, "采购申请审批流程")

	// ---- CTO:能查看全部流程信息(不是成员也行),但只分配科技侧经办 ----
	e.must(cto, "GET", "/api/projects/"+pid, nil)
	e.must(cto, "GET", "/api/processes", nil)
	if code, list := e.list(cto, "/api/projects"); code != 200 || len(list) != 1 {
		t.Fatalf("CTO 应能看到全部项目,得到 %d 个 (HTTP %d)", len(list), code)
	}
	view := e.must(cto, "GET", "/api/projects/"+pid, nil)
	got(t, view, "can", "view", true)
	got(t, view, "can", "assignDev", true)
	got(t, view, "can", "assignHandler", false)
	got(t, view, "can", "assign", false)
	got(t, view, "can", "assignViewer", false)
	for _, tc := range []struct {
		user, role, what string
	}{
		{pmID, RolePM, "CTO 不能指派项目经理"}, {h1ID, RoleHandler, "CTO 不能分配业务侧经办"}, {v1ID, RoleViewer, "CTO 不能添加观察者"},
	} {
		e.expectCode(e.member(cto, pid, tc.user, tc.role, "add"), 403, tc.what)
	}
	e.expectCode(e.member(cto, pid, d1ID, RoleDev, "add"), 200, "CTO 应能分配科技侧经办")
	if !e.hasMember(cto, pid, d1ID, RoleDev) {
		t.Fatalf("CTO 分配的科技侧经办应出现在成员里")
	}
	e.expectCode(e.member(cto, pid, d1ID, RoleDev, "remove"), 200, "CTO 应能移除科技侧经办")
	// 时间线里的角色名写的是"科技侧经办"
	sawLabel := false
	_, events := e.list(admin, "/api/projects/"+pid+"/events")
	for _, raw := range events {
		if dig(raw, "kind") == "member_added" && dig(raw, "detail", "role") == "科技侧经办" {
			sawLabel = true
		}
	}
	if !sawLabel {
		t.Fatalf("加入科技侧经办的事件应写明角色: %+v", events)
	}

	// ---- 还不是这个项目项目经理的人,分配不了 ----
	e.expectCode(e.member(pm, pid, h1ID, RoleHandler, "add"), 403, "未到岗的项目经理不能分配")

	// ---- 管理员:全部权限分配 ----
	proj := e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": RolePM, "action": "add"})
	got(t, proj, "hasPm", true) // 第一位项目经理到岗,项目启动
	for _, tc := range []struct{ user, role string }{{h1ID, RoleHandler}, {d1ID, RoleDev}, {v1ID, RoleViewer}} {
		e.expectCode(e.member(admin, pid, tc.user, tc.role, "add"), 200, "管理员应能分配 "+tc.role)
	}
	view = e.must(admin, "GET", "/api/projects/"+pid, nil)
	for _, f := range []string{"assign", "assignHandler", "assignDev", "assignViewer"} {
		got(t, view, "can", f, true)
	}
	if n := len(dig(view, "members").([]any)); n != 4 {
		t.Fatalf("应有 4 名成员,得到 %d", n)
	}

	// ---- 项目经理:只分配业务侧经办 ----
	view = e.must(pm, "GET", "/api/projects/"+pid, nil)
	got(t, view, "can", "assignHandler", true)
	got(t, view, "can", "assignDev", false)
	got(t, view, "can", "assign", false)
	got(t, view, "can", "assignViewer", false)
	e.expectCode(e.member(pm, pid, h2ID, RoleHandler, "add"), 200, "项目经理应能分配业务侧经办")
	e.expectCode(e.member(pm, pid, h1ID, RoleHandler, "remove"), 200, "项目经理应能移除业务侧经办")
	for _, tc := range []struct {
		user, role, action, what string
	}{
		{d2ID, RoleDev, "add", "项目经理不能分配科技侧经办"}, {d1ID, RoleDev, "remove", "项目经理不能移除科技侧经办"},
		{v1ID, RoleViewer, "add", "项目经理不能添加观察者"}, {v1ID, RoleViewer, "remove", "项目经理不能移除观察者"},
		{pm2ID, RolePM, "add", "项目经理不能再指派项目经理"}, {pmID, RolePM, "remove", "项目经理不能卸任自己"},
	} {
		e.expectCode(e.member(pm, pid, tc.user, tc.role, tc.action), 403, tc.what)
	}
	if !e.hasMember(pm, pid, d1ID, RoleDev) || !e.hasMember(pm, pid, v1ID, RoleViewer) || !e.hasMember(pm, pid, pmID, RolePM) {
		t.Fatalf("项目经理的越权操作不应改动成员")
	}

	// ---- 业务侧经办、科技侧经办、观察者:都不能分配任何人 ----
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h1ID, "role": RoleHandler, "action": "add"})
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": v2ID, "role": RoleViewer, "action": "add"})
	for _, who := range []struct {
		token, name string
	}{{h1, "业务侧经办"}, {d1, "科技侧经办"}, {v2, "观察者"}} {
		for _, tc := range []struct{ user, role string }{{h2ID, RoleHandler}, {d2ID, RoleDev}, {pm2ID, RolePM}, {v1ID, RoleViewer}} {
			e.expectCode(e.member(who.token, pid, tc.user, tc.role, "add"), 403, who.name+"不能分配 "+tc.role)
		}
		view = e.must(who.token, "GET", "/api/projects/"+pid, nil)
		got(t, view, "can", "assign", false)
		got(t, view, "can", "assignHandler", false)
		got(t, view, "can", "assignDev", false)
		got(t, view, "can", "assignViewer", false)
	}

	// ---- 未登录一律 401 ----
	e.fail("", "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": d2ID, "role": RoleDev, "action": "add"}, 401, "未登录")
}

func TestFirstLoginMustChangePassword(t *testing.T) {
	e := newTestEnv(t)
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)

	// 公开注册的首个用户,密码是自己设的:不强制改
	got(t, reg, "user", "mustChangePassword", false)
	e.must(admin, "GET", "/api/projects", nil)

	// 管理员建号:密码由管理员设定,标记为必须改
	created := e.must(admin, "POST", "/api/admin/users", map[string]any{
		"username": "newhire", "password": "init1234", "role": "member", "displayName": "新同事", "department": "运营部", "jobRole": RoleHandler,
	})
	got(t, created, "mustChangePassword", true)
	// 管理员清单里能看到谁还没完成首次登录
	sawPending := false
	for _, raw := range e.mustArray(admin, "GET", "/api/admin/users", nil) {
		if u := raw.(map[string]any); u["username"] == "newhire" {
			sawPending = u["mustChangePassword"] == true
		}
	}
	if !sawPending {
		t.Fatalf("管理员清单里 newhire 应显示为待首次登录改密")
	}

	// 首次登录
	login := e.must("", "POST", "/api/auth/login", map[string]any{"username": "newhire", "password": "init1234"})
	tok := login["token"].(string)
	got(t, login, "user", "mustChangePassword", true)

	// 改密之前:三个鉴权入口都放行不了业务请求
	e.fail(tok, "GET", "/api/projects", nil, 403, "修改密码")  // 项目类接口
	e.fail(tok, "GET", "/api/processes", nil, 403, "修改密码") // 流程查看类接口
	code, out := e.req(tok, "GET", "/api/projects", nil)
	if code != 403 || out["code"] != passwordChangeRequired {
		t.Fatalf("拒绝响应应带错误码 %s,得到 %d %v", passwordChangeRequired, code, out)
	}
	// 身份、改资料、改密、注销这几个接口本身可用
	codeMe, me := e.req(tok, "GET", "/api/auth/me", nil)
	if codeMe != 200 {
		t.Fatalf("改密前应能读取自己的身份,得到 %d", codeMe)
	}
	got(t, me, "mustChangePassword", true)
	e.must(tok, "PATCH", "/api/auth/profile", map[string]any{"displayName": "新同事甲"})

	// 原密码错误 / 新密码太短 / 与原密码相同
	e.fail(tok, "POST", "/api/auth/password", map[string]any{"oldPassword": "wrong-pass", "newPassword": "myown123"}, 400, "原密码不正确")
	e.fail(tok, "POST", "/api/auth/password", map[string]any{"oldPassword": "init1234", "newPassword": "123"}, 400, "6-64")
	e.fail(tok, "POST", "/api/auth/password", map[string]any{"oldPassword": "init1234", "newPassword": "init1234"}, 400, "不能与原密码相同")
	e.fail(tok, "GET", "/api/projects", nil, 403, "修改密码")

	// 改密之前,同一账号另开的一个会话:改完后应被吊销
	other := e.must("", "POST", "/api/auth/login", map[string]any{"username": "newhire", "password": "init1234"})["token"].(string)

	// 改密成功
	changed := e.must(tok, "POST", "/api/auth/password", map[string]any{"oldPassword": "init1234", "newPassword": "myown123"})
	got(t, changed, "mustChangePassword", false)
	e.must(tok, "GET", "/api/projects", nil)
	e.must(tok, "GET", "/api/processes", nil)
	codeMe, me = e.req(tok, "GET", "/api/auth/me", nil)
	if codeMe != 200 {
		t.Fatalf("改密后应能读取自己的身份,得到 %d", codeMe)
	}
	got(t, me, "mustChangePassword", false)
	e.fail(other, "GET", "/api/auth/me", nil, 401, "未登录")

	// 旧密码不能再登录;新密码可以,且不再强制
	if code, _ := e.req("", "POST", "/api/auth/login", map[string]any{"username": "newhire", "password": "init1234"}); code != 401 {
		t.Fatalf("旧密码应已失效,得到 %d", code)
	}
	again := e.must("", "POST", "/api/auth/login", map[string]any{"username": "newhire", "password": "myown123"})
	got(t, again, "user", "mustChangePassword", false)
	e.must(again["token"].(string), "GET", "/api/projects", nil)

	// 管理员建的"系统管理员"账号同样要先改密才能进后台
	e.must(admin, "POST", "/api/admin/users", map[string]any{
		"username": "newadmin", "password": "init1234", "role": "admin", "displayName": "新管理员", "department": "信息中心", "jobRole": RoleCTO,
	})
	adm2 := e.must("", "POST", "/api/auth/login", map[string]any{"username": "newadmin", "password": "init1234"})["token"].(string)
	e.fail(adm2, "GET", "/api/admin/users", nil, 403, "修改密码")
	e.must(adm2, "POST", "/api/auth/password", map[string]any{"oldPassword": "init1234", "newPassword": "admown123"})
	e.must(adm2, "GET", "/api/admin/users", nil)

	// 受限会话可以注销
	e.must(admin, "POST", "/api/admin/users", map[string]any{
		"username": "another", "password": "init1234", "role": "member", "displayName": "再一位", "department": "运营部", "jobRole": RoleViewer,
	})
	third := e.must("", "POST", "/api/auth/login", map[string]any{"username": "another", "password": "init1234"})["token"].(string)
	e.must(third, "DELETE", "/api/auth/session", nil)
	e.fail(third, "GET", "/api/auth/me", nil, 401, "未登录")
}

func TestSelfProfile(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)

	// 未登录
	e.fail("", "PATCH", "/api/auth/profile", map[string]any{"displayName": "x"}, 401, "未登录")
	e.fail("", "POST", "/api/auth/password", map[string]any{"oldPassword": "a", "newPassword": "b"}, 401, "未登录")

	// 用户改自己的显示名与部门
	u, _ := e.createUser(admin, "王经办", RoleHandler)
	me := e.must(u, "PATCH", "/api/auth/profile", map[string]any{"displayName": "王小经办", "department": "运营部"})
	got(t, me, "displayName", "王小经办")
	got(t, me, "department", "运营部")
	got(t, me, "jobRole", RoleHandler) // 岗位、系统角色不受影响
	got(t, me, "role", "member")
	me = e.must(u, "GET", "/api/auth/me", nil)
	got(t, me, "displayName", "王小经办")
	got(t, me, "department", "运营部")
	// 只改部门
	me = e.must(u, "PATCH", "/api/auth/profile", map[string]any{"department": "科技部"})
	got(t, me, "displayName", "王小经办")
	got(t, me, "department", "科技部")
	// 超长会被截断
	me = e.must(u, "PATCH", "/api/auth/profile", map[string]any{"displayName": strings.Repeat("长", 40)})
	if n := len([]rune(me["displayName"].(string))); n != 32 {
		t.Fatalf("显示名应截断到 32 个字符,得到 %d", n)
	}
	// 显示名为空不行
	e.fail(u, "PATCH", "/api/auth/profile", map[string]any{"displayName": "  "}, 400, "显示名不能为空")
	// 不能借这个接口改岗位或系统角色
	e.fail(u, "PATCH", "/api/auth/profile", map[string]any{"jobRole": RoleCTO}, 400, "格式")
	e.fail(u, "PATCH", "/api/auth/profile", map[string]any{"role": "admin"}, 400, "格式")
	me = e.must(u, "GET", "/api/auth/me", nil)
	got(t, me, "jobRole", RoleHandler)
	got(t, me, "role", "member")

	// 平时改密码:要原密码,改完旧密码失效
	e.fail(u, "POST", "/api/auth/password", map[string]any{"oldPassword": "wrong-pass", "newPassword": "another123"}, 400, "原密码不正确")
	e.must(u, "POST", "/api/auth/password", map[string]any{"oldPassword": userPassword, "newPassword": "another123"})
	if code, _ := e.req("", "POST", "/api/auth/login", map[string]any{"username": "u_王经办", "password": userPassword}); code != 401 {
		t.Fatalf("旧密码应已失效,得到 %d", code)
	}
	e.must("", "POST", "/api/auth/login", map[string]any{"username": "u_王经办", "password": "another123"})

	// 环境变量引导的管理员:没有用户行,改不了资料和密码,但也不被强制改密拦住
	t.Setenv("FLOW_ADMIN_USER", "envadmin")
	t.Setenv("FLOW_ADMIN_PASS", "envpass123")
	env := e.must("", "POST", "/api/auth/login", map[string]any{"username": "envadmin", "password": "envpass123"})
	envTok := env["token"].(string)
	got(t, env, "user", "id", "")
	got(t, env, "user", "mustChangePassword", false)
	e.fail(envTok, "PATCH", "/api/auth/profile", map[string]any{"displayName": "x"}, 403, "环境变量")
	e.fail(envTok, "POST", "/api/auth/password", map[string]any{"oldPassword": "envpass123", "newPassword": "another123"}, 403, "环境变量")
	e.must(envTok, "GET", "/api/admin/users", nil)
}
