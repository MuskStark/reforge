package main

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"
)

// 自动诊断:三类节点的口径。与 ComputeMetrics、流程图虚线保持同一口径——
// 诊断用的流程同时过一遍指标计算,核对两类数字对得上。

// mstep 线上主步骤(可指定是否支持移动端)
func mstep(id, name, sys string, mobile bool, interop *bool) Step {
	return Step{ID: id, Name: name, Mode: "online", Online: onInfo(sys, mobile, interop)}
}

// sstep 线上会签子步骤
func sstep(id, name, sys string, mobile bool, interop *bool) SubStep {
	return SubStep{ID: id, Name: name, Mode: "online", Online: onInfo(sys, mobile, interop)}
}

// 按规则拼出期望的节点标识:带 ID 的 = 前缀 + ID 长度 + 冒号 + ID;按位置的 = 前缀 + # + 序号
func mkey(id string) string { return "m:" + strconv.Itoa(len(id)) + ":" + id }
func mpos(n int) string     { return "m:#" + strconv.Itoa(n) }
func ckey(step int, id string) string {
	return "c:" + strconv.Itoa(step) + ":" + strconv.Itoa(len(id)) + ":" + id
}
func cpos(step, n int) string { return "c:" + strconv.Itoa(step) + ":#" + strconv.Itoa(n) }

func refKeys(d Diagnosis, line string) []string {
	out := []string{}
	for _, n := range d.refs(line) {
		out = append(out, n.Key+"|"+n.Name)
	}
	return out
}

func wantStrings(t *testing.T, got, want []string, what string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %v want %v", what, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s[%d]: got %q want %q", what, i, got[i], want[i])
		}
	}
}

func TestDiagnose_CountersignFlow(t *testing.T) {
	steps := e2eFlow()
	d := Diagnose(steps)
	m := ComputeMetrics(steps)

	if d.Steps != m.Steps || d.OnlineSteps != m.OnlineSteps {
		t.Fatalf("步骤口径应与指标一致: diagnosis steps=%d online=%d, metrics steps=%d online=%d", d.Steps, d.OnlineSteps, m.Steps, m.OnlineSteps)
	}
	wantStrings(t, refKeys(d, LineOffline), []string{mkey("s4") + "|纸质归档"}, "线下节点")
	// 归档:上一步是会签,各方交接出来的系统(财务共享平台、合同系统)都与 OA 不同,且标注了不互通
	wantStrings(t, refKeys(d, LineInterop), []string{mkey("s3") + "|归档"}, "系统不互通")
	if d.Interop[0].From != "财务共享平台、合同系统" || d.Interop[0].System != "OA" || d.Interop[0].Step != 3 {
		t.Fatalf("不互通节点应带上一衔接处的系统与序号: %+v", d.Interop[0])
	}
	wantStrings(t, refKeys(d, LineMobile), []string{ckey(2, "p2a") + "|合同会签"}, "无法移动端")
	if d.Mobile[0].Path != "法务部" || d.Mobile[0].System != "合同系统" || d.Mobile[0].Step != 2 {
		t.Fatalf("会签子步骤应带会签方、系统与主步骤序号: %+v", d.Mobile[0])
	}
	// 三类节点数都能由既有指标解释:线下节点 = 线下步骤;无法移动端 = 线上步骤 - 支持移动端的步骤;
	// 不互通节点是一种断点,不多于断点数
	if d.count(LineOffline) != m.OfflineSteps || d.count(LineMobile) != m.OnlineSteps-m.MobileSteps || d.count(LineInterop) > m.Breakpoints {
		t.Fatalf("诊断与指标对不上: diagnosis=%d/%d/%d metrics offline=%d mobile=%d/%d breakpoints=%d",
			d.count(LineOffline), d.count(LineInterop), d.count(LineMobile), m.OfflineSteps, m.MobileSteps, m.OnlineSteps, m.Breakpoints)
	}
	if !d.hasAny() {
		t.Fatalf("这条流程有待改造节点")
	}
}

