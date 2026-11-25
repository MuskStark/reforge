package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func pb(v bool) *bool { return &v }

func onInfo(sys string, mobile bool, interop *bool) OnlineInfo {
	return OnlineInfo{SystemName: sys, MobileSupported: pb(mobile), DataInteroperable: interop}
}

// e2eFlow 与端到端用例同款流程:线上 OA → 会签(财务线上 / 法务线上) → 线上 OA(与会签系统不互通) → 线下
func e2eFlow() []Step {
	blank := OfflineInfo{}
	return []Step{
		{ID: "s1", Name: "提交申请", Mode: "online", Online: onInfo("OA", true, nil), Offline: blank},
		{ID: "s2", Name: "部门会签", Mode: "online", Countersign: true, Parties: []Party{
			{ID: "p1", Department: "财务部", Staff: []string{"王经办"}, SubSteps: []SubStep{
				{ID: "p1a", Name: "财务复核", Mode: "online", Online: onInfo("财务共享平台", true, nil), Offline: blank},
			}},
			{ID: "p2", Department: "法务部", Staff: []string{"赵经办"}, SubSteps: []SubStep{
				{ID: "p2a", Name: "合同会签", Mode: "online", Online: onInfo("合同系统", false, nil), Offline: blank},
			}},
		}},
		{ID: "s3", Name: "归档", Mode: "online", Online: onInfo("OA", true, pb(false)), Offline: blank},
		{ID: "s4", Name: "纸质归档", Mode: "offline", Online: onInfo("", false, nil),
			Offline: OfflineInfo{Handlers: []Handler{{Department: "行政部"}}}},
	}
}

func TestComputeMetrics_CountersignFlow(t *testing.T) {
	m := ComputeMetrics(e2eFlow())
	want := FlowMetrics{Steps: 6, OnlineSteps: 4, OfflineSteps: 1, OfflineShare: 0.167,
		Breakpoints: 2, Systems: 3, MobileSteps: 3, MobileShare: 0.75, Countersigns: 1}
	if m != want {
		t.Fatalf("指标不符:\n got %+v\nwant %+v", m, want)
	}
}

// TestComputeMetrics_MixedCountersign 对应浏览器里逐条核对过虚线的那张图:
// 线上OA → 会签(财务部:线上初审→线下签字;法务部:线上) → 线上OA(不互通) → 线下 → 线上
func TestComputeMetrics_MixedCountersign(t *testing.T) {
	blank := OfflineInfo{}
	steps := []Step{
		{ID: "a", Name: "提交申请", Mode: "online", Online: onInfo("OA", true, nil), Offline: blank},
		{ID: "b", Name: "部门会签", Mode: "online", Countersign: true, Parties: []Party{
			{ID: "f", Department: "财务部", Staff: []string{"张三"}, SubSteps: []SubStep{
				{ID: "f1", Name: "初审", Mode: "online", Online: onInfo("财务共享平台", true, nil), Offline: blank},
				{ID: "f2", Name: "签字", Mode: "offline", Online: onInfo("", false, nil),
					Offline: OfflineInfo{Handlers: []Handler{{Department: "财务部"}}}},
			}},
			{ID: "l", Department: "法务部", Staff: []string{"李四"}, SubSteps: []SubStep{
				{ID: "l1", Name: "合同会签", Mode: "online", Online: onInfo("合同系统", true, nil), Offline: blank},
			}},
		}},
		{ID: "c", Name: "归档", Mode: "online", Online: onInfo("OA", true, pb(false)), Offline: blank},
		{ID: "d", Name: "纸质归档", Mode: "offline", Online: onInfo("", false, nil),
			Offline: OfflineInfo{Handlers: []Handler{{Department: "行政部"}}}},
		{ID: "e", Name: "复核", Mode: "online", Online: onInfo("OA", true, nil), Offline: blank},
	}
	m := ComputeMetrics(steps)
	// 断点:进会签(线上→混合) 1 + 出会签(混合→线上且不互通) 1 + 归档→纸质归档 1 + 纸质归档→复核 1 + 泳道内 初审→签字 1
	want := FlowMetrics{Steps: 8, OnlineSteps: 5, OfflineSteps: 2, OfflineShare: 0.25,
		Breakpoints: 5, Systems: 3, MobileSteps: 5, MobileShare: 1, Countersigns: 1}
	if m != want {
		t.Fatalf("指标不符:\n got %+v\nwant %+v", m, want)
	}
}

