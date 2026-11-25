package main

import (
	"context"
	"strings"
	"testing"
)

// 端到端:需求承接的完整闭环与分支。与 TestProjectLifecycle 的区别:那里只走一条直线(提交 → 通过),
// 这里覆盖权限矩阵、分支与边界——方案由谁可以改、申请 CTO 协助的状态流转、评估草稿与替代方案的校验、
// PMO 退回后重提另起一轮、主负责的更替、模板里没有承接阶段、终审积压、跳过与取消。

// readyForIntake 提交一条差旅流程,由 PMO 完成初级分析并指派 PM,返回项目 ID。此后项目处于「PM 推进」。
func (e *env) readyForIntake(admin, pmo, pm, pmID, name string) string {
	e.t.Helper()
	if code, _ := e.req("", "POST", "/api/processes", travelPayload(name)); code != 201 {
		e.t.Fatalf("提交流程期望 201,得到 %d", code)
	}
	pid := e.projectByName(admin, name)
	e.must(pmo, "PUT", "/api/projects/"+pid+"/intake/triage", map[string]any{
		"value": "高", "complexity": "中", "priority": "high", "conclusion": "问题集中在发票处理与三套系统的交接处",
		"completeness": HasGaps, "completenessNote": "缺退回路径", "done": true,
	})
	e.must(pmo, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": RolePM, "action": "add"})
	return pid
}

// toFinalPending 把方案填齐、提交评估并由 CTO 通过,项目停在「等 PMO 终审」
func (e *env) toFinalPending(pm, cto, pid string) string {
	e.t.Helper()
	e.fillIntake(pm, pid)
	rv, _ := e.submit(pm, pid, "方案已齐备")
	e.approveIntake(cto, pid, rv)
	return rv
}

func TestIntakeLoop(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	cto1, _ := e.createUser(admin, "张技术", RoleCTO)
	cto2, _ := e.createUser(admin, "钱技术", RoleCTO)
	pmo, _ := e.createUser(admin, "周琳", RoleViewer)
	pm1, pm1ID := e.createUser(admin, "陈昊", RolePM)
	_, pm2ID := e.createUser(admin, "林悦", RolePM)
	h1, h1ID := e.createUser(admin, "赵倩", RoleHandler)
	h2, h2ID := e.createUser(admin, "王磊", RoleHandler)
	outsider, outsiderID := e.createUser(admin, "路人甲", RoleHandler)

	pid := e.readyForIntake(admin, pmo, pm1, pm1ID, "员工差旅报销流程")
	base := "/api/projects/" + pid
	sol, sup, pts, fin := base+"/intake/solution", base+"/intake/cto-support", base+"/intake/points", base+"/intake/final"

	// ---- PM 承接:可以有多名 PM;PM 自己分配多名 BH ----
	e.must(pmo, "PUT", base+"/members", map[string]any{"userId": pm2ID, "role": RolePM, "action": "add"})
	e.must(pm1, "PUT", base+"/members", map[string]any{"userId": h1ID, "role": RoleHandler, "action": "add"})
	e.must(pm1, "PUT", base+"/members", map[string]any{"userId": h2ID, "role": RoleHandler, "action": "add"})
	v := e.intake(pm1, pid)
	got(t, v, "phase", PhaseAdvance)
	got(t, v, "leadPmName", "陈昊")
	got(t, v, "can", "edit", true)
	got(t, v, "can", "triage", false) // 已指派 PM,初级分析完成
	nodeKey := func(line, i string) string { return dig(v, "lines", line, "nodes", i, "key").(string) }

	// ---- 方案由谁可以改:PM / CTO / 管理员能改全部;某条推进线的负责人只能改自己那一条 ----
	e.fail(outsider, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "reason": "x"}}}, 403, "权限")
	e.fail(h1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "reason": "x"}}}, 403, "权限")
	e.fail(h1, "PUT", sol, map[string]any{"summary": "x"}, 403, "权限")
	// 负责人必须是项目的参与成员
	e.fail(pm1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "ownerId": outsiderID}}}, 400, "参与成员")
	e.must(pm1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "ownerId": h1ID}}})
	got(t, e.intake(h1, pid), "can", "editLines", true)
	got(t, e.intake(h1, pid), "ownLines", "0", LineOffline)
	got(t, e.intake(h2, pid), "can", "editLines", false)
	// 被指定为负责人的人会收到通知,动态里也记一笔
	if !hasText(e.must(h1, "GET", "/api/notifications", nil)["list"], "intake_line_assigned", "推进线「线下节点转线上」交给你负责") {
		t.Fatalf("被指定为推进线负责人的 BH 应收到通知")
	}
	if _, events := e.list(pm1, base+"/events"); !hasKind(events, "intake_line_assigned") {
		t.Fatalf("指定推进线负责人应记入动态: %+v", events)
	}
	// 负责人不能把推进线转给别人(换人由 PM 决定),哪怕是转回给 PM
	e.fail(h1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "ownerId": pm1ID}}}, 403, "权限")
	e.fail(h1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineOffline, "ownerId": h2ID}}}, 403, "权限")
	v = e.must(h1, "PUT", sol, map[string]any{
		"lines": []map[string]any{{"key": LineOffline, "reason": "财务要求核对发票原件", "solution": "发票影像上传 + 电子签名"}},
		"nodes": []map[string]any{
			{"key": nodeKey("0", "0"), "line": LineOffline, "status": PlanPlanned, "note": "影像化后电子签名"},
			{"key": nodeKey("0", "2"), "line": LineOffline, "status": PlanNa, "note": "纸质原件按规定留存"},
		},
	})
	got(t, v, "lines", "0", "reason", "财务要求核对发票原件")
	got(t, v, "lines", "0", "solution", "发票影像上传 + 电子签名")
	got(t, v, "lines", "0", "ownerName", "赵倩")
	got(t, v, "lines", "0", "updatedByName", "赵倩")
	got(t, v, "lines", "0", "nodes", "0", "status", PlanPlanned)
	got(t, v, "lines", "0", "nodes", "0", "note", "影像化后电子签名")
	got(t, v, "lines", "0", "nodes", "2", "status", PlanNa)
	got(t, v, "lines", "0", "nodes", "1", "status", PlanPending) // 没碰的节点保持待定
	// 负责人改不了别的推进线,也改不了总述与流程完整性
	e.fail(h1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineInterop, "reason": "x"}}}, 403, "权限")
	e.fail(h1, "PUT", sol, map[string]any{"nodes": []map[string]any{{"key": nodeKey("2", "0"), "line": LineMobile, "status": PlanPlanned}}}, 403, "权限")
	e.fail(h1, "PUT", sol, map[string]any{"completeness": Complete}, 403, "权限")
	// 校验:推进线、处理状态要合法;节点必须确实在那条推进线的诊断结果里
	e.fail(pm1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": "bogus"}}}, 400, "推进线")
	e.fail(pm1, "PUT", sol, map[string]any{"nodes": []map[string]any{{"key": nodeKey("0", "0"), "line": LineOffline, "status": "done"}}}, 400, "处理状态")
	e.fail(pm1, "PUT", sol, map[string]any{"nodes": []map[string]any{{"key": "m:4:nope", "line": LineOffline, "status": PlanPlanned}}}, 400, "诊断结果")
	e.fail(pm1, "PUT", sol, map[string]any{"completeness": "fine"}, 400, "不合法")
	// 同一个节点(行程预订)既不互通也不支持移动端:在两条线里各有一份处理状态,互不影响
	t4 := nodeKey("2", "0")
	if t4 != nodeKey("1", "0") {
		t.Fatalf("行程预订应在系统不互通与无法移动端两条线里是同一个节点")
	}
	v = e.must(pm1, "PUT", sol, map[string]any{"nodes": []map[string]any{
		{"key": t4, "line": LineMobile, "status": PlanPlanned}, {"key": t4, "line": LineInterop, "status": PlanNa},
	}})
	got(t, v, "lines", "2", "nodes", "0", "status", PlanPlanned)
	got(t, v, "lines", "1", "nodes", "0", "status", PlanNa)

	// ---- 申请 CTO 协助:PM 发起并写明事项 → 通知全部 CTO → CTO 响应 → 结束 ----
	do := func(action, note string) map[string]any {
		return map[string]any{"action": action, "note": note}
	}
	e.fail(h1, "POST", sup, do("request", "需要技术预判"), 403, "权限")
	e.fail(pm1, "POST", sup, do("request", ""), 400, "写明")
	e.fail(pm1, "POST", sup, do("bogus", ""), 400, "不合法")
	e.fail(cto1, "POST", sup, do("join", ""), 409, "没有等待响应")
	v = e.must(pm1, "POST", sup, do("request", "电子档案合规性与商旅平台接口能力需要预判"))
	got(t, v, "ctoSupport", "status", SupportRequested)
	got(t, v, "ctoSupport", "reason", "电子档案合规性与商旅平台接口能力需要预判")
	got(t, v, "ctoSupport", "requestedByName", "陈昊")
	got(t, e.intake(cto1, pid), "can", "joinCto", true)
	got(t, e.intake(pm1, pid), "can", "joinCto", false)
	e.fail(pm1, "POST", sup, do("request", "再申请一次"), 409, "已经申请过")
	for _, who := range []string{cto1, cto2} {
		if !hasKind(e.must(who, "GET", "/api/notifications", nil)["list"], "cto_support_requested") {
			t.Fatalf("%s 应收到 CTO 协助申请", who)
		}
	}
	e.fail(pm1, "POST", sup, do("join", ""), 403, "权限")
	e.fail(h1, "POST", sup, do("release", ""), 403, "权限")
	v = e.must(cto1, "POST", sup, do("join", ""))
	got(t, v, "ctoSupport", "status", SupportJoined)
	got(t, v, "ctoSupport", "joinedByName", "张技术")
	if !hasKind(e.must(pm1, "GET", "/api/notifications", nil)["list"], "cto_support_joined") {
		t.Fatalf("PM 应收到 CTO 已加入协助的通知")
	}
	e.fail(cto1, "POST", sup, do("join", ""), 409, "没有等待响应")
	e.fail(pm1, "POST", sup, do("withdraw", ""), 409, "没有等待响应")
	got(t, e.must(pm1, "POST", sup, do("release", "")), "ctoSupport", "status", SupportNone)
	// 撤回:还没人响应的申请可以撤回,撤回后 CTO 不能再加入
	e.must(pm1, "POST", sup, do("request", "接口可行性需要预判"))
	got(t, e.must(pm1, "POST", sup, do("withdraw", "")), "ctoSupport", "status", SupportNone)
	e.fail(cto2, "POST", sup, do("join", ""), 409, "没有等待响应")

	// ---- 技术点:只有项目管理者能在 PM 推进时增删改 ----
	e.fail(h1, "POST", pts, map[string]any{"title": "发票影像采集与查验"}, 403, "权限")
	e.fail(pm1, "POST", pts, map[string]any{"title": "  "}, 400, "不能为空")
	e.fail(pm1, "POST", pts, map[string]any{"title": "接口对接", "line": "bogus"}, 400, "推进线")
	p1 := e.must(pm1, "POST", pts, map[string]any{"title": "发票影像采集与查验", "line": LineOffline, "note": "文字识别 + 税务查验接口"})
	p2 := e.must(pm1, "POST", pts, map[string]any{"title": "商旅平台移动预订", "line": LineMobile})
	p3 := e.must(pm1, "POST", pts, map[string]any{"title": "电子会计档案归档", "line": LineOffline})
	// 修改时没传的字段保持不变
	e.must(pm1, "PATCH", "/api/intake/points/"+p3["id"].(string), map[string]any{"note": "合规性待确认"})
	e.fail(pm1, "PATCH", "/api/intake/points/"+p2["id"].(string), map[string]any{"title": ""}, 400, "不能为空")
	e.fail(pm1, "PATCH", "/api/intake/points/nope", map[string]any{"note": "x"}, 404, "不存在")
	e.must(pm1, "DELETE", "/api/intake/points/"+p2["id"].(string))
	e.fail(pm1, "DELETE", "/api/intake/points/"+p2["id"].(string), nil, 404, "不存在")
	v = e.intake(pm1, pid)
	if n := len(v["points"].([]any)); n != 2 {
		t.Fatalf("删掉一个后应剩 2 个技术点,得到 %d", n)
	}
	got(t, v, "points", "1", "title", "电子会计档案归档")
	got(t, v, "points", "1", "line", LineOffline)
	got(t, v, "points", "1", "note", "合规性待确认")
	got(t, v, "points", "1", "createdByName", "陈昊")

	// ---- 把方案填齐并提交技术可行性评估 ----
	e.must(pm1, "PUT", sol, map[string]any{
		"completeness": Complete, "completenessNote": "退回路径已补全",
		"summary": "12 个节点全部线上办理并支持移动端",
		"lines": []map[string]any{
			{"key": LineInterop, "reason": "商旅平台没有实时接口", "solution": "单点登录与结果回写"},
			{"key": LineMobile, "reason": "商旅平台、财务系统没有移动端", "solution": "移动待办页承接"},
		},
	})
	v = e.intake(pm1, pid)
	got(t, v, "completeness", Complete)
	got(t, v, "summary", "12 个节点全部线上办理并支持移动端")
	if missing := v["missing"].([]any); len(missing) != 0 {
		t.Fatalf("方案齐备后不应还有缺项: %v", missing)
	}
	rv := e.must(pm1, "POST", base+"/reviews", map[string]any{"summary": "方案已齐备"})
	rid := rv["id"].(string)
	got(t, rv, "mode", ModeAny)
	if n := len(rv["reviewers"].([]any)); n != 2 {
		t.Fatalf("评审人应为全部 CTO(两位),得到 %d", n)
	}
	v = e.intake(pm1, pid)
	got(t, v, "phase", PhaseAssess)
	got(t, v, "round", float64(1))
	got(t, v, "reviewId", rid)
	got(t, v, "reviewStatus", ReviewPending)
	got(t, v, "can", "edit", false)
	got(t, v, "can", "assess", false)
	got(t, e.intake(cto1, pid), "can", "assess", true)
	// 评估进行中:方案与技术点锁定
	e.fail(pm1, "PUT", sol, map[string]any{"summary": "改"}, 409, "只能在 PM 推进时修改")
	e.fail(pm1, "POST", pts, map[string]any{"title": "新技术点"}, 409, "评估进行中")
	e.fail(pm1, "DELETE", "/api/intake/points/"+p1["id"].(string), nil, 409, "评估进行中")

	// ---- CTO 逐项评估:资格、草稿、通过与替代方案 ----
	assess, decide := "/api/reviews/"+rid+"/assessment", "/api/reviews/"+rid+"/decide"
	pt := func(id, verdict, note string) map[string]any {
		return map[string]any{"pointId": id, "verdict": verdict, "note": note}
	}
	p1ID, p3ID := p1["id"].(string), p3["id"].(string)
	for _, who := range []string{pm1, h1, outsider} {
		e.fail(who, "PUT", assess, map[string]any{"points": []map[string]any{pt(p1ID, VerdictFeasible, "")}}, 403, "权限")
	}
	// 无权的人拿不到评估的内容:先报权限,而不是「还没有结论」
	e.fail(pm1, "POST", decide, map[string]any{"decision": DecisionApprove}, 403, "权限")
	e.fail(cto1, "PUT", assess, map[string]any{"points": []map[string]any{pt(p1ID, "ok", "")}}, 400, "只能是")
	e.fail(cto1, "PUT", assess, map[string]any{"points": []map[string]any{pt("nope", VerdictFeasible, "")}}, 400, "不存在")
	// 先存草稿:一个可行,一个不可行但还没写替代方案
	e.must(cto1, "PUT", assess, map[string]any{"points": []map[string]any{pt(p1ID, VerdictFeasible, ""), pt(p3ID, VerdictInfeasible, "")}})
	v = e.intake(cto1, pid)
	got(t, v, "points", "0", "assessments", "0", "verdict", VerdictFeasible)
	got(t, v, "points", "0", "assessments", "0", "userName", "张技术")
	got(t, v, "points", "1", "assessments", "0", "verdict", VerdictInfeasible)
	// 不可行的技术点必须给出替代方案,否则不能通过
	e.fail(cto1, "POST", decide, map[string]any{"decision": DecisionApprove}, 400, "替代方案")
	// 在表决的同一笔请求里补上替代方案
	got(t, e.must(cto1, "POST", decide, map[string]any{
		"decision": DecisionApprove, "comment": "总体可行",
		"points": []map[string]any{pt(p3ID, VerdictInfeasible, "全电发票纯电子归档，纸质原件留存")},
	}), "status", ReviewApproved)

	// ---- 评估通过:不进入下一阶段,等 PMO 终审 ----
	proj := e.project(pm1, pid)
	got(t, proj, "currentStage", float64(1))
	got(t, proj, "stages", "0", "status", StageInReview)
	got(t, proj, "pendingOn", PendingPMO)
	got(t, proj, "intake", "phase", PhaseFinal)
	got(t, proj, "intake", "finalPending", true)
	if _, p := e.list(cto2, "/api/reviews/pending"); len(p) != 0 {
		t.Fatalf("或签:首位 CTO 定论后另一位不再需要表决: %+v", p)
	}
	v = e.intake(pmo, pid)
	got(t, v, "phase", PhaseFinal)
	got(t, v, "finalPending", true)
	got(t, v, "can", "final", true)
	got(t, v, "can", "triage", false)
	got(t, v, "points", "1", "assessments", "0", "note", "全电发票纯电子归档，纸质原件留存")
	got(t, e.intake(admin, pid), "can", "final", true) // 管理员兜底
	for _, who := range []string{pm1, cto1, h1, outsider} {
		got(t, e.intake(who, pid), "can", "final", false)
	}
	for _, who := range []string{pmo, admin} {
		if !hasKind(e.must(who, "GET", "/api/notifications", nil)["list"], "intake_final_pending") {
			t.Fatalf("%s 应收到终审待办", who)
		}
	}
	if _, p := e.list(admin, "/api/projects?pending=pmo"); len(p) != 1 || dig(p[0], "id") != pid {
		t.Fatalf("按「待 PMO 处理」筛选应只剩这一个项目: %+v", p)
	}
	// 大屏的全池诊断:差旅流程立项时诊断出 3 / 3 / 4;此刻有一个项目在等终审,没有等初析的
	if ov := e.must(pmo, "GET", "/api/overview?full=1", nil); dig(ov, "intake", "projects") != float64(1) ||
		dig(ov, "intake", "offline") != float64(3) || dig(ov, "intake", "interop") != float64(3) || dig(ov, "intake", "mobile") != float64(4) ||
		dig(ov, "intake", "offlineAffected") != float64(1) || dig(ov, "intake", "triage") != float64(0) || dig(ov, "intake", "final") != float64(1) {
		t.Fatalf("大屏的全池诊断不符: %+v", dig(ov, "intake"))
	}
	// 等终审时阶段在数据上仍是「评审中」,但导出里说成「待终审」;评估相关的通知与事件都叫「技术可行性评估」
	if _, _, md := e.raw(admin, base+"/export"); !strings.Contains(md, "| 待终审 |") || strings.Contains(md, "| 评审中 |") {
		t.Fatalf("等终审的阶段在报告里应写「待终审」:\n%s", md)
	}
	if !hasKind(e.must(cto1, "GET", "/api/notifications", nil)["list"], "review_submitted") ||
		!hasText(e.must(cto1, "GET", "/api/notifications", nil)["list"], "review_submitted", "提交了技术可行性评估") {
		t.Fatalf("承接阶段的评审通知应叫「技术可行性评估」")
	}
	// 时间线:评估通过并标注「等待终审」;总体结论是有条件通过(有不可行的技术点)
	_, events := e.list(admin, base+"/events")
	sawAwaiting := false
	for _, raw := range events {
		if ev := raw.(map[string]any); ev["kind"] == "review_approved" && dig(ev, "detail", "awaitingFinal") == true {
			sawAwaiting = true
			if dig(ev, "detail", "conclusion") != "conditional" {
				t.Fatalf("有不可行的技术点时总体结论应为有条件通过: %+v", ev["detail"])
			}
		}
	}
	if !sawAwaiting {
		t.Fatalf("时间线应有「评估通过、等待终审」: %+v", events)
	}

	// ---- PMO 终审:退回整改 ----
	for _, who := range []string{pm1, cto1, h1, outsider} {
		e.fail(who, "POST", fin, map[string]any{"decision": FinalPassed}, 403, "权限")
	}
	e.fail(pmo, "POST", fin, map[string]any{"decision": "ok"}, 400, "不合法")
	e.fail(pmo, "POST", fin, map[string]any{"decision": FinalReturned}, 400, "退回整改必须写明")
	e.fail(pmo, "POST", fin, map[string]any{"decision": FinalPassedNotes}, 400, "有保留通过必须写明")
	v = e.finalIntake(pmo, pid, FinalReturned, "替代方案牺牲了实时性，请与业务确认后再提")
	got(t, v, "phase", PhaseAdvance)
	got(t, v, "finalPending", false)
	// 能力表是按请求人算的:PMO 自己不能改方案;退回后 PM 可以继续修改
	got(t, v, "can", "edit", false)
	got(t, e.intake(pm1, pid), "can", "edit", true)
	got(t, v, "finals", "0", "decision", FinalReturned)
	got(t, v, "finals", "0", "decidedByName", "周琳")
	got(t, v, "finals", "0", "round", float64(1))
	proj = e.project(pm1, pid)
	got(t, proj, "stages", "0", "status", StageInProgress)
	got(t, proj, "pendingOn", "pm")
	got(t, proj, "intake", "phase", PhaseAdvance)
	// 退回后方案、技术点与上一轮的结论都还在;没有待终审的评估
	got(t, v, "lines", "0", "reason", "财务要求核对发票原件")
	got(t, v, "points", "0", "assessments", "0", "verdict", VerdictFeasible)
	e.fail(pmo, "POST", fin, map[string]any{"decision": FinalPassed}, 409, "没有等你终审")
	for _, who := range []string{pm1, cto1} {
		if !hasKind(e.must(who, "GET", "/api/notifications", nil)["list"], "intake_final_returned") {
			t.Fatalf("%s 应收到终审退回的通知", who)
		}
	}

	// 退回后的推进里再次申请 CTO 协助:承接通过时,还在进行的协助一并结束
	e.must(pm1, "POST", sup, do("request", "请协助确认 OA 待办的推送时效"))
	got(t, e.must(cto1, "POST", sup, do("join", "")), "ctoSupport", "status", SupportJoined)

	// ---- 按意见调整后重新提交:另起一轮评估,这一轮由另一位 CTO 表决 ----
	e.must(pm1, "PUT", sol, map[string]any{"lines": []map[string]any{{"key": LineInterop, "solution": "单点登录与次日定时同步（业务已确认）"}}})
	rv2 := e.must(pm1, "POST", base+"/reviews", map[string]any{"summary": "已按终审意见调整"})
	rid2 := rv2["id"].(string)
	got(t, rv2, "round", float64(2))
	v = e.intake(cto2, pid)
	got(t, v, "round", float64(2))
	// 新一轮从空白开始:视图里是这一轮的结论,上一轮的结论不再显示(仍留在历史里)
	if n := len(dig(v, "points", "0", "assessments").([]any)); n != 0 {
		t.Fatalf("新一轮评估开始时不应带上一轮的结论,得到 %d 条", n)
	}
	// 上一轮的结论单独带着(prevAssessments),供 CTO 沿用
	sawCarried := false
	for _, raw := range dig(v, "points").([]any) {
		for _, prev := range dig(raw, "prevAssessments").([]any) {
			if dig(prev, "verdict") == VerdictInfeasible && strings.Contains(dig(prev, "note").(string), "纸质原件留存") {
				sawCarried = true
			}
		}
	}
	if !sawCarried {
		t.Fatalf("复评时应带上上一轮的结论供沿用: %+v", dig(v, "points"))
	}
	e.fail(cto2, "PUT", "/api/reviews/"+rid+"/assessment", map[string]any{"points": []map[string]any{pt(p1ID, VerdictFeasible, "")}}, 409, "已经结束")
	e.fail(cto2, "POST", "/api/reviews/"+rid2+"/decide", map[string]any{"decision": DecisionApprove, "points": []map[string]any{pt(p1ID, VerdictConditional, "")}}, 400, "写明条件")
	got(t, e.must(cto2, "POST", "/api/reviews/"+rid2+"/decide", map[string]any{
		"decision": DecisionApprove,
		"points":   []map[string]any{pt(p1ID, VerdictConditional, "上线前用 200 张样本实测识别准确率"), pt(p3ID, VerdictFeasible, "")},
	}), "status", ReviewApproved)
	v = e.finalIntake(pmo, pid, FinalPassedNotes, "影像识别准确率实测达标后复核")
	got(t, v, "phase", PhaseDone)
	got(t, v, "ctoSupport", "status", SupportNone)         // 承接完成,协助自动结束
	got(t, e.project(pm1, pid), "intake", "legacy", false) // 走完承接的不算「无承接记录」
	// 刚进入阶段 2、还没写过简报的项目不算「超过 7 天没有简报」;进入满 8 天后才提醒
	if err := scanUpdateDue(context.Background(), e.st); err != nil {
		t.Fatal(err)
	}
	if hasKind(e.must(pm1, "GET", "/api/notifications", nil)["list"], "update_due") {
		t.Fatalf("刚进入阶段 2 的项目不应收到「超过 7 天没有简报」")
	}
	if _, err := e.st.db.Exec(`UPDATE project_stages SET entered_at = now() - interval '8 days' WHERE project_id = $1 AND seq = 2`, pid); err != nil {
		t.Fatal(err)
	}
	if err := scanUpdateDue(context.Background(), e.st); err != nil {
		t.Fatal(err)
	}
	if !hasKind(e.must(pm1, "GET", "/api/notifications", nil)["list"], "update_due") {
		t.Fatalf("进入阶段 2 已满 8 天且没有简报,应提醒项目经理")
	}
	got(t, v, "finals", "0", "decision", FinalPassedNotes)
	got(t, v, "finals", "0", "round", float64(2))
	got(t, v, "finals", "1", "decision", FinalReturned) // 历次结论都留着,新到旧
	got(t, v, "points", "0", "assessments", "0", "userName", "钱技术")
	proj = e.project(pm1, pid)
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "stages", "0", "status", StageApproved)
	got(t, proj, "stages", "0", "rounds", float64(2))
	got(t, proj, "stages", "1", "status", StageInProgress)
	got(t, proj, "pendingOn", "pm")
	got(t, proj, "intake", "phase", PhaseDone)
	got(t, proj, "intake", "finalPending", false)
	// 承接完成:方案只读,不能再终审
	got(t, e.intake(pm1, pid), "can", "edit", false)
	e.fail(pm1, "PUT", sol, map[string]any{"summary": "x"}, 409, "只能在 PM 推进时修改")
	e.fail(pmo, "POST", fin, map[string]any{"decision": FinalPassed}, 409, "没有等你终审")
	for _, who := range []string{pm1, h1, cto1} {
		if !hasKind(e.must(who, "GET", "/api/notifications", nil)["list"], "intake_final_passed") {
			t.Fatalf("%s 应收到终审通过的通知", who)
		}
	}

	// ---- 时间线把整个过程记全了 ----
	_, events = e.list(admin, base+"/events")
	kinds := map[string]bool{}
	for _, raw := range events {
		kinds[raw.(map[string]any)["kind"].(string)] = true
	}
	for _, kind := range []string{
		"intake_triaged", "intake_solution_updated", "intake_point_added", "intake_point_updated", "intake_point_deleted",
		"cto_support_requested", "cto_support_joined", "cto_support_released", "cto_support_withdrawn",
		"intake_assessed", "intake_final_returned", "intake_final_passed",
	} {
		if !kinds[kind] {
			t.Errorf("时间线应包含 %s: %v", kind, kinds)
		}
	}
}

