package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// StageTemplate 阶段模板:一个阶段的出口关卡、评审规则、必交付物与默认任务。
// 模板存于 stage_templates 表,可在后台修改;项目立项时把当时的模板快照进 projects.template,
// 此后引擎只认项目自己的快照——所以模板改动只影响新建项目。
type StageTemplate struct {
	Seq          int      `json:"seq"`
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Gate         string   `json:"gate"`         // 出口关卡名;空 = 无门禁
	ReviewerRole string   `json:"reviewerRole"` // 评审角色(cto | handler)
	Mode         string   `json:"mode"`         // all = 会签;any = 或签
	Required     []string `json:"required"`     // 必交付物:未完成不能提交评审
	Tasks        []string `json:"tasks"`        // 默认任务
}

// 两个带语义的阶段标识(标识不可改,名称与规则都可以改)
const (
	keyDesign = "design" // 该阶段通过时留存 To-Be 基线
	keyAccept = "accept" // 该阶段通过时留存已发布版本;通过后才可申请/标记项目完成(完成需 PMO 核准)
)

// builtinTemplates 内置的七阶段模板:首次启动写入 stage_templates 表作为初始配置,表为空时也以它兜底
var builtinTemplates = []StageTemplate{
	{1, "intake", "分析立项", "G1 立项评审", RoleCTO, ModeAny,
		[]string{"分析报告"},
		[]string{"现状分析", "价值 / 复杂度 / 优先级评估", "初步方案与收益"}},
	{2, "require", "需求确认", "G2 需求基线", RoleHandler, ModeAll,
		[]string{"现状核对记录", "需求清单", "KPI 基线"},
		[]string{"现状走查", "痛点与需求梳理"}},
	{3, keyDesign, "方案设计", "G3 方案评审", RoleCTO, ModeAll,
		[]string{"To-Be 流程", "系统改造方案", "实施计划"},
		[]string{"接口 / 数据互通方案", "移动端方案", "计划与资源"}},
	{4, "build", "系统改造", "G4 上线准备", RoleCTO, ModeAny,
		[]string{"测试报告", "上线与回滚方案", "培训材料"},
		[]string{"开发 / 配置", "联调", "测试", "培训"}},
	{5, "trial", "试运行", "G5 试运行结论", RoleHandler, ModeAll,
		[]string{"UAT 结果", "问题清单（闭环）"},
		[]string{"UAT 执行", "问题跟踪"}},
	{6, keyAccept, "验收上线", "G6 验收", RoleCTO, ModeAll,
		[]string{"验收报告"},
		[]string{"发布流程", "复盘"}},
	{7, "operate", "运营优化", "", "", "",
		nil,
		[]string{"运营指标记录", "指标跟踪", "优化项（可再次立项）"}},
}

// defaultStageTemplates 内置模板的副本(切片是独立拷贝,调用方可以放心修改)
func defaultStageTemplates() []StageTemplate {
	out := make([]StageTemplate, len(builtinTemplates))
	for i, t := range builtinTemplates {
		t.Required = append([]string{}, t.Required...)
		t.Tasks = append([]string{}, t.Tasks...)
		out[i] = t
	}
	return out
}

// templateAt 模板里第 seq 个阶段
func templateAt(tpl []StageTemplate, seq int) (StageTemplate, bool) {
	if seq < 1 || seq > len(tpl) {
		return StageTemplate{}, false
	}
	return tpl[seq-1], true
}

func stageNameIn(tpl []StageTemplate, seq int) string {
	if t, ok := templateAt(tpl, seq); ok {
		return t.Name
	}
	return "未知阶段"
}

// parseTemplate 把模板快照 / 表里的 JSON 解析成模板;内容不可用时退回内置模板。
// 旧项目没有快照(列为 []),它们本来就是按内置模板建立的。
func parseTemplate(raw []byte) []StageTemplate {
	var tpl []StageTemplate
	if len(raw) == 0 || json.Unmarshal(raw, &tpl) != nil || len(tpl) == 0 {
		return defaultStageTemplates()
	}
	for i := range tpl {
		tpl[i].Seq = i + 1
	}
	return tpl
}

