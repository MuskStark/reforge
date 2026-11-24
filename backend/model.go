package main

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// Handler 表示线下经办方：部门 + 涉及人员
type Handler struct {
	Department string   `json:"department"`
	Staff      []string `json:"staff"`
}

// SubStep 会签方内部的子步骤（会签内部可能存在多步），
// 与主步骤同样采集线上/线下属性
type SubStep struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Mode    string      `json:"mode"` // online | offline（旧数据缺省按 online）
	Online  OnlineInfo  `json:"online"`
	Offline OfflineInfo `json:"offline"`
}

// Party 会签方：部门 + 涉及人员 + 分支内部子步骤（各方并行、内部顺序执行）
type Party struct {
	ID         string    `json:"id"`
	Department string    `json:"department"`
	Staff      []string  `json:"staff"`
	SubSteps   []SubStep `json:"subSteps"`
}

// OnlineInfo 线上处理属性：系统名称、是否支持移动端（必选，nil=未选择）；
// DataInteroperable 与前一线上节点的系统是否数据互通——
// 仅当相邻两线上节点系统名称不同时必填（nil=未填写）；
// 上一步为会签时，比较对象是各方最后一个子步骤的系统（见 countersignExitSystems）
type OnlineInfo struct {
	SystemName        string `json:"systemName"`
	MobileSupported   *bool  `json:"mobileSupported"`
	DataInteroperable *bool  `json:"dataInteroperable"`
}

// OfflineInfo 线下处理属性：涉及文件名称、经办部门及人员
type OfflineInfo struct {
	Documents []string  `json:"documents"`
	Handlers  []Handler `json:"handlers"`
}

// WaitFor 前置会签依赖：当前步骤需等待指定会签步骤（可选：仅某个会签方）通过后方可执行
type WaitFor struct {
	StepID  string `json:"stepId"`  // 依赖的会签步骤 ID（须为更早的会签步骤）
	PartyID string `json:"partyId"` // 可选：仅等待该会签方分支；空 = 整个会签全部通过
}

// Step 流程中的单个步骤，支持会签（多方并行签署、内部可含多步）
type Step struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Mode        string      `json:"mode"` // online | offline
	Countersign bool        `json:"countersign"`
	Online      OnlineInfo  `json:"online"`
	Offline     OfflineInfo `json:"offline"`
	Parties     []Party     `json:"parties"` // 会签方列表
	WaitFor     *WaitFor    `json:"waitFor"` // 前置会签依赖（可选）
	Remark      string      `json:"remark"`
}

// Process 一次收集到的完整流程
type Process struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Applicant   string    `json:"applicant"`
	Steps       []Step    `json:"steps"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`

	// ---- 跟进体系(docs/followup-plan.md)----
	FollowStatus string `json:"followStatus"`           // analyzing|unassigned|following|review|done|shelved
	AssigneeID   string `json:"assigneeId,omitempty"`   // users.id
	AssigneeName string `json:"assigneeName,omitempty"` // join users.username
	DueDate      string `json:"dueDate,omitempty"`      // YYYY-MM-DD
	Stage        int    `json:"stage"`                  // 0..5 改造阶段
	Analysis     []byte `json:"analysis,omitempty"`     // 需求分析结论 JSON
}

// FollowEvent 跟进动态(不可变追加,驱动时间线)
type FollowEvent struct {
	ID        string    `json:"id"`
	ProcessID string    `json:"processId"`
	ActorID   string    `json:"actorId"` // 用户名(会话侧标识)
	ActorName string    `json:"actorName"`
	Kind      string    `json:"kind"` // analyzed|assigned|status|stage|edited_form|edited_chart
	Detail    []byte    `json:"detail,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// SystemOption 管理员维护的线上系统库条目（前台表单下拉选择）
type SystemOption struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// User 注册用户：首个注册用户自动成为管理员，其后为普通成员。
// Role 是系统角色(只管系统管理);JobRole 是全局岗位(CTO / 项目经理 / 经办 / 开发实施 / 观察者)。
type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"` // admin | member
	DisplayName  string `json:"displayName"`
	Department   string `json:"department"`
	JobRole      string `json:"jobRole"` // cto | pm | handler | dev | viewer
	// 管理员建号（密码由管理员设定）后为 true：首次登录必须先改密码，改完自动清除
	MustChangePassword bool      `json:"mustChangePassword"`
	CreatedAt          time.Time `json:"createdAt"`
}