// 主负责 PM 的更替,以及最后一名 PM 被移除后项目回到待指派。
func TestIntakeLeadAndReassignment(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	pmo, _ := e.createUser(admin, "周琳", RoleViewer)
	pm1, pm1ID := e.createUser(admin, "陈昊", RolePM)
	_, pm2ID := e.createUser(admin, "林悦", RolePM)
	_, pm3ID := e.createUser(admin, "吴经理", RolePM)
	pid := e.readyForIntake(admin, pmo, pm1, pm1ID, "费用报销流程")
	members := func(body map[string]any) map[string]any {
		return e.must(pmo, "PUT", "/api/projects/"+pid+"/members", body)
	}

	// 再指派两名:主负责不变;可以把主负责换成后来者
	got(t, members(map[string]any{"userId": pm2ID, "role": RolePM, "action": "add"}), "leadPmId", pm1ID)
	got(t, members(map[string]any{"userId": pm3ID, "role": RolePM, "action": "add"}), "leadPmId", pm1ID)
	got(t, members(map[string]any{"userId": pm3ID, "role": RolePM, "action": "add", "lead": true}), "leadPmId", pm3ID)
	// 移除主负责:最早到岗的 PM 接任
	got(t, members(map[string]any{"userId": pm3ID, "role": RolePM, "action": "remove"}), "leadPmId", pm1ID)

	// 写了一些方案,然后移除全部 PM:项目回到待指派,由 PMO 重新指派
	e.must(pm1, "PUT", "/api/projects/"+pid+"/intake/solution", map[string]any{"summary": "先写下一部分"})
	got(t, members(map[string]any{"userId": pm1ID, "role": RolePM, "action": "remove"}), "leadPmId", pm2ID)
	proj := members(map[string]any{"userId": pm2ID, "role": RolePM, "action": "remove"})
	got(t, proj, "hasPm", false)
	got(t, proj, "leadPmId", "")
	got(t, proj, "leadPmName", "")
	got(t, proj, "stages", "0", "status", StagePending) // 阶段回到待开始
	got(t, proj, "pendingOn", PendingPMO)
	got(t, proj, "intake", "phase", PhaseAssign)
	if proj["startedAt"] != nil {
		t.Fatalf("回到待指派后不应保留启动时间: %+v", proj["startedAt"])
	}
	_, events := e.list(admin, "/api/projects/"+pid+"/events")
	sawLast := false
	for _, raw := range events {
		if ev := raw.(map[string]any); ev["kind"] == "member_removed" && dig(ev, "detail", "last") == true {
			sawLast = true
		}
	}
	if !sawLast {
		t.Fatalf("移除最后一名 PM 应在时间线里注明项目回到待指派: %+v", events)
	}
	// 没有 PM 时没人能改方案:已经不是 PM 的人没有修改权
	got(t, e.intake(pm1, pid), "can", "edit", false)
	e.fail(pm1, "PUT", "/api/projects/"+pid+"/intake/solution", map[string]any{"summary": "x"}, 403, "权限")

	// 重新指派:阶段重新启动;之前写下的方案还在
	proj = members(map[string]any{"userId": pm1ID, "role": RolePM, "action": "add"})
	got(t, proj, "stages", "0", "status", StageInProgress)
	got(t, proj, "leadPmId", pm1ID)
	got(t, proj, "pendingOn", "pm")
	if proj["startedAt"] == nil {
		t.Fatalf("重新指派后应重新记录启动时间")
	}
	got(t, e.intake(pm1, pid), "summary", "先写下一部分")
}

