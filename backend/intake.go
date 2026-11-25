package main

import (
	"encoding/json"
	"strings"
	"time"
)

// ---- 需求承接(intake):流程收集完成之后、改造实施之前的承接闭环 ----
//
//	收集完成 → PMO 初级分析 → 指派 PM(一名或多名) → PM 按优先级推进
//	          → CTO 技术可行性评估 → PMO 终审 → 进入后续阶段
//
// 三类节点由收集数据自动诊断,解决顺序固定:① 线下节点转线上 → ② 系统不互通 → ③ 线上节点移动化。
// 承接挂在模板里标识为 intake 的阶段上,且只在它是第一个阶段时生效(见 docs/process-management-architecture.md 第 21 节):
// 这一段还没有 PM,初析与指派必须发生在阶段启动之前。

const keyIntake = "intake"

// 承接所处环节
const (
	PhaseTriage  = "triage"  // 待 PMO 初级分析
	PhaseAssign  = "assign"  // 初析已完成,待指派 PM
	PhaseAdvance = "advance" // PM 按优先级推进
	PhaseAssess  = "assess"  // CTO 技术可行性评估(关卡评审中)
	PhaseFinal   = "final"   // PMO 终审
	PhaseDone    = "done"    // 承接完成
)

// 三条推进线;切片顺序即解决顺序
const (
	LineOffline = "offline"
	LineInterop = "interop"
	LineMobile  = "mobile"
)

var intakeLineKeys = []string{LineOffline, LineInterop, LineMobile}

// 节点的处理状态
const (
	PlanPending = "pending" // 待定
	PlanPlanned = "planned" // 方案已定
	PlanNa      = "na"      // 无需处理
)

// 评审人对技术点的结论
const (
	VerdictFeasible    = "feasible"
	VerdictConditional = "conditional"
	VerdictInfeasible  = "infeasible"
)

// PMO 终审结论
const (
	FinalPassed      = "passed"
	FinalPassedNotes = "passed_with_notes"
	FinalReturned    = "returned"
)

// FinalPending projects.final_status 的取值:CTO 评估已通过,正在等 PMO 终审
const FinalPending = "pending"

// PendingPMO "待谁处理"里 PMO 的代码(与岗位、成员角色的代码无关,只在 pendingOn 里出现)
const PendingPMO = "pmo"

// 申请 CTO 协助的状态
const (
	SupportNone      = "none"
	SupportRequested = "requested"
	SupportJoined    = "joined"
)

// 各类文本的长度上限(按字符计)
const (
	maxIntakeText     = 4000 // 原因、方案、总述、初析结论
	maxIntakeNote     = 2000 // 技术点说明、评估意见、终审意见
	maxIntakeNodeNote = 500
	maxIntakePoints   = 100
	maxIntakeNodes    = 500 // 单次请求最多改动的节点数
)

var (
	validIntakeLines    = map[string]bool{LineOffline: true, LineInterop: true, LineMobile: true}
	validPlanStatuses   = map[string]bool{PlanPending: true, PlanPlanned: true, PlanNa: true}
	validVerdicts       = map[string]bool{VerdictFeasible: true, VerdictConditional: true, VerdictInfeasible: true}
	validFinalDecisions = map[string]bool{FinalPassed: true, FinalPassedNotes: true, FinalReturned: true}
)

// ---- 自动诊断 ----

// NodeRef 诊断出的一个节点。Key 是稳定标识(主步骤用步骤 ID,会签子步骤用子步骤 ID;
// ID 为空或重复时退回按位置),承接方案里逐节点的处理状态按它关联。
type NodeRef struct {
	Key    string `json:"key"`
	Step   int    `json:"step"` // 主步骤序号(1 起)
	Name   string `json:"name"`
	Path   string `json:"path,omitempty"`   // 会签子步骤所在的会签方
	System string `json:"system,omitempty"` // 线上节点所在的系统
	From   string `json:"from,omitempty"`   // 系统不互通:上一步(或会签各方)的系统
}

// Diagnosis 一组步骤的三类节点诊断。三个列表都按步骤顺序排列;同一节点可能同时出现在两类里。
// 口径与收集表的必填项一一对应,流程一提交就能算,不需要人工录入。
type Diagnosis struct {
	Steps       int       `json:"steps"`
	OnlineSteps int       `json:"onlineSteps"`
	Offline     []NodeRef `json:"offline"` // 办理方式为「线下办理」的节点
	Interop     []NodeRef `json:"interop"` // 与上一步系统不同、且标注了「数据不互通」的节点
	Mobile      []NodeRef `json:"mobile"`  // 线上办理、但不支持移动端的节点
}