// validateProcess 校验流程数据，返回中文错误信息供前端展示
func validateProcess(p *Process) string {
	if p.Name == "" {
		return "流程名称不能为空"
	}
	if len(p.Steps) == 0 {
		return "请至少添加一个流程步骤"
	}
	// 数量上限(防 1MB 内的结构滥用)
	if len(p.Steps) > 200 {
		return "流程步骤过多(上限 200)"
	}
	if l := len([]rune(p.Name)); l > 200 {
		return "流程名称过长"
	}
	if l := len([]rune(p.Description)); l > 2000 {
		return "流程说明过长"
	}
	for i, s := range p.Steps {
		n := i + 1
		if l := len([]rune(s.Name)); l > 200 {
			return fmt.Sprintf("第 %d 步名称过长", n)
		}
		if len(s.Offline.Documents) > 100 {
			return fmt.Sprintf("第 %d 步涉及文件过多(上限 100)", n)
		}
		if len(s.Parties) > 50 {
			return fmt.Sprintf("第 %d 步会签方过多(上限 50)", n)
		}
		for _, pt := range s.Parties {
			if len(pt.SubSteps) > 100 {
				return fmt.Sprintf("第 %d 步会签方「%s」子步骤过多", n, pt.Department)
			}
		}
		if s.Name == "" {
			return "第 " + itoa(n) + " 步的步骤名称不能为空"
		}
		if s.Countersign {
			// 会签步骤：线上/线下属性下沉到每个内部子步骤，主级不再校验
			if !hasParty(s.Parties) {
				return "第 " + itoa(n) + " 步开启了会签，请至少添加一个会签部门及人员"
			}
			if msg := validateSubSteps(n, s.Parties); msg != "" {
				return msg
			}
		} else {
			switch s.Mode {
			case "online":
				if s.Online.SystemName == "" {
					return "第 " + itoa(n) + " 步为线上处理，请填写承载该步骤的系统名称"
				}
				if s.Online.MobileSupported == nil {
					return "第 " + itoa(n) + " 步为线上处理，请选择是否支持移动端"
				}
				if i > 0 {
					prev := p.Steps[i-1]
					if s.Online.DataInteroperable == nil {
						if !prev.Countersign && prev.Mode == "online" && prev.Online.SystemName != s.Online.SystemName {
							return "第 " + itoa(n) + " 步与上一步均为线上且系统不同（" + prev.Online.SystemName + " → " + s.Online.SystemName + "），请选择两系统是否数据互通"
						}
						// 上一步为会签:各方交接出来的系统(见 countersignExitSystems)任一与本步骤不同,同样必填
						if prev.Countersign {
							if sys := countersignExitSystems(prev.Parties, s.Online.SystemName); len(sys) > 0 {
								return "第 " + itoa(n) + " 步与上一步（会签）均为线上且系统不同（" + strings.Join(sys, "、") + " → " + s.Online.SystemName + "），请选择两系统是否数据互通"
							}
						}
					}
				}
			case "offline":
				if !hasHandler(s.Offline.Handlers) {
					return "第 " + itoa(n) + " 步为线下处理，请至少填写一个经办部门及人员"
				}
			default:
				return "第 " + itoa(n) + " 步的处理方式无效（应为 online 或 offline）"
			}
		}
		if w := s.WaitFor; w != nil {
			if w.StepID == "" {
				return "第 " + itoa(n) + " 步的前置会签依赖不完整"
			}
			if w.StepID == s.ID || !isBefore(p.Steps, s.ID, w.StepID) {
				return "第 " + itoa(n) + " 步的前置会签依赖只能指向其之前的会签步骤"
			}
			dep, ok := lookupStep(p.Steps, w.StepID)
			if !ok {
				return "第 " + itoa(n) + " 步的前置会签依赖指向的步骤不存在"
			}
			if !dep.Countersign {
				return "第 " + itoa(n) + " 步的前置依赖「" + dep.Name + "」不是会签步骤"
			}
			if w.PartyID != "" && !hasPartyID(dep.Parties, w.PartyID) {
				return "第 " + itoa(n) + " 步的前置会签依赖指向的会签方不存在"
			}
		}
	}
	return ""
}