func TestComputeMetrics_MainStepsOnly(t *testing.T) {
	blank := OfflineInfo{}
	m := ComputeMetrics([]Step{
		{ID: "a", Name: "提交申请", Mode: "online", Online: onInfo("OA", true, nil), Offline: blank},
		{ID: "b", Name: "审批", Mode: "online", Online: onInfo("ERP", true, pb(false)), Offline: blank},
		{ID: "c", Name: "复核", Mode: "online", Online: onInfo("OA", true, pb(true)), Offline: blank},
		{ID: "d", Name: "纸质归档", Mode: "offline", Online: onInfo("", false, nil),
			Offline: OfflineInfo{Handlers: []Handler{{Department: "行政部"}}}},
	})
	want := FlowMetrics{Steps: 4, OnlineSteps: 3, OfflineSteps: 1, OfflineShare: 0.25,
		Breakpoints: 2, Systems: 2, MobileSteps: 3, MobileShare: 1}
	if m != want {
		t.Fatalf("指标不符:\n got %+v\nwant %+v", m, want)
	}
}

// 系统相同时残留的"不互通"结论不算断点;未命名子步骤不计数
func TestComputeMetrics_IgnoresStaleAndUnnamed(t *testing.T) {
	blank := OfflineInfo{}
	m := ComputeMetrics([]Step{
		{ID: "a", Name: "提交申请", Mode: "online", Online: onInfo("OA", true, nil), Offline: blank},
		{ID: "b", Name: "审批", Mode: "online", Online: onInfo("OA", true, pb(false)), Offline: blank},
		{ID: "c", Name: "会签", Mode: "online", Countersign: true, Parties: []Party{
			{ID: "p", Department: "财务部", SubSteps: []SubStep{{ID: "x", Name: "", Mode: "offline"}}},
		}},
	})
	if m.Breakpoints != 0 || m.Steps != 3 || m.OfflineSteps != 0 || m.Countersigns != 1 {
		t.Fatalf("未预期的指标: %+v", m)
	}
}