// 后台把第一阶段换成别的阶段(模板里不再以承接阶段开头)时,承接不生效,
// 项目按原来的方式走:管理员指派 PM、必交付物完成后提交、CTO 通过即进入下一阶段。
func TestIntakeDisabledWithoutIntakeStage(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	pmo, _ := e.createUser(admin, "周琳", RoleViewer)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	h1, h1ID := e.createUser(admin, "王经办", RoleHandler)

	// 模板去掉开头的承接阶段:此后新立项的项目,第一个阶段是「需求确认」
	tpl := e.mustArray(admin, "GET", "/api/admin/stage-templates", nil)
	e.mustArray(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": tpl[1:]})

	e.must("", "POST", "/api/processes", processPayload("直奔需求确认"))
	pid := e.projectByName(admin, "直奔需求确认")
	base := "/api/projects/" + pid
	proj := e.project(admin, pid)
	if proj["intake"] != nil {
		t.Fatalf("第一个阶段不是承接阶段的项目不应有承接摘要: %+v", proj["intake"])
	}
	// 新流程的通知也按模板说话:没有承接阶段时不提「初级分析」
	if !hasText(e.must(pmo, "GET", "/api/notifications", nil)["list"], "project_created", "等待指派 PM") {
		t.Fatalf("没有承接阶段的新流程,通知里应只说等待指派 PM")
	}
	// 仍是管理员指派,没有「等 PMO 初级分析」这一步;能指派 PM 是岗位带来的能力,与项目有没有承接阶段无关
	got(t, proj, "pendingOn", "admin")
	got(t, e.must(pmo, "GET", base, nil), "can", "assign", true)

	// 承接的接口一律拒绝,不会把数据写到别处
	e.fail(admin, "GET", base+"/intake", nil, 404, "承接阶段")
	e.fail(admin, "PUT", base+"/intake/triage", map[string]any{"value": "高"}, 400, "承接阶段")
	e.fail(pmo, "POST", base+"/intake/final", map[string]any{"decision": FinalPassed}, 400, "承接阶段")
	e.must(pmo, "PUT", base+"/members", map[string]any{"userId": pmID, "role": RolePM, "action": "add"})
	e.must(admin, "PUT", base+"/members", map[string]any{"userId": h1ID, "role": RoleHandler, "action": "add"})
	e.fail(pm, "PUT", base+"/intake/solution", map[string]any{"summary": "x"}, 400, "承接阶段")
	e.fail(pm, "POST", base+"/intake/points", map[string]any{"title": "x"}, 400, "承接阶段")
	e.fail(pm, "POST", base+"/intake/cto-support", map[string]any{"action": "request", "note": "x"}, 400, "承接阶段")

	// 原来的方式:PMO 不必先做初级分析就能指派(上一行已直接指派成功);准入条件是模板里的必交付物
	e.fail(pm, "POST", base+"/reviews", map[string]any{"summary": ""}, 400, "必交付物未完成")
	if n := e.completeRequired(pm, pid, 1); n != 3 {
		t.Fatalf("第一阶段应有 3 个必交付物待完成,得到 %d", n)
	}
	e.fail(pm, "POST", base+"/reviews", map[string]any{"summary": ""}, 400, "改造价值")
	e.must(pm, "PATCH", base, map[string]any{"value": "高", "complexity": "中"})
	ridN, rvN := e.submit(pm, pid, "需求已核对")
	got(t, rvN, "reviewerRole", RoleHandler)
	// 普通关卡不受理技术点的结论
	e.fail(h1, "POST", "/api/reviews/"+ridN+"/decide", map[string]any{
		"decision": DecisionApprove, "points": []map[string]any{{"pointId": "x", "verdict": VerdictFeasible}},
	}, 400, "只有技术可行性评估")
	// 经办会签通过后直接进入下一阶段,没有「等终审」这一步
	got(t, e.must(h1, "POST", "/api/reviews/"+ridN+"/decide", map[string]any{"decision": DecisionApprove}), "status", ReviewApproved)
	proj = e.project(pm, pid)
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "stages", "0", "status", StageApproved)
	got(t, proj, "pendingOn", "pm")
	if proj["intake"] != nil {
		t.Fatalf("不应出现承接摘要: %+v", proj["intake"])
	}
	// 承接相关的表里没有留下任何数据
	for _, tb := range []string{"intake_reviews", "intake_lines", "intake_node_plans", "intake_points", "intake_assessments", "intake_finals"} {
		var n int
		if err := e.st.db.QueryRow(`SELECT count(*) FROM ` + tb).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s 里不应有数据: %d %v", tb, n, err)
		}
	}
}

