package main

import "time"

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
	ID       string    `json:"id"`
	Department string  `json:"department"`
	Staff    []string  `json:"staff"`
	SubSteps []SubStep `json:"subSteps"`
}

// OnlineInfo 线上处理属性：系统名称、是否支持移动端
type OnlineInfo struct {
	SystemName      string `json:"systemName"`
	MobileSupported bool   `json:"mobileSupported"`
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
}

// SystemOption 管理员维护的线上系统库条目（前台表单下拉选择）
type SystemOption struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// User 注册用户：首个注册用户自动成为管理员，其后为普通成员
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"` // admin | member
	CreatedAt    time.Time `json:"createdAt"`
}

// validateProcess 校验流程数据，返回中文错误信息供前端展示
func validateProcess(p *Process) string {
	if p.Name == "" {
		return "流程名称不能为空"
	}
	if len(p.Steps) == 0 {
		return "请至少添加一个流程步骤"
	}
	for i, s := range p.Steps {
		n := i + 1
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

// validateSubSteps 校验会签方内部子步骤的线上/线下属性（与主步骤规则一致）
func validateSubSteps(n int, parties []Party) string {
	for j, party := range parties {
		who := party.Department
		if who == "" {
			who = "会签方" + itoa(j+1)
		}
		for _, sub := range party.SubSteps {
			if sub.Name == "" {
				continue
			}
			switch sub.Mode {
			case "online":
				if sub.Online.SystemName == "" {
					return "第 " + itoa(n) + " 步「" + who + "」的子步骤「" + sub.Name + "」为线上处理，请填写系统名称"
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
