package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// 端到端测试:连真实 PostgreSQL,走真实路由表,把"提交流程 → 立项指派 → 六个关卡 → 验收完成"整条主线跑一遍。
// 只有设置 TEST_DATABASE_URL 且库名为 flow_test 时才运行(用例会清空该库的全部业务表)。

type env struct {
	t   *testing.T
	srv *httptest.Server
	st  *postgresStore
}

func newTestEnv(t *testing.T) *env {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" || !strings.Contains(dsn, "/flow_test") {
		t.Skip("未设置指向 flow_test 库的 TEST_DATABASE_URL,跳过数据库端到端测试")
	}
	st, err := newStore(dsn)
	if err != nil {
		t.Fatalf("连接测试库失败: %v", err)
	}
	for _, tb := range []string{"notify_deliveries", "notify_channels", "notifications", "events", "process_versions", "comments",
		"work_item_links", "work_items", "gate_reviewers", "gate_reviews", "project_members", "project_stages", "projects",
		"followup_events", "stage_templates", "systems", "processes", "users"} {
		if _, err := st.db.Exec("TRUNCATE TABLE " + tb + " CASCADE"); err != nil {
			t.Fatalf("清空测试库失败: %v", err)
		}
	}
	// 模板表清空后重新写入内置模板,和真实环境首次启动时的状态一致
	if err := st.ensureStageTemplates(context.Background()); err != nil {
		t.Fatalf("写入内置阶段模板失败: %v", err)
	}
	sessions = newSessionStore()
	srv := httptest.NewServer(newMux(st))
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})
	return &env{t: t, srv: srv, st: st}
}

// req 发请求;响应不是 JSON 对象时返回 nil
func (e *env) req(token, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	res, err := e.srv.Client().Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	if strings.HasPrefix(strings.TrimSpace(string(raw)), "{") {
		if err := json.Unmarshal(raw, &out); err != nil {
			e.t.Fatalf("%s %s 响应不是合法 JSON: %v\n%s", method, path, err, raw)
		}
	}
	return res.StatusCode, out
}

// list 发 GET 并把 JSON 数组响应原样返回
func (e *env) list(token, path string) (int, []any) {
	e.t.Helper()
	return e.array(token, "GET", path, nil)
}

// mustArray 要求 2xx,返回 JSON 数组响应
func (e *env) mustArray(token, method, path string, body any) []any {
	e.t.Helper()
	code, out := e.array(token, method, path, body)
	if code < 200 || code >= 300 {
		e.t.Fatalf("%s %s 期望成功,得到 %d", method, path, code)
	}
	return out
}