func lookupStep(steps []Step, id string) (Step, bool) {
	for _, s := range steps {
		if s.ID == id {
			return s, true
		}
	}
	return Step{}, false
}

// countersignExitSystems 会签交接给下一步的线上系统:每一方取其最后一个子步骤
// (sanitize 已清理空名子步骤),为线上且系统与 next 不同才计入;按会签方顺序去重。
// 返回非空 = 下一步(线上)须填写与这些系统的数据互通情况。
func countersignExitSystems(parties []Party, next string) []string {
	out := make([]string, 0, len(parties))
	for _, pt := range parties {
		if len(pt.SubSteps) == 0 {
			continue
		}
		last := pt.SubSteps[len(pt.SubSteps)-1]
		if last.Mode != "online" || last.Online.SystemName == "" || last.Online.SystemName == next {
			continue
		}
		if !slices.Contains(out, last.Online.SystemName) {
			out = append(out, last.Online.SystemName)
		}
	}
	return out
}

// validateSubSteps 校验会签方内部子步骤的线上/线下属性（与主步骤规则一致）。
// 系统互通以清理后的相邻子步骤为基准（即上一个已命名子步骤）
func validateSubSteps(n int, parties []Party) string {
	for j, party := range parties {
		who := party.Department
		if who == "" {
			who = "会签方" + itoa(j+1)
		}
		for k, sub := range party.SubSteps {
			if sub.Name == "" {
				continue
			}
			switch sub.Mode {
			case "online":
				if sub.Online.SystemName == "" {
					return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + sub.Name + "」为线上处理，请填写系统名称"
				}
				if sub.Online.MobileSupported == nil {
					return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + sub.Name + "」为线上处理，请选择是否支持移动端"
				}
				if k > 0 {
					prev := party.SubSteps[k-1]
					if prev.Mode == "online" && prev.Online.SystemName != sub.Online.SystemName && sub.Online.DataInteroperable == nil {
						return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + prev.Name + " → " + sub.Name + "」系统不同，请选择两系统是否数据互通"
					}
				}
			case "offline":
				if !hasHandler(sub.Offline.Handlers) {
					return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + sub.Name + "」为线下处理，请至少填写一个经办部门及人员"
				}
			default:
				return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + sub.Name + "」的处理方式无效"
			}
		}
	}
	return ""
}

func hasPartyID(ps []Party, id string) bool {
	for _, p := range ps {
		if p.ID == id {
			return true
		}
	}
	return false
}

// isBefore 校验依赖步骤是否位于当前步骤之前（禁止向前依赖/自依赖）
func isBefore(steps []Step, curID, depID string) bool {
	for _, s := range steps {
		if s.ID == depID {
			return true
		}
		if s.ID == curID {
			return false
		}
	}
	return false
}

// hasHandler 判断线下经办列表中是否存在至少一条有效记录（部门或人员非空）
func hasHandler(hs []Handler) bool {
	for _, h := range hs {
		if h.Department != "" || len(nonEmpty(h.Staff)) > 0 {
			return true
		}
	}
	return false
}

// hasParty 判断会签方列表中是否存在至少一方（部门或人员非空）
func hasParty(ps []Party) bool {
	for _, p := range ps {
		if p.Department != "" || len(nonEmpty(p.Staff)) > 0 {
			return true
		}
	}
	return false
}

func nonEmpty(ss []string) []string {
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