func (d *Diagnosis) count(line string) int {
	switch line {
	case LineOffline:
		return len(d.Offline)
	case LineInterop:
		return len(d.Interop)
	case LineMobile:
		return len(d.Mobile)
	}
	return 0
}

func (d *Diagnosis) refs(line string) []NodeRef {
	switch line {
	case LineOffline:
		return d.Offline
	case LineInterop:
		return d.Interop
	case LineMobile:
		return d.Mobile
	}
	return nil
}

// hasAny 是否三类里有一类非空
func (d Diagnosis) hasAny() bool { return len(d.Offline)+len(d.Interop)+len(d.Mobile) > 0 }

// stepKey 主步骤的稳定标识:优先用步骤 ID;ID 为空或与前面某一步重复时退回按位置。
// 带 ID 的标识写成「前缀 + ID 长度 + 冒号 + ID」,按位置的写成「前缀 + # + 序号」——
// 井号不是数字,两者不可能相同,客户端随便填什么 ID 都不会撞键。
func stepKey(steps []Step, i int) string {
	id := strings.TrimSpace(steps[i].ID)
	if id == "" {
		return "m:#" + itoa(i+1)
	}
	for j := 0; j < i; j++ {
		if strings.TrimSpace(steps[j].ID) == id {
			return "m:#" + itoa(i+1)
		}
	}
	return "m:" + itoa(len(id)) + ":" + id
}

// subKey 会签子步骤的稳定标识,规则同 stepKey(在同一主步骤内查重);带上主步骤序号,免得跨步骤撞键
func subKey(step int, subs []SubStep, k int) string {
	id := strings.TrimSpace(subs[k].ID)
	if id == "" {
		return "c:" + itoa(step) + ":#" + itoa(k+1)
	}
	for j := 0; j < k; j++ {
		if strings.TrimSpace(subs[j].ID) == id {
			return "c:" + itoa(step) + ":#" + itoa(k+1)
		}
	}
	return "c:" + itoa(step) + ":" + itoa(len(id)) + ":" + id
}

// Diagnose 按收集数据诊断三类节点。与 ComputeMetrics / 流程图虚线同一口径:
//   - 线下节点:主步骤或已命名的会签子步骤,办理方式为线下
//   - 无法实现移动端:线上节点里「不支持移动端」的(旧数据没选的不计)
//   - 系统不互通:主步骤对上一步(普通步骤或会签)的系统、会签方内部相邻两个子步骤之间,
//     系统不同且标注了「数据不互通」——结论记在后一个节点上,所以按节点而不是按衔接计数
func Diagnose(steps []Step) Diagnosis {
	d := Diagnosis{Offline: []NodeRef{}, Interop: []NodeRef{}, Mobile: []NodeRef{}}
	for i, s := range steps {
		d.Steps++
		if s.Countersign {
			for _, pt := range s.Parties {
				// 只看已命名的子步骤(空行在保存时已被清理,这里再防一次旧数据)
				named := make([]SubStep, 0, len(pt.SubSteps))
				for _, sub := range pt.SubSteps {
					if strings.TrimSpace(sub.Name) != "" {
						named = append(named, sub)
					}
				}
				party := strings.TrimSpace(pt.Department)
				if party == "" {
					party = "会签方"
				}
				for k, sub := range named {
					d.Steps++
					ref := NodeRef{Key: subKey(i+1, named, k), Step: i + 1, Name: sub.Name, Path: party, System: strings.TrimSpace(sub.Online.SystemName)}
					if !subOnline(sub) {
						ref.System = ""
						d.Offline = append(d.Offline, ref)
						continue
					}
					d.OnlineSteps++
					if sub.Online.MobileSupported != nil && !*sub.Online.MobileSupported {
						d.Mobile = append(d.Mobile, ref)
					}
					if k > 0 && laneNotInterop(named[k-1], sub) {
						ref.From = strings.TrimSpace(named[k-1].Online.SystemName)
						d.Interop = append(d.Interop, ref)
					}
				}
			}
			continue
		}
		ref := NodeRef{Key: stepKey(steps, i), Step: i + 1, Name: s.Name}
		if stepMode(s) == "offline" {
			d.Offline = append(d.Offline, ref)
			continue
		}
		d.OnlineSteps++
		ref.System = strings.TrimSpace(s.Online.SystemName)
		if s.Online.MobileSupported != nil && !*s.Online.MobileSupported {
			d.Mobile = append(d.Mobile, ref)
		}
		if stepNotInterop(steps, i) {
			ref.From = prevSystemLabel(steps, i)
			d.Interop = append(d.Interop, ref)
		}
	}
	return d
}

// prevSystemLabel 主步骤 i 的上一步交接到这里的系统:上一步是会签时是各方末位子步骤的系统
func prevSystemLabel(steps []Step, i int) string {
	prev := steps[i-1]
	if prev.Countersign {
		return strings.Join(countersignExitSystems(prev.Parties, strings.TrimSpace(steps[i].Online.SystemName)), "、")
	}
	return strings.TrimSpace(prev.Online.SystemName)
}