// 等终审超过 3 天的提醒;跳过承接阶段、取消项目、搁置与恢复时「等终审」标记的去向。
func TestIntakeFinalAgingSkipAndCancel(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	cto, _ := e.createUser(admin, "张技术", RoleCTO)
	pmo, _ := e.createUser(admin, "周琳", RoleViewer)
	pm, pmID := e.createUser(admin, "陈昊", RolePM)

	// ---- 终审积压:等超过 3 天,每天提醒一次 PMO,并知会管理员 ----
	pidA := e.readyForIntake(admin, pmo, pm, pmID, "流程甲")
	ridA := e.toFinalPending(pm, cto, pidA)
	if _, err := e.st.db.Exec(`UPDATE gate_reviews SET decided_at = now() - interval '4 days' WHERE id = $1`, ridA); err != nil {
		t.Fatal(err)
	}
	if err := runScheduledJobs(context.Background(), e.st); err != nil {
		t.Fatalf("定时任务执行失败: %v", err)
	}
	for _, who := range []string{pmo, admin} {
		if !hasKind(e.must(who, "GET", "/api/notifications", nil)["list"], "intake_final_aging") {
			t.Fatalf("%s 应收到终审积压提醒", who)
		}
	}
	pmoN := e.must(pmo, "GET", "/api/notifications", nil)
	if err := runScheduledJobs(context.Background(), e.st); err != nil {
		t.Fatal(err)
	}
	got(t, e.must(pmo, "GET", "/api/notifications", nil), "unread", dig(pmoN, "unread")) // 当天只提醒一次

	// ---- 跳过承接阶段(CTO / 管理员,须填原因):不再等终审,直接进入下一阶段 ----
	e.fail(pmo, "POST", "/api/projects/"+pidA+"/stages/1/skip", map[string]any{"reason": "x"}, 403, "权限")
	e.fail(admin, "POST", "/api/projects/"+pidA+"/stages/1/skip", map[string]any{"reason": ""}, 400, "必须填写原因")
	e.must(cto, "POST", "/api/projects/"+pidA+"/stages/1/skip", map[string]any{"reason": "改造很轻，直接进入需求确认"})
	proj := e.project(pm, pidA)
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "stages", "0", "status", StageSkipped)
	got(t, proj, "pendingOn", "pm")
	got(t, proj, "intake", "phase", PhaseDone)
	got(t, proj, "intake", "finalPending", false)
	e.fail(pmo, "POST", "/api/projects/"+pidA+"/intake/final", map[string]any{"decision": FinalPassed}, 409, "没有等你终审")

	// ---- 搁置与恢复:等终审的状态保留 ----
	pidB := e.readyForIntake(admin, pmo, pm, pmID, "流程乙")
	e.toFinalPending(pm, cto, pidB)
	got(t, e.must(pm, "POST", "/api/projects/"+pidB+"/status", map[string]any{"status": ProjOnHold, "note": "等预算"}), "pendingOn", "")
	// 搁置期间承接的写操作都暂停
	e.fail(pmo, "PUT", "/api/projects/"+pidB+"/intake/triage", map[string]any{"value": "高"}, 400, "不在进行中")
	e.fail(pmo, "POST", "/api/projects/"+pidB+"/intake/final", map[string]any{"decision": FinalPassed}, 400, "不在进行中")
	proj = e.must(cto, "POST", "/api/projects/"+pidB+"/status", map[string]any{"status": ProjActive})
	got(t, proj, "pendingOn", PendingPMO)
	got(t, proj, "intake", "phase", PhaseFinal)

	// ---- 等终审时取消项目:标记一并清掉,终审不再受理 ----
	pidC := e.readyForIntake(admin, pmo, pm, pmID, "流程丙")
	e.toFinalPending(pm, cto, pidC)
	proj = e.must(cto, "POST", "/api/projects/"+pidC+"/status", map[string]any{"status": ProjCancelled, "note": "业务调整"})
	got(t, proj, "pendingOn", "")
	got(t, proj, "intake", "finalPending", false)
	e.fail(pmo, "POST", "/api/projects/"+pidC+"/intake/final", map[string]any{"decision": FinalPassed}, 400, "不在进行中")
	if err := runScheduledJobs(context.Background(), e.st); err != nil {
		t.Fatal(err)
	}
	for _, raw := range e.must(admin, "GET", "/api/notifications", nil)["list"].([]any) {
		if n := raw.(map[string]any); n["kind"] == "intake_final_aging" && n["projectId"] == pidC {
			t.Fatalf("已取消的项目不应再提醒终审: %+v", n)
		}
	}
}

