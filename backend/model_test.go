package main

import (
	"strings"
	"testing"
)

// ----- 构造工具 -----

func boolp(v bool) *bool { return &v }

// online 线上主步骤
func online(id, name, sys string, interop *bool) Step {
	return Step{
		ID: id, Name: name, Mode: "online",
		Online: OnlineInfo{SystemName: sys, MobileSupported: boolp(true), DataInteroperable: interop},
	}
}

// offline 线下主步骤
func offline(id, name string) Step {
	return Step{
		ID: id, Name: name, Mode: "offline",
		Offline: OfflineInfo{Handlers: []Handler{{Department: "行政部"}}},
	}
}

// sub 会签内部子步骤(mode: online | offline)
func sub(name, mode, sys string, interop *bool) SubStep {
	s := SubStep{Name: name, Mode: mode}
	if mode == "online" {
		s.Online = OnlineInfo{SystemName: sys, MobileSupported: boolp(true), DataInteroperable: interop}
	} else {
		s.Offline = OfflineInfo{Handlers: []Handler{{Department: "财务部"}}}
	}
	return s
}

// countersign 会签步骤,parties 为会签方
func countersign(id, name string, parties ...Party) Step {
	return Step{ID: id, Name: name, Mode: "online", Countersign: true, Parties: parties}
}

func party(dept string, subs ...SubStep) Party {
	return Party{Department: dept, SubSteps: subs}
}

// validate 走与接口一致的路径:sanitize 后再 validateProcess
func validate(steps ...Step) string {
	p := &Process{Name: "测试流程", Steps: steps}
	sanitize(p)
	return validateProcess(p)
}

func wantErr(t *testing.T, got, contains string) {
	t.Helper()
	if got == "" {
		t.Fatalf("期望校验失败(含 %q),实际通过", contains)
	}
	if !strings.Contains(got, contains) {
		t.Fatalf("错误信息不含 %q:%s", contains, got)
	}
}

func wantOK(t *testing.T, got string) {
	t.Helper()
	if got != "" {
		t.Fatalf("期望校验通过,实际:%s", got)
	}
}

// ----- 主步骤 → 主步骤(既有规则不回归) -----

func TestInteropMainToMain(t *testing.T) {
	wantErr(t, validate(online("a", "申请", "OA", nil), online("b", "审批", "ERP", nil)),
		"第 2 步与上一步均为线上且系统不同（OA → ERP），请选择两系统是否数据互通")
	wantOK(t, validate(online("a", "申请", "OA", nil), online("b", "审批", "ERP", boolp(true))))
	wantOK(t, validate(online("a", "申请", "OA", nil), online("b", "审批", "ERP", boolp(false))))
	// 同系统不需要填写
	wantOK(t, validate(online("a", "申请", "OA", nil), online("b", "审批", "OA", nil)))
	// 上一步线下:不比较系统
	wantOK(t, validate(offline("a", "递交"), online("b", "审批", "ERP", nil)))
	// 首步无上一步
	wantOK(t, validate(online("a", "审批", "ERP", nil)))
}

// ----- 会签 → 主步骤:上一步为会签时同样校验数据互通 -----

func TestInteropCountersignToMain(t *testing.T) {
	cs := countersign("a", "会签", party("财务部", sub("复核", "online", "财务系统", nil)))

	// 会签交接出的系统与本步骤不同:必须填写
	wantErr(t, validate(cs, online("b", "归档", "OA", nil)),
		"第 2 步与上一步（会签）均为线上且系统不同（财务系统 → OA），请选择两系统是否数据互通")
	// 填写后通过(是/否均可)
	wantOK(t, validate(cs, online("b", "归档", "OA", boolp(true))))
	wantOK(t, validate(cs, online("b", "归档", "OA", boolp(false))))
	// 与会签系统相同:不需要填写
	wantOK(t, validate(cs, online("b", "归档", "财务系统", nil)))
	// 本步骤线下:不涉及系统互通
	wantOK(t, validate(cs, offline("b", "归档")))
}

func TestInteropCountersignMultipleParties(t *testing.T) {
	// 两方交接出的系统均不同:错误信息按会签方顺序列出
	cs := countersign("a", "会签",
		party("财务部", sub("复核", "online", "财务系统", nil)),
		party("法务部", sub("会签", "online", "合同系统", nil)),
	)
	wantErr(t, validate(cs, online("b", "归档", "OA", nil)),
		"第 2 步与上一步（会签）均为线上且系统不同（财务系统、合同系统 → OA）")

	// 仅列出与本步骤不同的系统
	wantErr(t, validate(cs, online("b", "归档", "合同系统", nil)), "（财务系统 → 合同系统）")

	// 相同系统去重
	dup := countersign("a", "会签",
		party("财务部", sub("复核", "online", "财务系统", nil)),
		party("审计部", sub("复核", "online", "财务系统", nil)),
	)
	wantErr(t, validate(dup, online("b", "归档", "OA", nil)), "（财务系统 → OA）")
}

func TestInteropCountersignUsesLastSubStep(t *testing.T) {
	// 取每一方「最后一个」子步骤的系统:中间环节的系统不参与比较
	cs := countersign("a", "会签", party("财务部",
		sub("初审", "online", "OA", nil),
		sub("复核", "online", "合同系统", boolp(true)),
	))
	wantErr(t, validate(cs, online("b", "归档", "财务系统", nil)), "（合同系统 → 财务系统）")
	wantOK(t, validate(cs, online("b", "归档", "合同系统", nil)))

	// 末位子步骤为线下:视为线下交接,不对下一步做系统比较
	csMixed := countersign("a", "会签", party("财务部",
		sub("初审", "online", "合同系统", nil),
		sub("签字", "offline", "", nil),
	))
	wantOK(t, validate(csMixed, online("b", "归档", "OA", nil)))

	// 一方线上交接、一方线下交接:只比较线上交接的那一方
	half := countersign("a", "会签",
		party("财务部", sub("复核", "online", "财务系统", nil)),
		party("法务部", sub("签字", "offline", "", nil)),
	)
	wantErr(t, validate(half, online("b", "归档", "OA", nil)), "（财务系统 → OA）")
}

func TestInteropCountersignWithoutSubSteps(t *testing.T) {
	// 单步签署(无内部子步骤):没有系统信息,不要求下一步填写互通
	cs := countersign("a", "会签", party("财务部"))
	wantOK(t, validate(cs, online("b", "归档", "OA", nil)))
}

// ----- 会签分支内部:以「上一个已命名子步骤」为基准(空行经 sanitize 清理) -----

func TestInteropSubStepsSkipBlankRows(t *testing.T) {
	// 已命名子步骤之间夹一个空名行:清理后 OA 与 ERP 相邻,须填写互通
	cs := countersign("a", "会签", party("财务部",
		sub("初审", "online", "OA", nil),
		sub("", "online", "", nil),
		sub("复核", "online", "ERP", nil),
	))
	wantErr(t, validate(cs, online("b", "归档", "OA", nil)),
		"第 1 步「财务部」的子步骤「初审 → 复核」系统不同，请选择两系统是否数据互通")
}