func TestDiagnose_MainToMainAndLane(t *testing.T) {
	yes, no := boolp(true), boolp(false)
	steps := []Step{
		mstep("a", "提交", "OA", true, nil),
		mstep("b", "审批", "商旅平台", false, no), // 与 OA 不互通,且不支持移动端
		mstep("c", "支付", "商旅平台", true, yes),
		offline("d", "纸质签字"),
		mstep("e", "复核", "财务系统", true, nil), // 上一步是线下,不涉及系统互通
		{ID: "cs", Name: "会签", Mode: "online", Countersign: true, Parties: []Party{
			party("财务部", sstep("f1", "复核", "财务系统", true, nil), sstep("f2", "盖章", "电子签章", false, no)),
			party("", SubStep{ID: "g1", Name: "归档", Mode: "offline"}),
		}},
		mstep("f", "通知", "OA", false, no), // 与会签交接出来的系统(电子签章)不互通
	}
	d := Diagnose(steps)
	wantStrings(t, refKeys(d, LineOffline), []string{mkey("d") + "|纸质签字", ckey(6, "g1") + "|归档"}, "线下节点")
	wantStrings(t, refKeys(d, LineInterop), []string{mkey("b") + "|审批", ckey(6, "f2") + "|盖章", mkey("f") + "|通知"}, "系统不互通")
	wantStrings(t, refKeys(d, LineMobile), []string{mkey("b") + "|审批", ckey(6, "f2") + "|盖章", mkey("f") + "|通知"}, "无法移动端")

	// 同一节点同时计入两类:审批、盖章、通知既不互通也不支持移动端,且两类里的标识相同
	if d.Interop[0].From != "OA" {
		t.Fatalf("主步骤间的不互通应带上一步的系统: %q", d.Interop[0].From)
	}
	if d.Interop[1].From != "财务系统" || d.Interop[1].Path != "财务部" || d.Interop[1].Step != 6 {
		t.Fatalf("会签方内部的不互通记在后一个子步骤上: %+v", d.Interop[1])
	}
	if d.Interop[2].From != "电子签章" {
		t.Fatalf("会签之后的节点,互通对象是各方末位子步骤的系统: %q", d.Interop[2].From)
	}
	if d.Offline[1].Path != "会签方" {
		t.Fatalf("没填部门的会签方应有归属: %q", d.Offline[1].Path)
	}
	for i := range d.Interop {
		if d.Interop[i].Key != d.Mobile[i].Key {
			t.Fatalf("同一节点在两类里的标识应相同: %q vs %q", d.Interop[i].Key, d.Mobile[i].Key)
		}
	}
	// 6 个主步骤 + 会签主步骤本身 + 3 个子步骤 = 10;线下的纸质签字与归档不计入线上
	if d.Steps != 10 || d.OnlineSteps != 7 {
		t.Fatalf("步骤计数: steps=%d online=%d", d.Steps, d.OnlineSteps)
	}
}

func TestDiagnose_IgnoresStaleAndUnnamed(t *testing.T) {
	yes := boolp(true)
	steps := []Step{
		mstep("a", "提交", "OA", true, nil),
		{ID: "cs", Name: "会签", Mode: "online", Countersign: true, Parties: []Party{
			// 空名子步骤即使选了「不支持移动端」也不算
			party("财务部", SubStep{Name: "", Mode: "online", Online: onInfo("", false, nil)}, SubStep{ID: "k", Name: "复核", Mode: "offline"}),
		}},
		// 标了「不互通」,但会签交接出来的系统里没有与它不同的:问题不成立,不算
		mstep("b", "归档", "OA", true, yes),
	}
	d := Diagnose(steps)
	wantStrings(t, refKeys(d, LineOffline), []string{ckey(2, "k") + "|复核"}, "线下节点")
	for _, line := range []string{LineInterop, LineMobile} {
		if n := d.count(line); n != 0 {
			t.Fatalf("%s 应为 0,得到 %d: %+v", line, n, d.refs(line))
		}
	}
	// 两个主步骤 + 会签主步骤本身 + 一个已命名子步骤;空名子步骤不占步骤数
	if d.Steps != 4 || d.OnlineSteps != 2 {
		t.Fatalf("步骤计数: steps=%d online=%d", d.Steps, d.OnlineSteps)
	}
}

