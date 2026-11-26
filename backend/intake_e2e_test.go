package main

import (
	"strings"
	"testing"
)

// 端到端:需求承接。连真实 PostgreSQL、走真实路由表,把
// 「提交 → PMO 初级分析 → 指派多名 PM → 三条推进线 → 申请 CTO 协助 → 提交技术可行性评估
//   → CTO 逐项评估 → PMO 终审(退回 / 通过)→ 进入下一阶段」整条闭环跑一遍,
// 并逐个核对每一步的越权与边界。测试工具函数 fillIntake / approveIntake / finalIntake 也供其他用例使用。

// intake 取承接的完整视图
func (e *env) intake(token, pid string) map[string]any {
	e.t.Helper()
	return e.must(token, "GET", "/api/projects/"+pid+"/intake", nil)
}

// fillIntake 把承接方案填到可以提交评估:流程完整性、综合方案总述、三条推进线的原因与方案,
// 再录入一个技术点。测试流程(processPayload)三类节点都有,所以三条线都要写。
func (e *env) fillIntake(pm, pid string) {
	e.t.Helper()
	e.must(pm, "PUT", "/api/projects/"+pid+"/intake/solution", map[string]any{
		"completeness": Complete, "completenessNote": "退回路径已补全",
		"summary": "全部节点线上办理、系统互通并支持移动端",
		"lines": []map[string]any{
			{"key": LineOffline, "reason": "财务要求核对原件", "solution": "发票影像上传"},
			{"key": LineInterop, "reason": "两套系统从未对接", "solution": "单点登录与结果回写"},
			{"key": LineMobile, "reason": "合同系统没有移动端", "solution": "移动待办页承接"},
		},
	})
	e.must(pm, "POST", "/api/projects/"+pid+"/intake/points", map[string]any{
		"title": "发票影像识别准确率", "line": LineOffline, "note": "上线前用 200 张样本实测",
	})
}

// approveIntake 评审人给项目的每个技术点下「可行」的结论,并表决通过
func (e *env) approveIntake(cto, pid, reviewID string) map[string]any {
	e.t.Helper()
	return e.approveIntakeWith(cto, pid, reviewID, "")
}

// approveIntakeWith 同 approveIntake,表决时带上评审意见
func (e *env) approveIntakeWith(cto, pid, reviewID, comment string) map[string]any {
	e.t.Helper()
	return e.must(cto, "POST", "/api/reviews/"+reviewID+"/decide", map[string]any{
		"decision": DecisionApprove, "comment": comment, "points": e.feasiblePoints(cto, pid),
	})
}

// feasiblePoints 项目的每个技术点各一条「可行」结论
func (e *env) feasiblePoints(token, pid string) []map[string]any {
	e.t.Helper()
	points := []map[string]any{}
	for _, raw := range dig(e.intake(token, pid), "points").([]any) {
		points = append(points, map[string]any{"pointId": dig(raw, "id"), "verdict": VerdictFeasible})
	}
	if len(points) == 0 {
		e.t.Fatalf("项目此时应至少有一个技术点")
	}
	return points
}

// finalIntake 终审人(测试里用管理员兜底)给出终审结论
func (e *env) finalIntake(final, pid, decision, note string) map[string]any {
	e.t.Helper()
	return e.must(final, "POST", "/api/projects/"+pid+"/intake/final", map[string]any{"decision": decision, "note": note})
}

// 报告流程:与设计稿同款(员工差旅报销,12 个节点)——线下 3、系统不互通 3、无法实现移动端 4,
// 另含一个会签,用来核对会签内部子步骤的诊断。
func travelPayload(name string) map[string]any {
	blank := map[string]any{"documents": []any{}, "handlers": []any{}}
	on := func(sys string, mobile bool, interop any) map[string]any {
		return map[string]any{"systemName": sys, "mobileSupported": mobile, "dataInteroperable": interop}
	}
	step := func(id, name, mode string, online map[string]any, parties []any) map[string]any {
		return map[string]any{"id": id, "name": name, "mode": mode, "countersign": len(parties) > 0,
			"online": online, "offline": blank, "parties": parties, "waitFor": nil, "remark": ""}
	}
	off := func(id, name string) map[string]any {
		return map[string]any{"id": id, "name": name, "mode": "offline", "countersign": false,
			"online":  map[string]any{"systemName": "", "mobileSupported": nil},
			"offline": map[string]any{"documents": []any{}, "handlers": []map[string]any{{"department": "财务部", "staff": []string{}}}},
			"parties": []any{}, "waitFor": nil, "remark": ""}
	}
	// no = 与上一步系统不互通
	no := false
	return map[string]any{
		"name": name, "description": "", "applicant": "周琳",
		"steps": []map[string]any{
			step("t1", "提交出差申请", "online", on("OA", true, nil), []any{}),
			step("t2", "部门主管审批", "online", on("OA", true, nil), []any{}),
			step("t3", "分管领导审批", "online", on("OA", true, nil), []any{}),
			step("t4", "行程预订", "online", on("商旅平台", false, no), []any{}), // 与 OA 不互通
			step("t5", "借款申请", "online", on("费控", false, no), []any{}),   // 与商旅平台不互通
			step("t6", "报销单填写", "online", on("费控", false, nil), []any{}),
			off("t7", "发票粘贴与签字"),
			off("t8", "部门预算审核"),
			step("t9", "财务复核", "online", on("财务系统", false, nil), []any{}), // 上一步线下,不涉及互通
			step("t10", "出纳付款", "online", on("财务系统", true, nil), []any{}),
			step("t11", "付款结果回写", "online", on("费控", true, no), []any{}), // 与财务系统不互通
			off("t12", "纸质凭证归档"),
		},
	}
}

