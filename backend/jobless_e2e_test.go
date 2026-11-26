package main

import (
	"testing"
)

// 端到端:无岗位用户(纯提交人)的受限体验。
// 只能提交收集表;项目/流程/时间线/承接只见自己提交的;大屏与用户目录不可见;
// 未被处理(初析未完成、未指派 PM)时可改自己的提交,并且 As-Is 基线随之刷新;
// 有岗位用户与管理员不受这些限制。
func TestJoblessSubmitter(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	// 无岗位(建号不传 jobRole 即默认)与有岗位 BH 各一个
	plain, _ := e.createUser(admin, "路人丁", RoleNone)
	bh, _ := e.createUser(admin, "赵经办", RoleHandler)
	pmo, _ := e.createUser(admin, "周琳", RoleViewer)
	if u := e.must(plain, "GET", "/api/auth/me", nil); dig(u, "jobRole") != "" {
		t.Fatalf("不传岗位的账号应为无岗位: %v", u)
	}

	// 各自提交一条
	if code, _ := e.req(plain, "POST", "/api/processes", processPayload("无岗位提交的流程")); code != 201 {
		t.Fatalf("无岗位提交期望 201,得到 %d", code)
	}
	e.must(bh, "POST", "/api/processes", processPayload("经办提交的流程"))
	mine := e.projectByName(plain, "无岗位提交的流程")
	others := e.projectByName(admin, "经办提交的流程")

	// ---- 可见性:项目 ----
	_, list := e.list(plain, "/api/projects")
	if len(list) != 1 || dig(list[0], "name") != "无岗位提交的流程" {
		t.Fatalf("无岗位用户应只看到自己提交的 1 条: %+v", list)
	}
	e.fail(plain, "GET", "/api/projects/"+others, nil, 404, "不存在")
	e.fail(plain, "GET", "/api/projects/"+others+"/events", nil, 404, "不存在")
	e.fail(plain, "GET", "/api/projects/"+others+"/intake", nil, 404, "不存在")
	e.fail(plain, "GET", "/api/projects/"+others+"/export", nil, 404, "不存在")

	// ---- 可见性:流程定义 / 大屏 / 用户目录 ----
	_, plist := e.list(plain, "/api/processes")
	if len(plist) != 1 {
		t.Fatalf("无岗位用户的流程列表应只有自己的: %+v", plist)
	}
	minePID, _ := dig(plist[0], "id").(string)
	if _, p := e.list(admin, "/api/admin/processes"); len(p) != 2 {
		t.Fatalf("管理员应看到全部 2 条流程: %+v", p)
	}
	if _, p := e.list(plain, "/api/admin/processes"); len(p) != 1 {
		t.Fatalf("无岗位用户走后台地址也应只见自己的: %+v", p)
	}
	e.fail(plain, "GET", "/api/overview", nil, 403, "大屏")
	e.fail(plain, "GET", "/api/users", nil, 403, "用户目录")

	// ---- 对照:有岗位用户与管理员不受限 ----
	if _, p := e.list(bh, "/api/projects"); len(p) != 2 {
		t.Fatalf("有岗位用户应看到全部 2 条: %+v", p)
	}
	if _, p := e.list(admin, "/api/projects"); len(p) != 2 {
		t.Fatalf("管理员(jobRole 亦为空)应看到全部 2 条: %+v", p)
	}

	// ---- 改单窗口:未被处理时可改自己的,As-Is 基线随之刷新 ----
	// processPayload 是 4 个主步骤 + 2 个会签子步骤,As-Is 计 6
	got(t, e.intake(admin, mine), "asIs", "steps", float64(6))
	edited := processPayload("无岗位提交的流程")
	edited["steps"] = append(edited["steps"].([]map[string]any), map[string]any{
		"id": "s5", "name": "电子归档", "mode": "online", "countersign": false,
		"online":  map[string]any{"systemName": "OA", "mobileSupported": true},
		"offline": map[string]any{"documents": []any{}, "handlers": []any{}},
		"parties": []any{}, "waitFor": nil, "remark": "",
	})
	e.must(plain, "PUT", "/api/admin/processes/"+minePID+"?via=form", edited)
	got(t, e.intake(admin, mine), "asIs", "steps", float64(7))
	// 别人的流程改不了
	e.fail(plain, "PUT", "/api/admin/processes/"+processIDByName(e, admin, "经办提交的流程")+"?via=form", processPayload("经办提交的流程"), 403, "修改")

	// ---- PMO 完成初级分析后,改单窗口关闭 ----
	e.must(pmo, "PUT", "/api/projects/"+mine+"/intake/triage", map[string]any{
		"value": "中", "complexity": "中", "priority": "medium", "conclusion": "开始处理",
		"completeness": "complete", "done": true,
	})
	e.fail(plain, "PUT", "/api/admin/processes/"+minePID+"?via=form", edited, 403, "开始处理")
}

// processIDByName 按流程名取流程 ID(从全量流程列表里找)
func processIDByName(e *env, token, name string) string {
	e.t.Helper()
	_, list := e.list(token, "/api/processes")
	for _, raw := range list {
		if p := raw.(map[string]any); p["name"] == name {
			return p["id"].(string)
		}
	}
	e.t.Fatalf("找不到流程「%s」", name)
	return ""
}
