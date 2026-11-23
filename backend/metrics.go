package main

import (
	"math"
	"strings"
)

// FlowMetrics 流程改善指标:由 steps 直接计算,As-Is 与 To-Be 各算一次做对比。
// "断点"与流程图里的虚线同口径:线上↔线下衔接,或相邻线上步骤系统数据不互通。
type FlowMetrics struct {
	Steps        int     `json:"steps"`
	OnlineSteps  int     `json:"onlineSteps"`
	OfflineSteps int     `json:"offlineSteps"`
	OfflineShare float64 `json:"offlineShare"` // 线下步骤 / 全部步骤
	Breakpoints  int     `json:"breakpoints"`
	Systems      int     `json:"systems"`
	MobileSteps  int     `json:"mobileSteps"`
	MobileShare  float64 `json:"mobileShare"` // 支持移动端的线上步骤 / 全部线上步骤
	Countersigns int     `json:"countersigns"`
}

// 主步骤办理方式:与流程图一致,非 offline 一律按线上
func stepMode(s Step) string {
	if s.Mode == "offline" {
		return "offline"
	}
	return "online"
}

func subOnline(s SubStep) bool { return s.Mode != "offline" }

// csOverallMode 会签整体办理方式:online | offline | mixed | unknown(无已命名子步骤)
func csOverallMode(step Step) string {
	on, off, named := false, false, false
	for _, pt := range step.Parties {
		for _, sub := range pt.SubSteps {
			if strings.TrimSpace(sub.Name) == "" {
				continue
			}
			named = true
			if subOnline(sub) {
				on = true
			} else {
				off = true
			}
		}
	}
	switch {
	case !named:
		return "unknown"
	case on && off:
		return "mixed"
	case on:
		return "online"
	}
	return "offline"
}

// crosses 两种办理方式之间是否为「线上↔线下」衔接(混合视为衔接,未知不算)
func crosses(a, b string) bool {
	if a == "unknown" || b == "unknown" {
		return false
	}
	return a != b || a == "mixed"
}

// stepNotInterop 主步骤 i 是否标注了「与上一步系统数据不互通」,且该问题确实成立
func stepNotInterop(steps []Step, i int) bool {
	if i <= 0 {
		return false
	}
	s := steps[i]
	if s.Online.DataInteroperable == nil || *s.Online.DataInteroperable {
		return false
	}
	cur := strings.TrimSpace(s.Online.SystemName)
	if cur == "" {
		return false
	}
	prev := steps[i-1]
	if prev.Countersign {
		return len(countersignExitSystems(prev.Parties, cur)) > 0
	}
	return prev.Mode == "online" && strings.TrimSpace(prev.Online.SystemName) != cur
}

// laneBroken 会签分支内相邻两个已命名子步骤的衔接是否为断点
func laneBroken(prev, cur SubStep) bool {
	if subOnline(prev) != subOnline(cur) {
		return true
	}
	if !subOnline(prev) {
		return false
	}
	p := strings.TrimSpace(prev.Online.SystemName)
	return p != "" && p != strings.TrimSpace(cur.Online.SystemName) &&
		cur.Online.DataInteroperable != nil && !*cur.Online.DataInteroperable
}

func ratio(a, b int) float64 {
	if b == 0 {
		return 0
	}
	return math.Round(float64(a)/float64(b)*1000) / 1000
}

// ComputeMetrics 计算一组步骤的流程改善指标
func ComputeMetrics(steps []Step) FlowMetrics {
	m := FlowMetrics{}
	systems := map[string]bool{}

	count := func(online bool, sys string, mobile *bool) {
		if !online {
			m.OfflineSteps++
			return
		}
		m.OnlineSteps++
		if n := strings.TrimSpace(sys); n != "" {
			systems[n] = true
		}
		if mobile != nil && *mobile {
			m.MobileSteps++
		}
	}

	prevMain := "unknown"
	var boxes []string // 上一主干节点之后挂载的会签容器的整体办理方式
	// flush 结算「上一主干节点 → 若干会签容器 → 当前节点」这一段的衔接
	flush := func(curMode string, curIdx int) {
		if len(boxes) == 0 {
			if crosses(prevMain, curMode) || stepNotInterop(steps, curIdx) {
				m.Breakpoints++
			}
			return
		}
		if crosses(prevMain, boxes[0]) {
			m.Breakpoints++
		}
		for k := 1; k < len(boxes); k++ {
			if crosses(boxes[k-1], boxes[k]) {
				m.Breakpoints++
			}
		}
		if crosses(boxes[len(boxes)-1], curMode) || stepNotInterop(steps, curIdx) {
			m.Breakpoints++
		}
		boxes = nil
	}

	for i, s := range steps {
		if s.Countersign {
			m.Steps++
			m.Countersigns++
			boxes = append(boxes, csOverallMode(s))
			for _, pt := range s.Parties {
				var named []SubStep
				for _, sub := range pt.SubSteps {
					if strings.TrimSpace(sub.Name) != "" {
						named = append(named, sub)
					}
				}
				for k, sub := range named {
					m.Steps++
					count(subOnline(sub), sub.Online.SystemName, sub.Online.MobileSupported)
					if k > 0 && laneBroken(named[k-1], sub) {
						m.Breakpoints++
					}
				}
			}
			continue
		}
		m.Steps++
		on := stepMode(s) == "online"
		count(on, s.Online.SystemName, s.Online.MobileSupported)
		flush(stepMode(s), i)
		prevMain = stepMode(s)
	}
	flush("unknown", -1)

	m.Systems = len(systems)
	m.OfflineShare = ratio(m.OfflineSteps, m.Steps)
	m.MobileShare = ratio(m.MobileSteps, m.OnlineSteps)
	return m
}

// HandlerHints 从流程里提取出现的经办人员(申报人 + 各处登记的人员),并尽量匹配到用户
func HandlerHints(p *Process, users []*User) []HandlerHint {
	seen := map[string]bool{}
	var raws []string
	add := func(name string) {
		n := strings.TrimSpace(name)
		if n == "" || seen[n] {
			return
		}
		seen[n] = true
		raws = append(raws, n)
	}
	add(p.Applicant)
	for _, s := range p.Steps {
		for _, h := range s.Offline.Handlers {
			for _, st := range h.Staff {
				add(st)
			}
		}
		for _, pt := range s.Parties {
			for _, st := range pt.Staff {
				add(st)
			}
			for _, sub := range pt.SubSteps {
				for _, h := range sub.Offline.Handlers {
					for _, st := range h.Staff {
						add(st)
					}
				}
			}
		}
	}
	byName := map[string]*User{}
	for _, u := range users {
		if n := strings.TrimSpace(u.DisplayName); n != "" {
			if _, ok := byName[n]; !ok {
				byName[n] = u
			}
		}
		if _, ok := byName[u.Username]; !ok {
			byName[u.Username] = u
		}
	}
	out := make([]HandlerHint, 0, len(raws))
	for _, raw := range raws {
		h := HandlerHint{Raw: raw}
		if u := byName[raw]; u != nil {
			h.UserID, h.DisplayName, h.Matched = u.ID, displayName(u), true
		}
		out = append(out, h)
	}
	return out
}

// displayName 用户显示名(未填则回退用户名)
func displayName(u *User) string {
	if n := strings.TrimSpace(u.DisplayName); n != "" {
		return n
	}
	return u.Username
}