func TestDiagnose_LegacyDataAndUnstableKeys(t *testing.T) {
	no := boolp(false)
	steps := []Step{
		// 旧数据:移动端一栏没选过,不算「无法实现移动端」
		{ID: "x", Name: "提交", Mode: "online", Online: OnlineInfo{SystemName: "OA"}},
		{ID: "", Name: "审批", Mode: "online", Online: onInfo("OA", false, nil)},
		{ID: "x", Name: "复核", Mode: "online", Online: onInfo("财务系统", true, no)},
		{ID: "x", Name: "归档", Mode: "offline"},
		{ID: "x", Name: "会签", Mode: "online", Countersign: true, Parties: []Party{party("财务部",
			sstep("s", "一", "财务系统", true, nil),
			sstep("s", "二", "OA", false, no),
		)}},
	}
	d := Diagnose(steps)
	wantStrings(t, refKeys(d, LineMobile), []string{mpos(2) + "|审批", cpos(5, 2) + "|二"}, "无法移动端")
	wantStrings(t, refKeys(d, LineOffline), []string{mpos(4) + "|归档"}, "线下节点")
	wantStrings(t, refKeys(d, LineInterop), []string{mpos(3) + "|复核", cpos(5, 2) + "|二"}, "系统不互通")

	// ID 为空或重复时标识退回按位置;同一流程里被诊断到的节点标识各不相同
	seen := map[string]bool{}
	for _, line := range intakeLineKeys {
		for _, n := range d.refs(line) {
			seen[n.Key] = true
		}
	}
	if len(seen) != 4 {
		t.Fatalf("去重后的节点标识应有 4 个: %v", seen)
	}
	// 同名 ID 出现在不同主步骤的会签里,不会互相撞键
	if ckey(5, "s") == ckey(6, "s") {
		t.Fatalf("不同主步骤下的子步骤标识应不同")
	}
	if d.count("unknown") != 0 || d.refs("unknown") != nil || (Diagnosis{}).hasAny() {
		t.Fatalf("未知推进线与空诊断的边界")
	}
}

func TestNodeKeysCannotCollide(t *testing.T) {
	// 客户端如果把步骤 ID 起成「#2」这种样子,也不该和按位置生成的标识相同
	steps := []Step{offline("#2", "甲"), offline("", "乙"), offline("2:x", "丙"), offline("x", "丁")}
	keys := map[string]bool{}
	for _, n := range Diagnose(steps).Offline {
		if keys[n.Key] {
			t.Fatalf("标识重复: %s", n.Key)
		}
		keys[n.Key] = true
	}
	if keys[mpos(2)] && len(keys) != 4 {
		t.Fatalf("四个节点的标识应各不相同: %v", keys)
	}
	// 同一条流程重复诊断结果稳定(标识要能跨请求关联逐节点的处理状态)
	again := Diagnose(steps)
	for i := range again.Offline {
		if again.Offline[i].Key != Diagnose(steps).Offline[i].Key {
			t.Fatalf("标识不稳定")
		}
	}
}

func TestDiagnose_SerializesArrays(t *testing.T) {
	raw, err := json.Marshal(Diagnose(nil))
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]json.RawMessage
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"offline", "interop", "mobile"} {
		if string(back[k]) != "[]" {
			t.Fatalf("%s 空诊断应序列化为 [],得到 %s", k, back[k])
		}
	}
}

func TestIntakePhase(t *testing.T) {
	pr := &Project{Status: ProjActive, CurrentStage: 1}
	at := time.Now()
	if got := intakePhase(pr, ProjectStage{Status: StagePending}, false); got != PhaseTriage {
		t.Fatalf("未初析未指派: got %s", got)
	}
	pr.TriageDoneAt = &at
	if got := intakePhase(pr, ProjectStage{Status: StagePending}, false); got != PhaseAssign {
		t.Fatalf("已初析未指派: got %s", got)
	}
	// 管理员没走初析、直接指派了 PM:直接进入推进
	pr.TriageDoneAt = nil
	if got := intakePhase(pr, ProjectStage{Status: StageInProgress}, true); got != PhaseAdvance {
		t.Fatalf("PM 推进: got %s", got)
	}
	pr.TriageDoneAt = &at
	if got := intakePhase(pr, ProjectStage{Status: StageInProgress}, true); got != PhaseAdvance {
		t.Fatalf("PM 推进: got %s", got)
	}
	if got := intakePhase(pr, ProjectStage{Status: StageInReview}, true); got != PhaseAssess {
		t.Fatalf("CTO 评估: got %s", got)
	}
	pr.FinalStatus = FinalPending
	if got := intakePhase(pr, ProjectStage{Status: StageInReview}, true); got != PhaseFinal {
		t.Fatalf("PMO 终审: got %s", got)
	}
	pr.FinalStatus, pr.CurrentStage = "", 2
	if got := intakePhase(pr, ProjectStage{Status: StageApproved}, true); got != PhaseDone {
		t.Fatalf("已通过: got %s", got)
	}
	pr.CurrentStage = 1
	if got := intakePhase(pr, ProjectStage{Status: StageSkipped}, true); got != PhaseDone {
		t.Fatalf("已跳过: got %s", got)
	}
}