// templateJSON 模板的 JSON 存储形式(恒为数组)
func templateJSON(tpl []StageTemplate) string {
	b, err := json.Marshal(tpl)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// ---- 项目侧:引擎只认项目立项时的模板快照 ----

// template 项目立项时的阶段模板;没有快照的旧项目按内置模板
func (pr *Project) template() []StageTemplate {
	if len(pr.tpl) > 0 {
		return pr.tpl
	}
	return defaultStageTemplates()
}

func (pr *Project) stageCount() int { return len(pr.template()) }

func (pr *Project) stageAt(seq int) (StageTemplate, bool) { return templateAt(pr.template(), seq) }

func (pr *Project) stageName(seq int) string { return stageNameIn(pr.template(), seq) }

// nextStageName 关卡通过后进入的阶段名;已是最后阶段时为空
func (pr *Project) nextStageName(seq int) string {
	if t, ok := pr.stageAt(seq + 1); ok {
		return t.Name
	}
	return ""
}

// snapshotKind 关卡通过时需要留存的流程版本快照:方案设计 → To-Be 基线;验收上线 → 已发布
func (pr *Project) snapshotKind(seq int) string {
	t, ok := pr.stageAt(seq)
	if !ok || t.Gate == "" {
		return ""
	}
	switch t.Key {
	case keyDesign:
		return "to_be"
	case keyAccept:
		return "published"
	}
	return ""
}

// acceptStage 验收阶段:带 accept 标识的阶段;没有则取最后一个带关卡的阶段;都没有则没有完成前置条件
func (pr *Project) acceptStage() (StageTemplate, bool) {
	tpl := pr.template()
	last := -1
	for i, t := range tpl {
		if t.Key == keyAccept {
			return t, true
		}
		if t.Gate != "" {
			last = i
		}
	}
	if last >= 0 {
		return tpl[last], true
	}
	return StageTemplate{}, false
}

// ---- 后台配置:校验与规整 ----

const (
	maxStages          = 16
	maxTemplateEntries = 30
)

var templateKeyRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// normalizeStageTemplates 校验并规整后台提交的模板,返回带序号的干净列表
func normalizeStageTemplates(in []StageTemplate) ([]StageTemplate, error) {
	if len(in) == 0 || len(in) > maxStages {
		return nil, badRequest(fmt.Sprintf("阶段数量应在 1–%d 个之间", maxStages))
	}
	out := make([]StageTemplate, 0, len(in))
	keys := map[string]bool{}
	for i, t := range in {
		t.Name = trimRunes(t.Name, 40)
		if t.Name == "" {
			return nil, badRequest(fmt.Sprintf("第 %d 个阶段缺少名称", i+1))
		}
		t.Gate = trimRunes(t.Gate, 40)
		if t.Gate != "" {
			if t.ReviewerRole != RoleCTO && t.ReviewerRole != RoleHandler {
				return nil, badRequest("「" + t.Name + "」的评审人应为 CTO 或 BH")
			}
			if t.Mode != ModeAll && t.Mode != ModeAny {
				return nil, badRequest("「" + t.Name + "」的表决方式应为会签或或签")
			}
		} else {
			t.ReviewerRole, t.Mode = "", ""
		}
		var err error
		if t.Required, err = cleanTitleList(t.Required, "「"+t.Name+"」的必交付物"); err != nil {
			return nil, err
		}
		if t.Tasks, err = cleanTitleList(t.Tasks, "「"+t.Name+"」的默认任务"); err != nil {
			return nil, err
		}
		// 同一条既是必交付物又是任务时只留必交付物
		required := map[string]bool{}
		for _, r := range t.Required {
			required[r] = true
		}
		tasks := []string{}
		for _, x := range t.Tasks {
			if !required[x] {
				tasks = append(tasks, x)
			}
		}
		t.Tasks = tasks

		t.Key = strings.TrimSpace(t.Key)
		if t.Key == "" {
			for n := i + 1; ; n++ {
				t.Key = fmt.Sprintf("stage_%d", n)
				if !keys[t.Key] {
					break
				}
			}
		} else if !templateKeyRe.MatchString(t.Key) {
			return nil, badRequest("「" + t.Name + "」的阶段标识只能用小写字母、数字和下划线")
		}
		if keys[t.Key] {
			return nil, badRequest("「" + t.Name + "」的阶段标识重复")
		}
		keys[t.Key] = true
		t.Seq = i + 1
		out = append(out, t)
	}
	return out, nil
}

// cleanTitleList 去空白、去重、丢弃空项;数量超限时报错而不是悄悄截断
func cleanTitleList(in []string, label string) ([]string, error) {
	if len(in) > maxTemplateEntries {
		return nil, badRequest(label + "最多 " + itoa(maxTemplateEntries) + " 项")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = trimRunes(s, 80)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out, nil
}

var (
	validJobRoles     = map[string]bool{RoleNone: true, RoleCTO: true, RolePM: true, RoleHandler: true, RoleDev: true, RoleViewer: true}
	validProjectRoles = map[string]bool{RolePM: true, RoleHandler: true, RoleDev: true, RoleViewer: true}
	validItemTypes    = map[string]bool{ItemTask: true, ItemDeliverable: true, ItemIssue: true, ItemRisk: true, ItemChange: true}
	validItemStatuses = map[string]bool{
		ItemTodo: true, ItemInProgress: true, ItemBlocked: true, ItemInReview: true, ItemDone: true, ItemCancelled: true,
	}
	validPriorities = map[string]bool{"high": true, "medium": true, "low": true}
	validHealths    = map[string]bool{"on_track": true, "at_risk": true, "off_track": true}
)

// validLevel 改造价值 / 复杂度取值(沿用既有中文口径)
func validLevel(s string) bool { return s == "高" || s == "中" || s == "低" }

// levelCode 中文等级 → 内部码
func levelCode(s string) string {
	switch s {
	case "高":
		return "high"
	case "低":
		return "low"
	default:
		return "medium"
	}
}

// levelLabel 内部码 → 中文等级
func levelLabel(s string) string {
	switch s {
	case "high":
		return "高"
	case "low":
		return "低"
	default:
		return "中"
	}
}

// jobRoleLabel 岗位的显示名(一律英文缩写):CTO、PM 项目经理、BH 业务经办、TH 科技经办、PMO 项目管理办公室、无岗位。
// 岗位代码沿用历史取值不改(库里已有数据),与显示名并非字面对应。
func jobRoleLabel(r string) string {
	switch r {
	case RoleCTO:
		return "CTO"
	case RolePM:
		return "PM"
	case RoleHandler:
		return "BH"
	case RoleDev:
		return "TH"
	case RoleViewer:
		return "PMO"
	case RoleNone:
		return "无岗位"
	}
	return "无岗位"
}