// ---- 承接方案的数据形状 ----

// completeness 流程完整性的结论
const (
	Complete = "complete" // 结构完整
	HasGaps  = "gaps"     // 有缺口,待补全
)

var validCompleteness = map[string]bool{Complete: true, HasGaps: true}

// CtoSupport 申请 CTO 协助的现状(存在 projects.cto_support)
type CtoSupport struct {
	Status          string     `json:"status"`
	Reason          string     `json:"reason"`
	RequestedByID   string     `json:"requestedById"`
	RequestedByName string     `json:"requestedByName"`
	RequestedAt     *time.Time `json:"requestedAt"`
	JoinedByID      string     `json:"joinedById"`
	JoinedByName    string     `json:"joinedByName"`
	JoinedAt        *time.Time `json:"joinedAt"`
}

// parseSupport 解析申请 CTO 协助的现状;没有记录或状态不认识时按「未申请」处理
func parseSupport(raw []byte) CtoSupport {
	var s CtoSupport
	if json.Unmarshal(raw, &s) == nil && (s.Status == SupportRequested || s.Status == SupportJoined) {
		return s
	}
	return CtoSupport{Status: SupportNone}
}

// NodeView 诊断出的节点 + 承接方案里对它的处理状态
type NodeView struct {
	NodeRef
	Status        string     `json:"status"`
	Note          string     `json:"note"`
	UpdatedByName string     `json:"updatedByName"`
	UpdatedAt     *time.Time `json:"updatedAt"`
}

// LineView 一条推进线:自动诊断出的节点、原因、解决方案与负责人
type LineView struct {
	Key           string     `json:"key"`
	Reason        string     `json:"reason"`
	Solution      string     `json:"solution"`
	OwnerID       string     `json:"ownerId"`
	OwnerName     string     `json:"ownerName"`
	UpdatedByName string     `json:"updatedByName"`
	UpdatedAt     *time.Time `json:"updatedAt"`
	Nodes         []NodeView `json:"nodes"`
	// 当前工作副本里仍未消除的节点数(流程定义被修改后,用来和立项时对比)
	Remaining int `json:"remaining"`
}

// IntakeAssessment 评审人对一个技术点的结论
type IntakeAssessment struct {
	UserID    string    `json:"userId"`
	UserName  string    `json:"userName"`
	Verdict   string    `json:"verdict"`
	Note      string    `json:"note"`
	DecidedAt time.Time `json:"decidedAt"`
}