// 差旅流程的自动诊断:三类节点各是哪几个
func TestIntakeDiagnosisThroughAPI(t *testing.T) {
	e := newTestEnv(t)
	admin := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})["token"].(string)
	if code, _ := e.req(admin, "POST", "/api/processes", travelPayload("员工差旅报销流程")); code != 201 {
		t.Fatalf("提交流程期望 201,得到 %d", code)
	}
	pid := e.projectByName(admin, "员工差旅报销流程")

	// 未登录不能看;项目没有承接阶段以外的路径都挂在项目下
	e.fail("", "GET", "/api/projects/"+pid+"/intake", nil, 401, "未登录")
	e.fail(admin, "GET", "/api/projects/nope/intake", nil, 404, "不存在")

	// 列表里的摘要
	_, list := e.list(admin, "/api/projects")
	got(t, list[0], "intake", "phase", PhaseTriage)
	got(t, list[0], "intake", "offline", float64(3))
	got(t, list[0], "intake", "interop", float64(3))
	got(t, list[0], "intake", "mobile", float64(4))
	got(t, list[0], "pendingOn", PendingPMO)
	got(t, e.project(admin, pid), "pendingOn", PendingPMO)

	// 完整视图:三类节点按步骤顺序,带序号、名称、系统与上一衔接处的系统
	v := e.intake(admin, pid)
	got(t, v, "phase", PhaseTriage)
	got(t, v, "asIs", "steps", float64(12))
	names := func(line string) []string {
		out := []string{}
		for _, raw := range dig(v, "asIs", line).([]any) {
			out = append(out, dig(raw, "name").(string))
		}
		return out
	}
	if got := names("offline"); strings.Join(got, ",") != "发票粘贴与签字,部门预算审核,纸质凭证归档" {
		t.Fatalf("线下节点: %v", got)
	}
	if got := names("interop"); strings.Join(got, ",") != "行程预订,借款申请,付款结果回写" {
		t.Fatalf("系统不互通: %v", got)
	}
	if got := names("mobile"); strings.Join(got, ",") != "行程预订,借款申请,报销单填写,财务复核" {
		t.Fatalf("无法移动端: %v", got)
	}
	// 同一个节点(行程预订)既不互通也不支持移动端,标识相同
	if dig(v, "asIs", "interop", "0", "key") != dig(v, "asIs", "mobile", "0", "key") ||
		dig(v, "asIs", "interop", "0", "from") != "OA" || dig(v, "asIs", "interop", "1", "from") != "商旅平台" ||
		dig(v, "asIs", "interop", "2", "from") != "财务系统" || dig(v, "asIs", "mobile", "0", "system") != "商旅平台" ||
		dig(v, "asIs", "offline", "2", "step") != float64(12) {
		t.Fatalf("节点上的系统与序号不符: %+v", dig(v, "asIs"))
	}
	// 立项时与当前工作副本相同(还没改过流程定义);三条线按解决顺序,节点挂在各自名下
	got(t, v, "current", "offline", "2", "name", "纸质凭证归档")
	if len(dig(v, "lines").([]any)) != 3 ||
		dig(v, "lines", "0", "key") != LineOffline || dig(v, "lines", "1", "key") != LineInterop || dig(v, "lines", "2", "key") != LineMobile ||
		len(dig(v, "lines", "0", "nodes").([]any)) != 3 || len(dig(v, "lines", "1", "nodes").([]any)) != 3 || len(dig(v, "lines", "2", "nodes").([]any)) != 4 ||
		dig(v, "lines", "0", "nodes", "0", "status") != PlanPending || dig(v, "lines", "0", "remaining") != float64(3) {
		t.Fatalf("三条推进线: %+v", v["lines"])
	}
	// JSON 列表字段恒为数组
	for _, key := range []string{"points", "finals", "missing", "ownLines"} {
		if _, ok := v[key].([]any); !ok {
			t.Fatalf("%s 应为数组: %#v", key, v[key])
		}
	}
	// 提交评估前的缺项:与规则一致,按顺序列出
	want := []string{"还没确认流程是否完整", "「线下节点转线上」还没写原因", "「线下节点转线上」还没写解决方案",
		"「系统不互通」还没写原因", "「系统不互通」还没写解决方案", "「线上节点移动化」还没写原因", "「线上节点移动化」还没写解决方案",
		"还没写综合方案总述", "还没有供 CTO 评估的技术点", "还没评估改造价值", "还没评估复杂度"}
	if missing := v["missing"].([]any); len(missing) != len(want) {
		t.Fatalf("缺项: %v", missing)
	} else {
		for i := range want {
			if missing[i] != want[i] {
				t.Fatalf("缺项[%d]: got %v want %v", i, missing[i], want[i])
			}
		}
	}
	// 管理员能初析、能指派;能力表由服务端下发
	got(t, v, "can", "triage", true)
	got(t, v, "can", "assign", true)
	got(t, v, "can", "final", false)
	got(t, v, "can", "edit", false)
	got(t, v, "ctoSupport", "status", SupportNone)
}