func TestIntakeStage(t *testing.T) {
	// 内置模板的第一阶段就是承接阶段;没有快照的旧项目按内置模板处理
	for _, pr := range []*Project{{tpl: defaultStageTemplates()}, {}} {
		st, ok := pr.intakeStage()
		if !ok || st.Key != keyIntake || st.Seq != 1 {
			t.Fatalf("应识别出承接阶段: %+v %v", st, ok)
		}
	}
	// 承接阶段不在第一位时不生效:初析与指派必须发生在阶段启动之前
	tpl := defaultStageTemplates()
	if _, ok := (&Project{tpl: []StageTemplate{tpl[1], tpl[0]}}).intakeStage(); ok {
		t.Fatalf("承接阶段排在第二位时不应生效")
	}
	if _, ok := (&Project{tpl: tpl[1:]}).intakeStage(); ok {
		t.Fatalf("模板里没有承接阶段")
	}
}

func TestIntakeLegacy(t *testing.T) {
	at := time.Now()
	// 升级前立项、已通过第一阶段:没有终审通过的标记
	if !intakeLegacy(&Project{Status: ProjActive, CurrentStage: 2}, PhaseDone) {
		t.Fatalf("没走完过承接的项目应判为无承接记录")
	}
	// 走完承接(哪怕没做过初级分析——管理员直接指派;PM 也不是在承接里到岗的)
	if intakeLegacy(&Project{Status: ProjDone, TriageDoneAt: nil, IntakePassedAt: &at}, PhaseDone) {
		t.Fatalf("终审通过过的项目不应判为无承接记录")
	}
	// 还在承接阶段里的项目,无论有没有标记都不算
	for _, pr := range []*Project{{}, {IntakePassedAt: &at}} {
		if intakeLegacy(pr, PhaseAdvance) || intakeLegacy(pr, PhaseTriage) {
			t.Fatalf("还在承接阶段里的项目不应判为无承接记录")
		}
	}
}

func TestIntakePoolSum(t *testing.T) {
	no := boolp(false)
	mixed := []Step{mstep("a", "提交", "OA", true, nil), mstep("b", "审批", "商旅平台", false, no), offline("c", "纸质签字")}
	at := time.Now()
	tpl := defaultStageTemplates()
	got := intakePoolSum([]intakePoolItem{
		// 在途、等初析:线下 1、不互通 1、无法移动端 1
		{Pr: &Project{Status: ProjActive, CurrentStage: 1, tpl: tpl}, Stage: ProjectStage{Status: StagePending}, Steps: mixed},
		// 在途、等终审:只有线下节点
		{Pr: &Project{Status: ProjActive, CurrentStage: 1, tpl: tpl, TriageDoneAt: &at, FinalStatus: FinalPending}, Stage: ProjectStage{Status: StageInReview}, HasPM: true, Steps: []Step{offline("x", "归档")}},
		// 已完成:计入全池诊断,不计入积压
		{Pr: &Project{Status: ProjDone, CurrentStage: 1, tpl: tpl, TriageDoneAt: &at}, Stage: ProjectStage{Status: StageApproved}, HasPM: true, Steps: []Step{offline("y", "归档")}},
		// 没有承接阶段的项目不参与;已经离开承接阶段的在途项目仍计入全池诊断,但不算积压
		{Pr: &Project{Status: ProjActive, CurrentStage: 1, tpl: tpl[1:]}, Steps: mixed},
		{Pr: &Project{Status: ProjActive, CurrentStage: 2, tpl: tpl, TriageDoneAt: &at}, Stage: ProjectStage{Status: StageApproved}, HasPM: true, Steps: mixed},
	})
	want := IntakeOverview{Projects: 4, Offline: 4, OfflineAffected: 4, Interop: 2, InteropAffected: 2, Mobile: 2, MobileAffected: 2, Triage: 1, Final: 1}
	if *got != want {
		t.Fatalf("全池诊断: got %+v want %+v", *got, want)
	}
}

