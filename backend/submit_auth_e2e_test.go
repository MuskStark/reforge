package main

import (
	"testing"
)

// 端到端:收集表仅登录可填与提交人归属。
// 匿名提交被拒;登录提交后 created_by 落提交账号、申报人留空时兜底为显示名、
// 立项事件记录真实提交人(而不是"系统")——工作台「我提交的」就靠这组数据。
func TestSubmitRequiresLogin(t *testing.T) {
	e := newTestEnv(t)
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	submitter, submitterID := e.createUser(admin, "孙申报", RoleHandler)
	other, otherID := e.createUser(admin, "路人甲", RoleHandler)

	// 匿名提交被拒;首登未改密的会话同样不能提交
	e.fail("", "POST", "/api/processes", processPayload("匿名流程"), 401, "未登录")
	e.must(admin, "POST", "/api/admin/users", map[string]any{
		"username": "u_新同事", "password": initPassword, "role": "member",
		"displayName": "新同事", "department": "测试部", "jobRole": RoleHandler,
	})
	fresh := e.login("新同事", initPassword)
	e.fail(fresh, "POST", "/api/processes", processPayload("未改密流程"), 403, "修改密码")

	// 登录提交:申报人留空时兜底为显示名
	payload := processPayload("登录后提交流程")
	payload["applicant"] = ""
	if code, out := e.req(submitter, "POST", "/api/processes", payload); code != 201 {
		t.Fatalf("登录提交期望 201,得到 %d: %v", code, out)
	}
	pid := e.projectByName(admin, "登录后提交流程")
	got(t, e.project(admin, pid), "createdBy", submitterID)
	got(t, e.project(admin, pid), "applicant", "孙申报")

	// 「我提交的」口径:提交人能看到,无关成员看不到(前端按 createdBy === me.id 过滤,这里验数据源)
	_, projects := e.list(submitter, "/api/projects")
	if len(projects) != 1 || dig(projects[0], "createdBy") != submitterID {
		t.Fatalf("提交人应恰好看到 1 条自己提交的项目: %+v", projects)
	}
	_, projects = e.list(other, "/api/projects")
	for _, raw := range projects {
		if dig(raw, "createdBy") == otherID {
			t.Fatal("路人甲没有提交过流程,不应有归属到他名下的项目")
		}
	}

	// 立项事件记录真实提交人,而不是"系统"
	_, events := e.list(submitter, "/api/projects/"+pid+"/events")
	if len(events) == 0 || dig(events[len(events)-1], "kind") != "project_created" || dig(events[len(events)-1], "actorName") != "孙申报" {
		t.Fatalf("立项事件应记录提交人: %+v", events)
	}
}