// IntakePoint 送 CTO 评估的技术点
type IntakePoint struct {
	ID            string    `json:"id"`
	Line          string    `json:"line"`
	Title         string    `json:"title"`
	Note          string    `json:"note"`
	CreatedBy     string    `json:"-"` // users.id
	CreatedByName string    `json:"createdByName"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	// 最近一轮评审里各位评审人的结论
	Assessments []IntakeAssessment `json:"assessments"`
	// 复评(第 2 轮起)时上一轮里各位评审人的结论:没变过的技术点可以直接沿用
	PrevAssessments []IntakeAssessment `json:"prevAssessments,omitempty"`
}

// IntakeFinal PMO 终审的一次结论
type IntakeFinal struct {
	ID            string    `json:"id"`
	ReviewID      string    `json:"reviewId"`
	Round         int       `json:"round"`
	Decision      string    `json:"decision"`
	Note          string    `json:"note"`
	DecidedByName string    `json:"decidedByName"`
	DecidedAt     time.Time `json:"decidedAt"`
}

// IntakeSummary 项目列表里的承接摘要(完整内容见 GET /api/projects/{id}/intake)
type IntakeSummary struct {
	Phase        string `json:"phase"`
	Seq          int    `json:"seq"`
	TriageDone   bool   `json:"triageDone"`
	FinalPending bool   `json:"finalPending"`
	// 立项时(As-Is)诊断出的三类节点数
	Offline int `json:"offline"`
	Interop int `json:"interop"`
	Mobile  int `json:"mobile"`
	// 承接阶段已经过去,却没有走完过承接:需求承接上线前就立项并通过的项目,或这个阶段被直接跳过
	Legacy bool `json:"legacy"`
}

// IntakeView 承接的完整视图
type IntakeView struct {
	Phase        string `json:"phase"`
	Seq          int    `json:"seq"`
	Legacy       bool   `json:"legacy"` // 见 IntakeSummary.Legacy
	StageName    string `json:"stageName"`
	Gate         string `json:"gate"`
	ReviewerRole string `json:"reviewerRole"`
	Mode         string `json:"mode"`
	// 最近一轮评审(提交评估后才有)
	ReviewID     string     `json:"reviewId"`
	Round        int        `json:"round"`
	ReviewStatus string     `json:"reviewStatus"`
	TriageDoneAt *time.Time `json:"triageDoneAt"`
	TriageByName string     `json:"triageByName"`
	LeadPmID     string     `json:"leadPmId"`
	LeadPmName   string     `json:"leadPmName"`
	FinalPending bool       `json:"finalPending"`

	AsIs    Diagnosis `json:"asIs"`
	Current Diagnosis `json:"current"`

	Completeness     string         `json:"completeness"`
	CompletenessNote string         `json:"completenessNote"`
	Summary          string         `json:"summary"`
	Lines            []LineView     `json:"lines"`
	Points           []*IntakePoint `json:"points"`
	Finals           []*IntakeFinal `json:"finals"`
	CtoSupport       CtoSupport     `json:"ctoSupport"`
	// 提交评估前还差什么(与服务端提交时的校验同一份规则)
	Missing []string `json:"missing"`
	// 当前登录人是哪几条推进线的负责人(能改自己那一条的原因、方案与节点状态)
	OwnLines []string        `json:"ownLines"`
	Can      map[string]bool `json:"can"`
}

// ---- 环节与规则的纯函数 ----

// intakeStage 承接所在的阶段:模板里标识为 intake 的那一个,且必须是第一个阶段。
// 不是第一个阶段时承接不生效——初析与指派发生在 PM 到岗之前,只有第一阶段能等。
func (pr *Project) intakeStage() (StageTemplate, bool) {
	t, ok := templateAt(pr.template(), 1)
	if !ok || t.Key != keyIntake {
		return StageTemplate{}, false
	}
	return t, true
}

// intakeReview 序号 seq 的阶段上那一轮评审,是不是需求承接的技术可行性评估。
// 是的话事件与通知里都按「技术可行性评估」来说,不提关卡名。
func (pr *Project) intakeReview(seq int) bool {
	st, ok := pr.intakeStage()
	return ok && st.Seq == seq
}

// awaitingFinal 承接阶段的技术可行性评估已通过、正在等 PMO 终审。此时阶段状态在数据上仍是「评审中」
// (方案继续锁定到终审结束),但对外的说法是「待终审」——评审人已经没有要表决的东西。
func awaitingFinal(pr *Project, seq int) bool {
	return pr.FinalStatus == FinalPending && pr.intakeReview(seq)
}

// intakeLegacy 承接阶段已经过去,却没有走完过承接:需求承接上线前就立项并通过第一阶段的项目,或这个阶段被直接跳过。
// 只看「终审通过时间」这一个标记——不能拿「有没有做过初级分析」来推断,管理员可以不做初级分析直接指派 PM,
// 升级前指派的 PM 也不会留下主负责的记录。界面上不把这类项目当成「承接完成」来展示。
func intakeLegacy(pr *Project, phase string) bool {
	return phase == PhaseDone && pr.IntakePassedAt == nil
}

// intakePhase 承接所处环节。st 是承接阶段(project_stages 里序号 1 的那一行)的现状
func intakePhase(pr *Project, st ProjectStage, hasPM bool) string {
	if st.Status == StageApproved || st.Status == StageSkipped || pr.CurrentStage > 1 {
		return PhaseDone
	}
	if pr.FinalStatus == FinalPending {
		return PhaseFinal
	}
	switch {
	case st.Status == StageInReview:
		return PhaseAssess
	case hasPM:
		return PhaseAdvance
	case pr.TriageDoneAt != nil:
		return PhaseAssign
	}
	return PhaseTriage
}

// assessmentConclusion 一轮通过的技术可行性评估 Overall 结论:全部可行 = 通过;
// 有附条件或不可行(已给替代方案)的技术点 = 有条件通过
func assessmentConclusion(verdicts []string) string {
	for _, v := range verdicts {
		if v != VerdictFeasible {
			return "conditional"
		}
	}
	return "pass"
}

// verdictProblem 这个结论是否还缺说明:附条件要写明条件,不可行必须给出替代方案
func verdictProblem(verdict, note string) string {
	switch verdict {
	case VerdictConditional:
		if strings.TrimSpace(note) == "" {
			return "有条件可行的技术点要写明条件"
		}
	case VerdictInfeasible:
		if strings.TrimSpace(note) == "" {
			return "不可行的技术点必须给出替代方案"
		}
	}
	return ""
}

// intakeLineTitle 推进线的名称(界面、导出与提示共用)
func intakeLineTitle(line string) string {
	switch line {
	case LineOffline:
		return "线下节点转线上"
	case LineInterop:
		return "系统不互通"
	case LineMobile:
		return "线上节点移动化"
	}
	return line
}