func TestIntakeRules(t *testing.T) {
	// 评估结论:全部可行 = 通过;有附条件或不可行(已给替代方案)= 有条件通过
	for _, tc := range []struct {
		verdicts []string
		want     string
	}{
		{[]string{VerdictFeasible, VerdictFeasible}, "pass"},
		{[]string{VerdictFeasible, VerdictInfeasible}, "conditional"},
		{[]string{VerdictConditional}, "conditional"},
		{[]string{}, "pass"},
	} {
		if got := assessmentConclusion(tc.verdicts); got != tc.want {
			t.Fatalf("%v: got %s want %s", tc.verdicts, got, tc.want)
		}
	}
	// 附条件要写明条件;不可行必须给出替代方案;可行不要求说明
	if verdictProblem(VerdictFeasible, "") != "" || verdictProblem(VerdictConditional, " ") == "" || verdictProblem(VerdictInfeasible, "") == "" {
		t.Fatalf("结论的说明要求不符")
	}
	if intakeLineTitle(LineOffline) != "线下节点转线上" || len(intakeLineKeys) != 3 || intakeLineKeys[1] != LineInterop {
		t.Fatalf("推进线的名称与顺序: %v", intakeLineKeys)
	}

	// 提交评估前的完整性:流程完整性要有结论;有节点的推进线要写原因与方案;
	// 有待改造节点时要写总述、并且至少有一个技术点;改造价值与复杂度要已评估
	yes := boolp(true)
	d := Diagnose([]Step{offline("a", "纸质"), mstep("b", "审批", "OA", true, yes)})
	complete := intakeRow{Completeness: Complete}
	lines := map[string]lineRow{LineOffline: {Reason: "要原件", Solution: "影像化"}}
	wantStrings(t, intakeMissing(d, complete, lines, nil, true, true), []string{"还没写综合方案总述", "还没有供 CTO 评估的技术点"}, "缺总述与技术点")

	lines[LineOffline] = lineRow{Reason: "要原件"}
	wantStrings(t, intakeMissing(d, complete, lines, nil, true, true),
		[]string{"「线下节点转线上」还没写解决方案", "还没写综合方案总述", "还没有供 CTO 评估的技术点"}, "缺方案")

	// 流程完整性没结论、原因方案总述技术点都没写:共 5 项
	wantStrings(t, intakeMissing(d, intakeRow{}, map[string]lineRow{}, nil, true, true), []string{
		"还没确认流程是否完整", "「线下节点转线上」还没写原因", "「线下节点转线上」还没写解决方案", "还没写综合方案总述", "还没有供 CTO 评估的技术点",
	}, "全缺")

	// 齐备。没有节点的推进线(系统不互通、移动化)不要求原因与方案
	full := intakeRow{Completeness: Complete, Summary: "总述"}
	lines = map[string]lineRow{LineOffline: {Reason: "r", Solution: "s"}}
	if got := intakeMissing(d, full, lines, []*IntakePoint{{}}, true, true); len(got) != 0 {
		t.Fatalf("齐备时不应再有缺项: %v", got)
	}

	// 三类都没有待改造节点:不要求总述与技术点,流程完整性仍要有结论
	empty := Diagnose([]Step{mstep("a", "提交", "OA", true, yes)})
	if empty.hasAny() || len(intakeMissing(empty, complete, nil, nil, true, true)) != 0 {
		t.Fatalf("无待改造节点、流程完整性有结论时应齐备")
	}
	if got := intakeMissing(empty, intakeRow{}, nil, nil, true, true); len(got) != 1 {
		t.Fatalf("流程完整性未确认应计入: %v", got)
	}
	// 改造价值、复杂度各自提示
	wantStrings(t, intakeMissing(empty, complete, nil, nil, false, true), []string{"还没评估改造价值"}, "缺改造价值")
	wantStrings(t, intakeMissing(empty, complete, nil, nil, true, false), []string{"还没评估复杂度"}, "缺复杂度")
}

func TestParseSupport(t *testing.T) {
	for _, raw := range []string{`{}`, ``, `null`, `{"status":"weird"}`, `not json`} {
		if s := parseSupport([]byte(raw)); s.Status != SupportNone {
			t.Fatalf("%q 应回落为未申请: %+v", raw, s)
		}
	}
	s := parseSupport([]byte(`{"status":"requested","reason":"接口能力需要预判"}`))
	if s.Status != SupportRequested || s.Reason != "接口能力需要预判" {
		t.Fatalf("解析申请协助现状: %+v", s)
	}
}