func TestCapsMatrix(t *testing.T) {
	member := actor{SysRole: "member"}
	cto := actor{SysRole: "member", JobRole: RoleCTO}
	pmo := actor{SysRole: "member", JobRole: RoleViewer}
	admin := actor{SysRole: "admin"}
	cases := []struct {
		name  string
		a     actor
		roles []string
		check func(c caps) bool
		want  bool
	}{
		{"经办可评经办关卡但不能评 CTO 关卡", member, []string{RoleHandler}, func(c caps) bool { return c.canReview(RoleHandler) }, true},
		{"经办不能评 CTO 关卡", member, []string{RoleHandler}, func(c caps) bool { return c.canReview(RoleCTO) }, false},
		{"项目经理不能表决", member, []string{RolePM}, func(c caps) bool { return c.canReview(RoleCTO) || c.canReview(RoleHandler) }, false},
		{"项目经理可推进", member, []string{RolePM}, func(c caps) bool { return c.manage() }, true},
		{"项目经理不能指派 PM", member, []string{RolePM}, func(c caps) bool { return c.assign() }, false},
		{"项目经理不能初析、不能终审", member, []string{RolePM}, func(c caps) bool { return c.triage() || c.finalReview() }, false},
		{"CTO 全局可评 CTO 关卡", cto, nil, func(c caps) bool { return c.canReview(RoleCTO) }, true},
		{"CTO 不能评经办关卡", cto, nil, func(c caps) bool { return c.canReview(RoleHandler) }, false},
		{"CTO 可跳过阶段、不能指派 PM", cto, nil, func(c caps) bool { return c.skip() && !c.assign() }, true},
		{"CTO 不能初析、不能终审", cto, nil, func(c caps) bool { return c.triage() || c.finalReview() }, false},
		{"管理员全权", admin, nil, func(c caps) bool {
			return c.assign() && c.skip() && c.manage() && c.canReview(RoleHandler) && c.triage() && c.finalReview()
		}, true},
		// PMO 是全局岗位:初级分析、指派 PM、终审都不需要逐项目授予;除此以外仍然只读
		{"PMO 可初析、指派 PM、终审", pmo, nil, func(c caps) bool { return c.triage() && c.assign() && c.finalReview() }, true},
		{"PMO 不能推进、表决、跳过", pmo, nil, func(c caps) bool {
			return c.manage() || c.canReview(RoleCTO) || c.canReview(RoleHandler) || c.skip() || c.editFlow()
		}, false},
		{"PMO 不能分配 BH / TH / PMO 成员", pmo, nil, func(c caps) bool { return c.canAssign(RoleHandler) || c.canAssign(RoleDev) || c.canAssign(RoleViewer) }, false},
		{"PMO 被加进项目后仍然只读(不参与评论与工作项)", pmo, []string{RoleViewer}, func(c caps) bool { return c.member() || c.manage() }, false},
		{"观察者只读", member, []string{RoleViewer}, func(c caps) bool { return c.member() }, false},
		{"只有 PMO 成员角色、岗位不是 PMO:没有初析与终审权", member, []string{RoleViewer}, func(c caps) bool { return c.triage() || c.assign() || c.finalReview() }, false},
		{"非成员没有任何写权", member, nil, func(c caps) bool { return c.member() || c.manage() || c.assign() }, false},
	}
	for _, tc := range cases {
		c := capsFor(tc.a, tc.roles)
		if got := tc.check(c); tc.want != got {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
		// 交给前端的能力表必须和实际判定一致
		f := c.flags()
		if f["triage"] != c.triage() || f["final"] != c.finalReview() || f["isPMO"] != c.PMO || f["assign"] != c.assign() {
			t.Errorf("%s: 能力表与实际判定不一致: %v", tc.name, f)
		}
	}
}

// 流程的权限分配按类划分:管理员全部;PMO 指派 PM;CTO 分配科技侧经办(开发实施);项目经理分配业务侧经办(经办)
func TestAssignMatrix(t *testing.T) {
	member := actor{SysRole: "member"}
	all := []string{RolePM, RoleHandler, RoleDev, RoleViewer}
	none := map[string]bool{RolePM: false, RoleHandler: false, RoleDev: false, RoleViewer: false}
	cases := []struct {
		name  string
		a     actor
		roles []string
		want  map[string]bool
	}{
		{"管理员分配全部", actor{SysRole: "admin"}, nil, map[string]bool{RolePM: true, RoleHandler: true, RoleDev: true, RoleViewer: true}},
		{"CTO 只分配科技侧经办", actor{SysRole: "member", JobRole: RoleCTO}, nil, map[string]bool{RolePM: false, RoleHandler: false, RoleDev: true, RoleViewer: false}},
		{"PMO 只指派项目经理", actor{SysRole: "member", JobRole: RoleViewer}, nil, map[string]bool{RolePM: true, RoleHandler: false, RoleDev: false, RoleViewer: false}},
		{"项目经理只分配业务侧经办", member, []string{RolePM}, map[string]bool{RolePM: false, RoleHandler: true, RoleDev: false, RoleViewer: false}},
		{"经办不能分配任何人", member, []string{RoleHandler}, none},
		{"开发实施不能分配任何人", member, []string{RoleDev}, none},
		{"只有 PMO 成员角色、岗位不是 PMO:不能分配任何人", member, []string{RoleViewer}, none},
		{"非成员不能分配任何人", member, nil, none},
		{"CTO 兼项目经理:两侧经办都能分配,仍不能指派 PM", actor{SysRole: "member", JobRole: RoleCTO}, []string{RolePM}, map[string]bool{RolePM: false, RoleHandler: true, RoleDev: true, RoleViewer: false}},
		{"PMO 兼项目经理:能指派 PM,也能分配 BH,不能分配 TH 与 PMO 成员", actor{SysRole: "member", JobRole: RoleViewer}, []string{RolePM}, map[string]bool{RolePM: true, RoleHandler: true, RoleDev: false, RoleViewer: false}},
	}
	for _, tc := range cases {
		c := capsFor(tc.a, tc.roles)
		for _, role := range all {
			if got := c.canAssign(role); got != tc.want[role] {
				t.Errorf("%s: 分配 %s got %v want %v", tc.name, role, got, tc.want[role])
			}
		}
		if c.canAssign("owner") {
			t.Errorf("%s: 未知角色不应可分配", tc.name)
		}
		// 交给前端的能力表必须和实际判定一致
		f := c.flags()
		if f["assignHandler"] != c.canAssign(RoleHandler) || f["assignDev"] != c.canAssign(RoleDev) || f["assignViewer"] != c.canAssign(RoleViewer) || f["assign"] != c.canAssign(RolePM) {
			t.Errorf("%s: 能力表与 canAssign 不一致: %v", tc.name, f)
		}
	}
}

func TestLegacyFromProcess(t *testing.T) {
	pm := "pm-user-id"
	cases := []struct {
		name   string
		p      *Process
		status string
		cur    int
		stage1 string
	}{
		{"分析中", &Process{FollowStatus: "analyzing"}, ProjActive, 1, StagePending},
		{"待指派", &Process{FollowStatus: "unassigned"}, ProjActive, 1, StagePending},
		{"跟进中·阶段3", &Process{FollowStatus: "following", Stage: 3, AssigneeID: pm}, ProjActive, 4, StageApproved},
		{"待验收", &Process{FollowStatus: "review", AssigneeID: pm}, ProjActive, 6, StageApproved},
		{"已完成", &Process{FollowStatus: "done", Stage: 5}, ProjDone, 7, StageApproved},
		{"已搁置", &Process{FollowStatus: "shelved", Stage: 1, AssigneeID: pm}, ProjOnHold, 2, StageApproved},
	}
	for _, tc := range cases {
		l := legacyFromProcess(tc.p, false)
		if l.Status != tc.status || l.Current != tc.cur || l.StageStatus[1] != tc.stage1 {
			t.Errorf("%s: status=%s cur=%d stage1=%s; want %s/%d/%s",
				tc.name, l.Status, l.Current, l.StageStatus[1], tc.status, tc.cur, tc.stage1)
		}
	}
	l := legacyFromProcess(&Process{FollowStatus: "following", Stage: 2, AssigneeID: pm,
		Analysis: json.RawMessage(`{"value":"高","complexity":"低","priority":"高"}`), DueDate: "2026-12-31"}, true)
	if l.Value != "高" || l.Complexity != "低" || l.Priority != "high" || l.PMUserID != pm || l.DueDate != "2026-12-31" || !l.Edited {
		t.Fatalf("旧跟进字段未正确迁入: %+v", l)
	}
	if l.StageStatus[3] != StageInProgress || l.StageStatus[2] != StageApproved {
		t.Fatalf("跟进中阶段 2 应映射为阶段 3 进行中: %+v", l.StageStatus)
	}
}

func TestPendingOn(t *testing.T) {
	tpl := defaultStageTemplates()
	active := &Project{Status: ProjActive, CurrentStage: 1}
	// 承接阶段(内置模板的第一阶段):还没指派 PM 时等 PMO 初级分析与指派
	if got := pendingOnOf(tpl, active, ProjectStage{Seq: 1, Status: StagePending}, false); got != PendingPMO {
		t.Fatalf("承接阶段未指派 PM 时应为 pmo,得到 %q", got)
	}
	// 没有承接阶段的模板(后台把第一阶段换成了别的):仍是管理员指派
	plain := append([]StageTemplate{tpl[1]}, tpl[2:]...)
	if got := pendingOnOf(plain, active, ProjectStage{Seq: 1, Status: StagePending}, false); got != "admin" {
		t.Fatalf("没有承接阶段时应为 admin,得到 %q", got)
	}
	if got := pendingOnOf(tpl, active, ProjectStage{Seq: 1, Status: StageInProgress}, true); got != "pm" {
		t.Fatalf("阶段进行中应为 pm,得到 %q", got)
	}
	// 技术可行性评估已通过、等 PMO 终审
	awaiting := &Project{Status: ProjActive, CurrentStage: 1, FinalStatus: FinalPending}
	if got := pendingOnOf(tpl, awaiting, ProjectStage{Seq: 1, Status: StageInReview}, true); got != PendingPMO {
		t.Fatalf("等 PMO 终审时应为 pmo,得到 %q", got)
	}
	awaiting.Status = ProjOnHold
	if got := pendingOnOf(tpl, awaiting, ProjectStage{Seq: 1, Status: StageInReview}, true); got != "" {
		t.Fatalf("已搁置的项目不应有待办人,得到 %q", got)
	}
	review := &Project{Status: ProjActive, CurrentStage: 3}
	if got := pendingOnOf(tpl, review, ProjectStage{Seq: 3, Status: StageInReview}, true); got != RoleCTO {
		t.Fatalf("方案评审中应为 cto,得到 %q", got)
	}
	review.CurrentStage = 2
	if got := pendingOnOf(tpl, review, ProjectStage{Seq: 2, Status: StageInReview}, true); got != RoleHandler {
		t.Fatalf("需求基线评审中应为 handler,得到 %q", got)
	}
	done := &Project{Status: ProjDone, CurrentStage: 7}
	if got := pendingOnOf(tpl, done, ProjectStage{Seq: 7, Status: StageInProgress}, true); got != "" {
		t.Fatalf("已完成项目不应有待办人,得到 %q", got)
	}
}

func TestHandlerHintsAndMentions(t *testing.T) {
	p := &Process{Applicant: "孙申报", Steps: []Step{
		{Offline: OfflineInfo{Handlers: []Handler{{Department: "行政部", Staff: []string{"王经办", "王经办"}}}}},
		{Countersign: true, Parties: []Party{{Staff: []string{"赵经办"}}}},
	}}
	users := []*User{
		{ID: "u1", Username: "wang", DisplayName: "王经办"},
		{ID: "u2", Username: "zhao", DisplayName: "赵经办"},
	}
	hints := HandlerHints(p, users)
	if len(hints) != 3 || hints[0].Raw != "孙申报" || hints[0].Matched ||
		hints[1].UserID != "u1" || !hints[1].Matched || hints[2].UserID != "u2" {
		t.Fatalf("经办候选不符: %+v", hints)
	}
	m := parseMentions("@王经办 和 @zhao 请看一下,@不存在 的忽略", users)
	if len(m) != 2 || m[0].ID != "u1" || m[1].ID != "u2" {
		t.Fatalf("@提及解析不符: %+v", m)
	}
}

func TestSnapshotKindAndTemplate(t *testing.T) {
	tpl := defaultStageTemplates()
	pr := &Project{tpl: tpl}
	if len(tpl) != 7 {
		t.Fatalf("内置模板应有 7 个阶段,得到 %d", len(tpl))
	}
	for _, st := range tpl[:6] {
		if st.Gate == "" || (st.Mode != ModeAll && st.Mode != ModeAny) || (st.ReviewerRole != RoleCTO && st.ReviewerRole != RoleHandler) {
			t.Fatalf("阶段 %d 的关卡配置不完整: %+v", st.Seq, st)
		}
		if len(st.Required) == 0 {
			t.Fatalf("阶段 %d 应有必交付物", st.Seq)
		}
	}
	if tpl[6].Gate != "" {
		t.Fatal("运营优化阶段不应有门禁")
	}
	if _, ok := templateAt(tpl, 8); ok {
		t.Fatal("越界阶段不应存在")
	}
	// 版本快照时机由阶段标识决定:方案设计 → To-Be 基线;验收上线 → 已发布
	if pr.snapshotKind(3) != "to_be" || pr.snapshotKind(6) != "published" || pr.snapshotKind(1) != "" || pr.snapshotKind(4) != "" {
		t.Fatalf("版本快照时机不符: %q %q", pr.snapshotKind(3), pr.snapshotKind(6))
	}
	if pr.stageCount() != 7 || pr.stageName(4) != "系统改造" || pr.nextStageName(6) != "运营优化" || pr.nextStageName(7) != "" {
		t.Fatalf("按模板取阶段名不符: %d %q %q", pr.stageCount(), pr.stageName(4), pr.nextStageName(6))
	}
	accept, ok := pr.acceptStage()
	if !ok || accept.Key != keyAccept || accept.Seq != 6 {
		t.Fatalf("内置模板的验收阶段应为阶段 6,得到 %+v", accept)
	}
	// 没有快照的旧项目按内置模板处理
	legacy := &Project{}
	if legacy.stageCount() != 7 || legacy.snapshotKind(6) != "published" {
		t.Fatal("没有模板快照的项目应回退到内置模板")
	}
	// 内置模板是拷贝出来的,调用方改了不会污染全局
	tpl[0].Required = append(tpl[0].Required, "被改坏了")
	if len(defaultStageTemplates()[0].Required) != 1 {
		t.Fatal("defaultStageTemplates 应每次返回独立拷贝")
	}
}

func TestProjectTemplateSnapshot(t *testing.T) {
	// 项目快照里的模板可以和当前模板完全不同:名称、阶段数、关卡规则都以快照为准
	custom := []StageTemplate{
		{Seq: 1, Key: "intake", Name: "立项", Gate: "G1", ReviewerRole: RoleHandler, Mode: ModeAll, Required: []string{"立项书"}, Tasks: []string{}},
		{Seq: 2, Key: keyDesign, Name: "方案", Gate: "G2", ReviewerRole: RoleCTO, Mode: ModeAny, Required: []string{}, Tasks: []string{}},
	}
	pr := &Project{tpl: parseTemplate([]byte(templateJSON(custom)))}
	if pr.stageCount() != 2 || pr.stageName(1) != "立项" || pr.stageName(3) != "未知阶段" || pr.nextStageName(2) != "" {
		t.Fatalf("项目应按自己的快照取阶段: %d %q %q %q", pr.stageCount(), pr.stageName(1), pr.stageName(3), pr.nextStageName(2))
	}
	if pr.snapshotKind(2) != "to_be" {
		t.Fatalf("标识为 design 的阶段通过时应留 To-Be 基线,得到 %q", pr.snapshotKind(2))
	}
	// 没有 accept 阶段时,完成前置条件退到最后一个带关卡的阶段
	if a, ok := pr.acceptStage(); !ok || a.Seq != 2 {
		t.Fatalf("没有验收阶段时应取最后一个带关卡的阶段,得到 %+v", a)
	}
	// 坏数据 / 空数据一律回退到内置模板,引擎不会因为一条坏快照卡死
	for _, raw := range []string{"", "[]", "null", "{", `[{"key":"x"}]`} {
		if tpl := parseTemplate([]byte(raw)); len(tpl) == 0 {
			t.Fatalf("解析 %q 不应得到空模板", raw)
		}
	}
	if got := parseTemplate([]byte(`[{"key":"a"},{"key":"b"}]`)); got[0].Seq != 1 || got[1].Seq != 2 {
		t.Fatalf("解析后应重新编号: %+v", got)
	}
}

func TestNormalizeStageTemplates(t *testing.T) {
	gate := func(role, mode string) StageTemplate {
		return StageTemplate{Name: "阶段", Gate: "G9", ReviewerRole: role, Mode: mode}
	}
	ok := func(in []StageTemplate) []StageTemplate {
		t.Helper()
		out, err := normalizeStageTemplates(in)
		if err != nil {
			t.Fatalf("应通过校验,得到错误: %v", err)
		}
		return out
	}
	bad := func(name string, in []StageTemplate, substr string) {
		t.Helper()
		_, err := normalizeStageTemplates(in)
		if err == nil || !strings.Contains(err.Error(), substr) {
			t.Errorf("%s: 期望报错含 %q,得到 %v", name, substr, err)
		}
	}
	bad("空模板", nil, "1–")
	bad("关卡没有评审人", []StageTemplate{gate("", ModeAll)}, "评审人")
	bad("评审人不是 CTO / 经办", []StageTemplate{gate(RolePM, ModeAll)}, "评审人")
	bad("关卡没有表决方式", []StageTemplate{gate(RoleCTO, "")}, "表决方式")
	bad("表决方式不合法", []StageTemplate{gate(RoleCTO, "vote")}, "表决方式")
	bad("阶段没有名称", []StageTemplate{{Key: "a"}}, "缺少名称")
	bad("阶段标识不合法", []StageTemplate{{Key: "Has Space", Name: "x"}}, "阶段标识")
	bad("阶段标识重复", []StageTemplate{{Key: "a", Name: "x"}, {Key: "a", Name: "y"}}, "重复")
	bad("必交付物太多", []StageTemplate{{Name: "x", Required: make([]string, maxTemplateEntries+1)}}, "最多")

	out := ok([]StageTemplate{
		{Name: "  分析  ", Gate: "", ReviewerRole: RoleCTO, Mode: ModeAny, // 没有关卡时评审规则被清掉
			Required: []string{" 报告 ", "", "报告"}, Tasks: []string{"报告", "走查"}},
		{Name: "设计", Gate: " G2 ", ReviewerRole: RoleHandler, Mode: ModeAll},
		{Name: "推广", Gate: "G3", ReviewerRole: RoleCTO, Mode: ModeAny},
	})
	if len(out) != 3 {
		t.Fatalf("应有 3 个阶段,得到 %d", len(out))
	}
	for i, x := range out {
		if x.Seq != i+1 {
			t.Fatalf("阶段应连续编号: %+v", out)
		}
	}
	if out[0].Name != "分析" || out[0].ReviewerRole != "" || out[0].Mode != "" {
		t.Fatalf("无关卡阶段的规则应被清掉: %+v", out[0])
	}
	// 去空白、去重;与必交付物重名的任务只留必交付物
	if strings.Join(out[0].Required, ",") != "报告" || strings.Join(out[0].Tasks, ",") != "走查" {
		t.Fatalf("必交付物 / 默认任务未规整: %+v", out[0])
	}
	if out[1].Gate != "G2" {
		t.Fatalf("关卡名应去空白: %+v", out[1])
	}
	// 缺标识时自动生成且互不重复
	if out[0].Key == "" || out[1].Key == "" || out[2].Key == "" || out[0].Key == out[1].Key || out[1].Key == out[2].Key {
		t.Fatalf("阶段标识应自动生成且唯一: %+v", out)
	}
	// 内置模板自己必须能通过校验(首次启动就是拿它写库的)
	if built, err := normalizeStageTemplates(defaultStageTemplates()); err != nil || len(built) != 7 {
		t.Fatalf("内置模板应通过校验: %v", err)
	}
}

func TestProcessSystemsAndStageNames(t *testing.T) {
	p := &Process{Steps: []Step{
		online("a", "提交", " OA ", nil),
		offline("b", "线下"),
		{ID: "c", Name: "会签", Mode: "online", Countersign: true, Parties: []Party{
			party("财务部", sub("复核", "online", "财务共享", nil), sub("", "online", "不该出现", nil)),
			party("法务部", sub("面签", "offline", "也不该出现", nil)),
		}},
		online("a2", "归档", "OA", nil),
	}}
	if got := strings.Join(processSystems(p), "|"); got != "OA|财务共享" {
		t.Fatalf("线上系统涉及度取数不符: %q", got)
	}
	if got := strings.Join(processSystems(&Process{}), "|"); got != "" {
		t.Fatalf("没有步骤时不应有系统: %q", got)
	}
	if got := stageNameIn(defaultStageTemplates(), 2); got != "需求确认" {
		t.Fatalf("按模板取阶段名不符: %q", got)
	}
	if got := stageNameIn(nil, 2); got != "未知阶段" {
		t.Fatalf("越界阶段名不符: %q", got)
	}
}