func (e *env) array(token, method, path string, body any) (int, []any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	res, err := e.srv.Client().Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out []any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// must 要求 2xx,返回响应对象
func (e *env) must(token, method, path string, body ...any) map[string]any {
	e.t.Helper()
	var b any
	if len(body) > 0 {
		b = body[0]
	}
	code, out := e.req(token, method, path, b)
	if code < 200 || code >= 300 {
		e.t.Fatalf("%s %s 期望成功,得到 %d: %v", method, path, code, out)
	}
	return out
}

// fail 要求指定状态码,且错误信息包含 substr
func (e *env) fail(token, method, path string, body any, wantCode int, substr string) {
	e.t.Helper()
	code, out := e.req(token, method, path, body)
	msg, _ := out["error"].(string)
	if code != wantCode || !strings.Contains(msg, substr) {
		e.t.Fatalf("%s %s 期望 %d 且含 %q,得到 %d: %q", method, path, wantCode, substr, code, msg)
	}
}

// hasKind 通知列表里是否有某种类型的通知
func hasKind(list any, kind string) bool {
	items, _ := list.([]any)
	for _, raw := range items {
		if n, ok := raw.(map[string]any); ok && n["kind"] == kind {
			return true
		}
	}
	return false
}

func dig(v any, path ...string) any {
	cur := v
	for _, p := range path {
		switch c := cur.(type) {
		case map[string]any:
			cur = c[p]
		case []any:
			n := 0
			if _, err := fmt.Sscanf(p, "%d", &n); err != nil || n < 0 || n >= len(c) {
				return nil
			}
			cur = c[n]
		default:
			return nil
		}
	}
	return cur
}

// got 断言 v 沿路径取到的值等于 want(最后一个参数)
func got(t *testing.T, v any, rest ...any) {
	t.Helper()
	want := rest[len(rest)-1]
	path := make([]string, 0, len(rest)-1)
	for _, x := range rest[:len(rest)-1] {
		path = append(path, x.(string))
	}
	if x := dig(v, path...); x != want {
		t.Fatalf("%s: got %#v want %#v", strings.Join(path, "."), x, want)
	}
}

// 测试账号的密码:管理员建号时设定的初始密码,以及首次登录后换成的密码
const (
	initPassword = "pass1234"
	userPassword = "pass1235"
)

// createUser 管理员建号并返回这个用户的会话。管理员设定的初始密码在首次登录后必须更换,
// 所以这里登录后立刻改密,返回的是"已完成首次登录"的会话。
func (e *env) createUser(adminToken, name, job string) (token, id string) {
	e.t.Helper()
	out := e.must(adminToken, "POST", "/api/admin/users", map[string]any{
		"username": "u_" + name, "password": initPassword, "role": "member",
		"displayName": name, "department": "测试部", "jobRole": job,
	})
	token = e.login(name, initPassword)
	e.must(token, "POST", "/api/auth/password", map[string]any{"oldPassword": initPassword, "newPassword": userPassword})
	return token, out["id"].(string)
}

// login 用测试账号的登录名登录,返回会话令牌
func (e *env) login(name, password string) string {
	e.t.Helper()
	return e.must("", "POST", "/api/auth/login", map[string]any{"username": "u_" + name, "password": password})["token"].(string)
}

// completeRequired 把某阶段的必交付物全部标记完成
func (e *env) completeRequired(token, projectID string, stage int) int {
	e.t.Helper()
	_, items := e.list(token, "/api/projects/"+projectID+"/items")
	n := 0
	for _, raw := range items {
		it := raw.(map[string]any)
		if it["required"] == true && it["status"] != "done" && dig(it, "stageSeq") == float64(stage) {
			e.must(token, "PATCH", "/api/items/"+it["id"].(string), map[string]any{"status": "done"})
			n++
		}
	}
	return n
}

// submit 提交当前阶段评审,返回评审 ID
func (e *env) submit(token, projectID, summary string) (string, map[string]any) {
	e.t.Helper()
	rv := e.must(token, "POST", "/api/projects/"+projectID+"/reviews", map[string]any{"summary": summary})
	return rv["id"].(string), rv
}

func (e *env) project(token, id string) map[string]any {
	e.t.Helper()
	return e.must(token, "GET", "/api/projects/"+id)
}

func processPayload(name string) map[string]any {
	blank := map[string]any{"documents": []any{}, "handlers": []any{}}
	return map[string]any{
		"name": name, "description": "", "applicant": "孙申报",
		"steps": []map[string]any{
			{"id": "s1", "name": "提交申请", "mode": "online", "countersign": false,
				"online": map[string]any{"systemName": "OA", "mobileSupported": true}, "offline": blank, "parties": []any{}, "waitFor": nil, "remark": ""},
			{"id": "s2", "name": "部门会签", "mode": "online", "countersign": true,
				"online": map[string]any{"systemName": "", "mobileSupported": nil}, "offline": blank, "waitFor": nil, "remark": "",
				"parties": []map[string]any{
					{"id": "p1", "department": "财务部", "staff": []string{"王经办"}, "subSteps": []map[string]any{
						{"id": "p1a", "name": "财务复核", "mode": "online",
							"online": map[string]any{"systemName": "财务共享平台", "mobileSupported": true}, "offline": blank},
					}},
					{"id": "p2", "department": "法务部", "staff": []string{"赵经办"}, "subSteps": []map[string]any{
						{"id": "p2a", "name": "合同会签", "mode": "online",
							"online": map[string]any{"systemName": "合同系统", "mobileSupported": false}, "offline": blank},
					}},
				}},
			{"id": "s3", "name": "归档", "mode": "online", "countersign": false,
				"online":  map[string]any{"systemName": "OA", "mobileSupported": true, "dataInteroperable": false},
				"offline": blank, "parties": []any{}, "waitFor": nil, "remark": ""},
			{"id": "s4", "name": "纸质归档", "mode": "offline", "countersign": false,
				"online":  map[string]any{"systemName": "", "mobileSupported": nil},
				"offline": map[string]any{"documents": []any{}, "handlers": []map[string]any{{"department": "行政部", "staff": []string{}}}},
				"parties": []any{}, "waitFor": nil, "remark": ""},
		},
	}
}

func TestProjectLifecycle(t *testing.T) {
	e := newTestEnv(t)

	// ---- 建号:管理员、CTO、项目经理、两位经办、一个无关的观察者 ----
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	cto, _ := e.createUser(admin, "张技术", RoleCTO)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	h1, h1ID := e.createUser(admin, "王经办", RoleHandler)
	h2, h2ID := e.createUser(admin, "赵经办", RoleHandler)
	other, _ := e.createUser(admin, "路人甲", RoleViewer)

	// 未登录一律 401
	e.fail("", "GET", "/api/projects", nil, 401, "未登录")

	// ---- 提交流程即自动立项 ----
	code, _ := e.req("", "POST", "/api/processes", processPayload("采购申请审批流程"))
	if code != 201 {
		t.Fatalf("提交流程期望 201,得到 %d", code)
	}
	_, projects := e.list(admin, "/api/projects")
	if len(projects) != 1 {
		t.Fatalf("提交后应有 1 个项目,得到 %d", len(projects))
	}
	pid := projects[0].(map[string]any)["id"].(string)
	proj := e.project(admin, pid)
	got(t, proj, "currentStage", float64(1))
	got(t, proj, "pendingOn", "admin") // 还没指派项目经理
	got(t, proj, "stages", "0", "status", "pending")
	got(t, proj, "stages", "6", "name", "运营优化")
	got(t, proj, "metrics", "breakpoints", float64(2))
	got(t, proj, "metrics", "offlineShare", 0.167)
	got(t, proj, "metrics", "steps", float64(6))
	// 流程里登记的经办人员能匹配到用户,立项时可直接勾选
	hints := proj["handlerHints"].([]any)
	if len(hints) != 3 || dig(hints[1], "userId") != h1ID || dig(hints[2], "userId") != h2ID || dig(hints[0], "matched") != false {
		t.Fatalf("经办候选不符: %+v", hints)
	}
	// 立项时已留存 As-Is 快照
	_, versions := e.list(admin, "/api/projects/"+pid+"/versions")
	if len(versions) != 1 || dig(versions[0], "kind") != "as_is" {
		t.Fatalf("应有 1 个 As-Is 版本: %+v", versions)
	}
	// 管理员收到"新流程待立项"的通知
	nb := e.must(admin, "GET", "/api/notifications", nil)
	got(t, nb, "unread", float64(1))

	// ---- 权限边界 ----
	e.fail(other, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"}, 403, "权限")
	e.fail(h1, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"}, 403, "权限")
	e.fail(pm, "POST", "/api/projects/"+pid+"/reviews", map[string]any{"summary": "x"}, 403, "权限")
	e.fail(pm, "PATCH", "/api/projects/"+pid, map[string]any{"value": "高"}, 403, "权限")

	// ---- 立项指派:管理员指派项目经理与经办 ----
	proj = e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	got(t, proj, "hasPm", true)
	got(t, proj, "stages", "0", "status", "in_progress") // 项目经理到岗,阶段 1 启动
	got(t, proj, "pendingOn", "pm")
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"})
	proj = e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h2ID, "role": "handler", "action": "add"})
	if len(proj["members"].([]any)) != 3 {
		t.Fatalf("应有 3 名成员: %+v", proj["members"])
	}
	// 项目经理不能增删项目经理(分配规则见 TestAssignmentRules)
	e.fail(pm, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "remove"}, 403, "权限")
	e.fail(pm, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h1ID, "role": "pm", "action": "add"}, 403, "权限")

	// ---- G1 立项评审(CTO 或签) ----
	e.fail(pm, "POST", "/api/projects/"+pid+"/reviews", map[string]any{"summary": ""}, 400, "分析报告") // 必交付物未完成
	if n := e.completeRequired(pm, pid, 1); n != 1 {
		t.Fatalf("阶段 1 应有 1 个必交付物待完成,得到 %d", n)
	}
	e.fail(pm, "POST", "/api/projects/"+pid+"/reviews", map[string]any{"summary": ""}, 400, "改造价值") // 价值/复杂度未填
	e.fail(h1, "PATCH", "/api/projects/"+pid, map[string]any{"value": "高"}, 403, "权限")
	proj = e.must(pm, "PATCH", "/api/projects/"+pid, map[string]any{"value": "高", "complexity": "中", "priority": "high", "dueDate": "2026-12-31"})
	got(t, proj, "priority", "high")
	e.fail(pm, "PATCH", "/api/projects/"+pid, map[string]any{"priority": "urgent"}, 400, "优先级")
	// 重复提交同一阶段:在评审中不能再提交
	r1, rv := e.submit(pm, pid, "请立项")
	got(t, rv, "mode", "any")
	if len(rv["reviewers"].([]any)) != 1 || dig(rv, "reviewers", "0", "userId") == "" {
		t.Fatalf("G1 评审人应为全部 CTO: %+v", rv["reviewers"])
	}
	e.fail(pm, "POST", "/api/projects/"+pid+"/reviews", map[string]any{"summary": "x"}, 409, "进行中")
	got(t, e.project(pm, pid), "pendingOn", "cto")

	_, pending := e.list(cto, "/api/reviews/pending")
	if len(pending) != 1 || dig(pending[0], "projectName") != "采购申请审批流程" {
		t.Fatalf("CTO 的待评审列表不符: %+v", pending)
	}
	if _, hp := e.list(h1, "/api/reviews/pending"); len(hp) != 0 {
		t.Fatalf("经办此时不应有待评审: %+v", hp)
	}
	e.fail(pm, "POST", "/api/reviews/"+r1+"/decide", map[string]any{"decision": "approve"}, 403, "权限")
	e.fail(h1, "POST", "/api/reviews/"+r1+"/decide", map[string]any{"decision": "approve"}, 403, "权限")
	e.fail(cto, "POST", "/api/reviews/"+r1+"/decide", map[string]any{"decision": "reject"}, 400, "驳回必须填写意见")
	// 或签:首位表决人决定。驳回即驳回,阶段退回进行中,由项目经理补齐后重新提交
	got(t, e.must(cto, "POST", "/api/reviews/"+r1+"/decide", map[string]any{"decision": "reject", "comment": "请补充基线数据"}), "status", "rejected")
	e.fail(cto, "POST", "/api/reviews/"+r1+"/decide", map[string]any{"decision": "approve"}, 409, "已经结束")
	got(t, e.project(pm, pid), "stages", "0", "status", "in_progress")
	got(t, e.project(pm, pid), "pendingOn", "pm")
	e.fail(pm, "POST", "/api/reviews/"+r1+"/withdraw", nil, 409, "待决")
	r1b, rv := e.submit(pm, pid, "已补充基线数据")
	got(t, rv, "round", float64(2))
	decided := e.must(cto, "POST", "/api/reviews/"+r1b+"/decide", map[string]any{"decision": "approve", "comment": "同意立项"})
	got(t, decided, "status", "approved")
	e.fail(cto, "POST", "/api/reviews/"+r1b+"/decide", map[string]any{"decision": "approve"}, 409, "已经结束")
	proj = e.project(pm, pid)
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "stages", "0", "status", "approved")
	got(t, proj, "stages", "1", "status", "in_progress")
	got(t, proj, "pendingOn", "pm")
	// 项目经理收到"已通过,进入需求确认"
	pn := e.must(pm, "GET", "/api/notifications", nil)
	if dig(pn, "list", "0", "title") == nil || !strings.Contains(dig(pn, "list", "0", "title").(string), "已通过") {
		t.Fatalf("项目经理应收到评审通过通知: %+v", pn["list"])
	}

	// ---- G2 需求基线(经办会签):先驳回一次,再通过 ----
	e.completeRequired(pm, pid, 2)
	r2, rv := e.submit(pm, pid, "需求已核对")
	got(t, rv, "mode", "all")
	if len(rv["reviewers"].([]any)) != 2 {
		t.Fatalf("G2 评审人应为两位经办: %+v", rv["reviewers"])
	}
	e.fail(pm, "POST", "/api/reviews/"+r2+"/decide", map[string]any{"decision": "approve"}, 403, "权限")
	e.fail(h1, "POST", "/api/reviews/"+r2+"/decide", map[string]any{"decision": "reject"}, 400, "驳回必须填写意见")
	got(t, e.must(h1, "POST", "/api/reviews/"+r2+"/decide", map[string]any{"decision": "approve"}), "status", "pending") // 会签:一人通过仍未定
	e.fail(h1, "POST", "/api/reviews/"+r2+"/decide", map[string]any{"decision": "approve"}, 409, "表决过")
	got(t, e.must(h2, "POST", "/api/reviews/"+r2+"/decide", map[string]any{"decision": "reject", "comment": "第 3 步的经办部门写错了"}), "status", "rejected")
	proj = e.project(pm, pid)
	got(t, proj, "stages", "1", "status", "in_progress") // 驳回后退回修改
	got(t, proj, "pendingOn", "pm")
	r2b, rv := e.submit(pm, pid, "已更正经办部门")
	got(t, rv, "round", float64(2))
	got(t, e.must(h1, "POST", "/api/reviews/"+r2b+"/decide", map[string]any{"decision": "approve"}), "status", "pending")
	got(t, e.must(h2, "POST", "/api/reviews/"+r2b+"/decide", map[string]any{"decision": "approve", "comment": "可以"}), "status", "approved")
	got(t, e.project(pm, pid), "currentStage", float64(3))

	// ---- 工作项:指派、阻塞、拆分、依赖、越权 ----
	e.fail(other, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": " outsiders"}, 403, "权限")
	e.fail(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": ""}, 400, "标题")
	task := e.must(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{
		"title": "梳理接口清单", "type": "task", "assigneeId": h1ID, "dueDate": "2020-01-01", "stageSeq": 3,
		"checklist": []map[string]any{{"id": "c1", "text": "列出系统清单", "done": false}},
	})
	tid := task["id"].(string)
	got(t, task, "assigneeDisplayName", "王经办")
	// 改内容(非状态字段)记 item_updated;只改状态则只记 item_status,同一动作不重复记两条
	got(t, e.must(pm, "PATCH", "/api/items/"+tid, map[string]any{"body": "列出 OA、财务共享平台、合同系统的接口"}), "body", "列出 OA、财务共享平台、合同系统的接口")
	// 经办收到指派通知;"我的任务"里能看到
	nt := e.must(h1, "GET", "/api/notifications", nil)
	if !strings.Contains(fmt.Sprint(nt["list"]), "给你指派了") {
		t.Fatalf("经办应收到指派通知: %+v", nt["list"])
	}
	if _, mine := e.list(h1, "/api/me/items"); len(mine) != 1 {
		t.Fatalf("经办应有 1 条我的任务,得到 %d", len(mine))
	}
	// 负责人可改自己任务的状态,但阻塞必须写原因;不能改归属
	e.fail(h1, "PATCH", "/api/items/"+tid, map[string]any{"status": "blocked"}, 400, "阻塞")
	got(t, e.must(h1, "PATCH", "/api/items/"+tid, map[string]any{"status": "blocked", "blockReason": "等合同系统开通账号"}), "status", "blocked")
	e.fail(h1, "PATCH", "/api/items/"+tid, map[string]any{"assigneeId": pmID}, 403, "权限")
	// 乐观并发:带着旧版本号改,应 409
	e.must(h1, "PATCH", "/api/items/"+tid, map[string]any{"status": "in_progress"})
	e.fail(pm, "PATCH", "/api/items/"+tid, map[string]any{"title": "改标题", "version": 1}, 409, "改过")
	// 依赖关系:「联调」被「梳理接口清单」阻塞(联调 blocks 梳理接口清单)
	other2 := e.must(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": "联调", "assigneeId": h2ID})
	oid := other2["id"].(string)
	e.must(pm, "POST", "/api/items/"+oid+"/links", map[string]any{"toId": tid, "kind": "blocks"})
	e.fail(pm, "POST", "/api/items/"+oid+"/links", map[string]any{"toId": oid, "kind": "blocks"}, 400, "自己")
	_, items := e.list(pm, "/api/projects/"+pid+"/items")
	var blockedBy, pointsTo bool
	for _, raw := range items {
		it := raw.(map[string]any)
		links, _ := it["links"].([]any)
		for _, l := range links {
			// 发起方(联调)看到自己指向别人的 out;被阻塞方(梳理接口清单)看到指向自己的 in
			if it["id"] == oid && dig(l, "toId") == tid && dig(l, "direction") == "out" {
				pointsTo = true
			}
			if it["id"] == tid && dig(l, "toId") == oid && dig(l, "direction") == "in" {
				blockedBy = true
			}
		}
	}
	if !blockedBy || !pointsTo {
		t.Fatalf("依赖关系应双向可见: 被阻塞方看到 in=%v, 发起方看到 out=%v", blockedBy, pointsTo)
	}
	// 按成员拆分:两人各得一条,原条目变成父项
	if kids := e.mustArray(pm, "POST", "/api/items/"+tid+"/split", map[string]any{"userIds": []string{h1ID, h2ID}}); len(kids) != 2 {
		t.Fatalf("拆分应生成 2 条: %+v", kids)
	}
	// 必交付物不能删
	_, items = e.list(pm, "/api/projects/"+pid+"/items")
	var requiredID string
	for _, raw := range items {
		if it := raw.(map[string]any); it["required"] == true && requiredID == "" {
			requiredID = it["id"].(string)
		}
	}
	e.fail(pm, "DELETE", "/api/items/"+requiredID, nil, 400, "必交付物")
	// 删除父项后,拆出的子任务上提为顶层
	e.must(pm, "DELETE", "/api/items/"+tid)
	_, items = e.list(pm, "/api/projects/"+pid+"/items")
	top := 0
	for _, raw := range items {
		if strings.HasPrefix(dig(raw, "title").(string), "梳理接口清单") {
			top++
		}
	}
	if top != 2 {
		t.Fatalf("删除父项后两条拆分任务应成为顶层,得到 %d", top)
	}
	e.must(pm, "DELETE", "/api/items/"+oid)
	if _, mine := e.list(h2, "/api/me/items"); len(mine) != 1 {
		t.Fatalf("联调删除后赵经办应只剩 1 条拆分任务,得到 %d", len(mine))
	}

	// ---- 评论、@提及、简报 ----
	e.fail(other, "POST", "/api/projects/"+pid+"/comments", map[string]any{"body": "路过"}, 403, "权限")
	e.must(pm, "POST", "/api/projects/"+pid+"/comments", map[string]any{"body": "@王经办 接口清单请你确认"})
	if nm := e.must(h1, "GET", "/api/notifications?unread=1", nil); dig(nm, "unread") == float64(0) {
		t.Fatalf("被 @ 的经办应有未读通知: %+v", nm)
	}
	e.fail(h1, "POST", "/api/projects/"+pid+"/updates", map[string]any{"progress": "x", "health": "on_track"}, 403, "权限")
	e.fail(pm, "POST", "/api/projects/"+pid+"/updates", map[string]any{"progress": "有内容", "health": "bogus"}, 400, "健康度")
	e.fail(pm, "POST", "/api/projects/"+pid+"/updates", map[string]any{"health": "on_track"}, 400, "不能为空")
	proj = e.must(pm, "POST", "/api/projects/"+pid+"/updates", map[string]any{
		"progress": "接口清单已梳理完", "next": "出 To-Be 流程", "risks": "合同系统排期紧", "help": "需要法务配合", "health": "at_risk",
	})
	got(t, proj, "health", "at_risk")
	if nc := e.must(cto, "GET", "/api/notifications", nil); !strings.Contains(fmt.Sprint(nc["list"]), "有风险") {
		t.Fatalf("健康度转为有风险时 CTO 应收到通知: %+v", nc["list"])
	}
	_, comments := e.list(pm, "/api/projects/"+pid+"/comments")
	if len(comments) != 2 || dig(comments[0], "kind") != "update" || dig(comments[0], "structured", "risks") != "合同系统排期紧" {
		t.Fatalf("评论与简报列表不符: %+v", comments)
	}

	// ---- G3 方案评审(CTO 会签):新任 CTO 可补票;通过时留 To-Be 基线 ----
	e.completeRequired(pm, pid, 3)
	r3, _ := e.submit(pm, pid, "To-Be 方案见流程图")
	cto2, _ := e.createUser(admin, "钱技术", RoleCTO) // 评审提交后才上任的 CTO
	if _, p2 := e.list(cto2, "/api/reviews/pending"); len(p2) != 1 {
		t.Fatalf("新任 CTO 也应看到待评审: %+v", p2)
	}
	got(t, e.must(cto2, "POST", "/api/reviews/"+r3+"/decide", map[string]any{"decision": "approve"}), "status", "pending")
	got(t, e.must(cto, "POST", "/api/reviews/"+r3+"/decide", map[string]any{"decision": "approve", "comment": "方案可行"}), "status", "approved")
	_, versions = e.list(pm, "/api/projects/"+pid+"/versions")
	if len(versions) != 2 || dig(versions[1], "kind") != "to_be" {
		t.Fatalf("G3 通过后应有 To-Be 基线: %+v", versions)
	}
	cmp := e.must(pm, "GET", "/api/projects/"+pid+"/compare", nil)
	got(t, cmp, "asIs", "kind", "as_is")
	got(t, cmp, "current", "breakpoints", float64(2))
	// 某个版本的完整步骤可取
	if v := e.must(pm, "GET", "/api/projects/"+pid+"/versions/1", nil); len(v["steps"].([]any)) != 4 {
		t.Fatalf("As-Is 版本应含 4 个步骤: %+v", v)
	}

	// ---- 回退:项目经理把项目退回「需求确认」重做 ----
	e.fail(h1, "POST", "/api/projects/"+pid+"/stages/2/enter", map[string]any{"reason": "x"}, 403, "权限")
	e.fail(pm, "POST", "/api/projects/"+pid+"/stages/2/enter", map[string]any{"reason": ""}, 400, "原因")
	e.fail(pm, "POST", "/api/projects/"+pid+"/stages/4/enter", map[string]any{"reason": "x"}, 400, "之前")
	proj = e.must(pm, "POST", "/api/projects/"+pid+"/stages/2/enter", map[string]any{"reason": "业务口径有变，需求需重新确认"})
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "stages", "1", "status", "in_progress")
	got(t, proj, "stages", "2", "status", "pending")
	got(t, proj, "stages", "0", "status", "approved") // 更早的阶段不受影响
	// 重做 G2:必交付物此前已完成,可直接再次提交
	r2c, rv := e.submit(pm, pid, "按新口径重新确认")
	got(t, rv, "round", float64(3))
	e.must(h1, "POST", "/api/reviews/"+r2c+"/decide", map[string]any{"decision": "approve"})
	e.must(h2, "POST", "/api/reviews/"+r2c+"/decide", map[string]any{"decision": "approve"})
	got(t, e.project(pm, pid), "currentStage", float64(3))
	got(t, e.project(pm, pid), "stages", "2", "status", "in_progress") // 回退重做后方案阶段重新进行

	// 评审中不能回退;要先撤回
	e.completeRequired(pm, pid, 3)
	r3b, _ := e.submit(pm, pid, "再次提交")
	e.fail(pm, "POST", "/api/projects/"+pid+"/stages/2/enter", map[string]any{"reason": "x"}, 409, "先撤回")
	e.must(pm, "POST", "/api/reviews/"+r3b+"/withdraw", nil)
	got(t, e.project(pm, pid), "stages", "2", "status", "in_progress")
	e.fail(pm, "POST", "/api/reviews/"+r3b+"/withdraw", nil, 409, "待决")
	_, reviews := e.list(pm, "/api/projects/"+pid+"/reviews")
	var seenWithdrawn bool
	for _, raw := range reviews {
		if dig(raw, "status") == "withdrawn" {
			seenWithdrawn = true
		}
	}
	if !seenWithdrawn {
		t.Fatalf("评审历史应保留已撤回的轮次: %+v", reviews)
	}

	// ---- G3 重做通过 → G4 由 CTO 跳过 ----
	r3c, _ := e.submit(pm, pid, "方案定稿")
	e.must(cto, "POST", "/api/reviews/"+r3c+"/decide", map[string]any{"decision": "approve"})
	e.must(cto2, "POST", "/api/reviews/"+r3c+"/decide", map[string]any{"decision": "approve"})
	got(t, e.project(pm, pid), "currentStage", float64(4))
	e.fail(pm, "POST", "/api/projects/"+pid+"/stages/4/skip", map[string]any{"reason": "小改动"}, 403, "权限")
	e.fail(cto, "POST", "/api/projects/"+pid+"/stages/5/skip", map[string]any{"reason": "x"}, 400, "当前阶段")
	e.fail(cto, "POST", "/api/projects/"+pid+"/stages/4/skip", map[string]any{"reason": ""}, 400, "原因")
	proj = e.must(cto, "POST", "/api/projects/"+pid+"/stages/4/skip", map[string]any{"reason": "仅配置改动，无需开发与测试"})
	got(t, proj, "stages", "3", "status", "skipped")
	got(t, proj, "currentStage", float64(5))

	// ---- G5 试运行结论(经办会签)→ G6 验收(CTO 会签,或签场景已由 G1 覆盖) ----
	e.completeRequired(pm, pid, 5)
	r5, _ := e.submit(pm, pid, "UAT 通过")
	e.must(h1, "POST", "/api/reviews/"+r5+"/decide", map[string]any{"decision": "approve"})
	e.must(h2, "POST", "/api/reviews/"+r5+"/decide", map[string]any{"decision": "approve"})
	got(t, e.project(pm, pid), "currentStage", float64(6))
	e.fail(pm, "POST", "/api/projects/"+pid+"/status", map[string]any{"status": "done"}, 400, "验收上线") // G6 未过不能完成
	e.completeRequired(pm, pid, 6)
	r6, rv := e.submit(pm, pid, "申请验收")
	got(t, rv, "mode", "all")
	e.must(cto, "POST", "/api/reviews/"+r6+"/decide", map[string]any{"decision": "approve", "comment": "验收通过"})
	e.must(cto2, "POST", "/api/reviews/"+r6+"/decide", map[string]any{"decision": "approve"})
	proj = e.project(pm, pid)
	got(t, proj, "currentStage", float64(7))
	got(t, proj, "status", "active") // 上线不是终点:进入运营优化
	_, versions = e.list(pm, "/api/projects/"+pid+"/versions")
	if len(versions) != 4 || dig(versions[3], "kind") != "published" {
		t.Fatalf("G6 通过后应有已发布版本(含回退重做留下的两个 To-Be): %+v", versions)
	}
	proj = e.must(pm, "POST", "/api/projects/"+pid+"/status", map[string]any{"status": "done", "note": "复盘完成"})
	got(t, proj, "status", "done")
	got(t, proj, "pendingOn", "")
	e.fail(pm, "PATCH", "/api/projects/"+pid, map[string]any{"value": "低"}, 400, "已结束") // 已完成,不能再改
	e.fail(pm, "POST", "/api/projects/"+pid+"/updates", map[string]any{"progress": "x", "health": "on_track"}, 400, "进行中")

	// ---- 第二个项目:搁置 / 恢复 / 取消,以及定时任务(逾期、评审积压) ----
	e.must("", "POST", "/api/processes", processPayload("报销流程"))
	_, projects = e.list(admin, "/api/projects")
	var pid2 string
	for _, raw := range projects {
		if p := raw.(map[string]any); p["name"] == "报销流程" {
			pid2 = p["id"].(string)
		}
	}
	got(t, e.project(admin, pid2), "pendingOn", "admin")
	e.must(admin, "PUT", "/api/projects/"+pid2+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	got(t, e.must(pm, "POST", "/api/projects/"+pid2+"/status", map[string]any{"status": "on_hold", "note": "业务暂停"}), "status", "on_hold")
	got(t, e.must(pm, "GET", "/api/projects/"+pid2), "pendingOn", "")
	e.fail(pm, "POST", "/api/projects/"+pid2+"/status", map[string]any{"status": "cancelled"}, 403, "权限") // 取消需要 CTO / 管理员
	got(t, e.must(pm, "POST", "/api/projects/"+pid2+"/status", map[string]any{"status": "active"}), "status", "active")
	// 一条早已逾期的任务,和一个等待超过 3 天的待决评审
	e.must(pm, "POST", "/api/projects/"+pid2+"/items", map[string]any{"title": "补齐票据", "assigneeId": h1ID, "dueDate": "2020-01-01"})
	e.completeRequired(pm, pid2, 1)
	e.must(pm, "PATCH", "/api/projects/"+pid2, map[string]any{"value": "中", "complexity": "低"})
	raging, _ := e.submit(pm, pid2, "请立项")
	if _, err := e.st.db.Exec(`UPDATE gate_reviews SET submitted_at = now() - interval '4 days' WHERE id = $1`, raging); err != nil {
		t.Fatal(err)
	}
	if err := runScheduledJobs(context.Background(), e.st); err != nil {
		t.Fatalf("定时任务执行失败: %v", err)
	}
	h1n := e.must(h1, "GET", "/api/notifications", nil)
	pmN := e.must(pm, "GET", "/api/notifications", nil)
	ctoN := e.must(cto, "GET", "/api/notifications", nil)
	adminN := e.must(admin, "GET", "/api/notifications", nil)
	for _, c := range []struct {
		name string
		n    map[string]any
		kind string
	}{
		{"经办·逾期任务", h1n, "overdue"}, {"项目经理·逾期任务", pmN, "overdue"},
		{"CTO·评审积压", ctoN, "review_aging"}, {"管理员·评审积压", adminN, "review_aging"},
	} {
		if !hasKind(c.n["list"], c.kind) {
			t.Errorf("%s 应收到 %s 通知", c.name, c.kind)
		}
	}
	// 再跑一遍:同类提醒当天只发一次
	if err := runScheduledJobs(context.Background(), e.st); err != nil {
		t.Fatal(err)
	}
	got(t, e.must(h1, "GET", "/api/notifications", nil), "unread", dig(h1n, "unread"))
	got(t, e.must(cto, "GET", "/api/notifications", nil), "unread", dig(ctoN, "unread"))
	// 标记已读
	e.must(cto, "POST", "/api/notifications/read", map[string]any{"all": true})
	got(t, e.must(cto, "GET", "/api/notifications", nil), "unread", float64(0))

	// 组合视图
	ov := e.must(pm, "GET", "/api/overview", nil)
	got(t, ov, "collected", float64(2))
	got(t, ov, "done", float64(1))
	got(t, ov, "pendingReviews", float64(1))
	got(t, ov, "overdueItems", float64(1)) // 已完成项目里的旧任务不计入
	got(t, ov, "byStage", "0", float64(1)) // 只有「报销流程」在途,处于阶段 1
	got(t, ov, "byStage", "6", float64(0))
	got(t, ov, "byHealth", "at_risk", float64(0)) // 有风险的那个项目已完成,不再计入

	// "我参与的"与"待谁处理"筛选
	if _, mine := e.list(pm, "/api/projects?view=mine"); len(mine) != 2 {
		t.Fatalf("项目经理应参与 2 个项目,得到 %d", len(mine))
	}
	if _, mine := e.list(other, "/api/projects?view=mine"); len(mine) != 0 {
		t.Fatalf("未参与任何项目的人不应看到项目,得到 %d", len(mine))
	}
	if _, p := e.list(cto, "/api/projects?pending=cto"); len(p) != 1 {
		t.Fatalf("CTO 应看到 1 个待自己评审的项目,得到 %d", len(p))
	}
	if _, p := e.list(h1, "/api/projects?pending=handler"); len(p) != 0 {
		t.Fatalf("此时不应有待经办处理的项目,得到 %d", len(p))
	}
	if code, _ := e.req(pm, "GET", "/api/projects?pending=nobody", nil); code != 200 {
		t.Fatalf("筛选参数异常时应正常返回空列表,得到 %d", code)
	}

	// 取消与恢复的边界
	got(t, e.must(cto, "POST", "/api/projects/"+pid2+"/status", map[string]any{"status": "cancelled"}), "status", "cancelled")
	e.fail(pm, "POST", "/api/projects/"+pid2+"/status", map[string]any{"status": "active"}, 400, "搁置")
	e.fail(admin, "PUT", "/api/projects/"+pid2+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"}, 400, "结束")
	// 取消项目时,仍在等待的评审一并作废,不能再表决
	e.fail(cto, "POST", "/api/reviews/"+raging+"/decide", map[string]any{"decision": "approve"}, 409, "结束")
	_, rlist := e.list(pm, "/api/projects/"+pid2+"/reviews")
	if len(rlist) != 1 || dig(rlist[0], "status") != "withdrawn" {
		t.Fatalf("已取消项目的待决评审应已作废: %+v", rlist)
	}

	// ---- 时间线覆盖全流程事件 ----
	_, events := e.list(pm, "/api/projects/"+pid+"/events")
	kinds := map[string]int{}
	for _, raw := range events {
		kinds[dig(raw, "kind").(string)]++
	}
	for _, k := range []string{"project_created", "member_added", "review_submitted", "review_voted", "review_approved",
		"review_rejected", "review_withdrawn", "stage_rewound", "stage_skipped", "item_created", "item_updated",
		"item_status", "item_split", "item_deleted", "comment_added", "project_update", "project_status"} {
		if kinds[k] == 0 {
			t.Errorf("时间线缺少事件 %s: %v", k, kinds)
		}
	}
	// 全程只改过一次内容:item_updated 恰好 1 条;其余都是状态变更,不应再带出 item_updated
	if kinds["item_updated"] != 1 || kinds["item_status"] < 3 {
		t.Fatalf("item_updated 应恰好 1 条、item_status 至少 3 条,得到 %d / %d", kinds["item_updated"], kinds["item_status"])
	}
}