// 需求承接启用前就立项并通过第一阶段的项目,或这个阶段被直接跳过:没有任何承接记录,
// 不能冒充「承接完成」——界面不给出「承接」标签,导出里如实写明。
func TestIntakeLegacyProject(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	e.must("", "POST", "/api/processes", travelPayload("早就立项的流程"))
	pid := e.projectByName(admin, "早就立项的流程")
	base := "/api/projects/" + pid
	got(t, e.project(admin, pid), "intake", "legacy", false) // 还停在承接阶段:等 PMO 初级分析
	e.must(admin, "POST", base+"/stages/1/skip", map[string]any{"reason": "改造很轻,不走承接"})

	proj := e.project(admin, pid)
	got(t, proj, "currentStage", float64(2))
	got(t, proj, "intake", "phase", PhaseDone)
	got(t, proj, "intake", "legacy", true)
	got(t, proj, "pendingOn", "admin") // 已经离开承接阶段、还没有 PM:是待指派,不算到 PMO 的初级分析头上
	got(t, e.intake(admin, pid), "legacy", true)
	// 诊断数字照旧给(它说的是流程本身),导出里不写「承接完成」
	got(t, proj, "intake", "offline", float64(3))
	if _, _, md := e.raw(admin, base+"/export"); !strings.Contains(md, "这个阶段没有承接记录") || strings.Contains(md, "| 承接完成 |") {
		t.Fatalf("没有承接记录的项目,报告里应如实说明:\n%s", md)
	}
	if _, _, csv := e.raw(admin, "/api/projects/export.csv"); !strings.Contains(csv, "无承接记录") || strings.Contains(csv, "承接完成") {
		t.Fatalf("清单里应写「无承接记录」:\n%s", csv)
	}
}
