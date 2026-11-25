package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// 导出件里的需求承接:项目报告(Markdown / JSON)里的「需求承接」一节。
// 数据与界面看到的同源(同一个完整视图),历次评审的结论另外从 intake_assessments 读。

// intakeAssessmentExport 技术点在某一轮技术可行性评估里的结论
type intakeAssessmentExport struct {
	Round     int       `json:"round"`
	Line      string    `json:"line"`
	Title     string    `json:"title"`
	UserName  string    `json:"userName"`
	Verdict   string    `json:"verdict"`
	Note      string    `json:"note"`
	DecidedAt time.Time `json:"decidedAt"`
}

// intakeAssessmentsOf 历次评审里各位评审人对技术点的结论(按轮次与录入顺序)
func intakeAssessmentsOf(ctx context.Context, q runner, projectID string) ([]intakeAssessmentExport, error) {
	out := []intakeAssessmentExport{}
	rows, err := q.QueryContext(ctx, `SELECT r.round, p.line_key, p.title,
		COALESCE(NULLIF(u.display_name, ''), u.username, ''), a.verdict, a.note, a.decided_at
		FROM intake_assessments a
		JOIN gate_reviews r ON r.id = a.review_id
		JOIN intake_points p ON p.id = a.point_id
		LEFT JOIN users u ON u.id = a.user_id
		WHERE r.project_id = $1
		ORDER BY r.round, r.submitted_at, p.sort_key, p.created_at, a.decided_at`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a intakeAssessmentExport
		if err := rows.Scan(&a.Round, &a.Line, &a.Title, &a.UserName, &a.Verdict, &a.Note, &a.DecidedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// intakeMark 推进线的序号:①②③(与解决顺序一致);不属于任何推进线的技术点用「—」
func intakeMark(line string) string {
	for i, key := range intakeLineKeys {
		if key == line {
			return []string{"①", "②", "③"}[i]
		}
	}
	return "—"
}

func intakeOrder(i int) string {
	return []string{"第一优先", "第二优先", "第三优先"}[i]
}

func completenessText(status, note string) string {
	head := ""
	switch status {
	case Complete:
		head = "结构完整"
	case HasGaps:
		head = "有缺口，待补全"
	default:
		return "尚未确认"
	}
	if strings.TrimSpace(note) != "" {
		return head + "：" + note
	}
	return head
}

// nodeText 诊断出的一个节点在报告里的写法:第几步、名称、会签方、处理状态与说明
func nodeText(n NodeView) string {
	s := "第" + itoa(n.Step) + "步 " + n.Name
	if n.Path != "" {
		s += "（" + n.Path + "）"
	}
	if n.System != "" {
		s += " · " + n.System
	}
	if n.From != "" {
		s += " · 与「" + n.From + "」不互通"
	}
	switch n.Status {
	case PlanPlanned:
		s += "〔方案已定〕"
	case PlanNa:
		s += "〔无需处理〕"
	}
	if strings.TrimSpace(n.Note) != "" {
		s += "：" + mdCell(n.Note)
	}
	return s
}

func supportText(s CtoSupport) string {
	switch s.Status {
	case SupportRequested:
		text := "已申请协助：" + s.Reason
		if s.RequestedByName != "" {
			text += "（" + s.RequestedByName
			if s.RequestedAt != nil {
				text += "，" + s.RequestedAt.Local().Format("2006-01-02 15:04")
			}
			text += "）"
		}
		return text
	case SupportJoined:
		return s.JoinedByName + " 已加入协助"
	}
	return "—"
}

// intakeSectionMarkdown 项目报告里的「需求承接」一节;项目没有承接阶段时返回空串
func intakeSectionMarkdown(ex *projectExport) string {
	v := ex.Intake
	if v == nil {
		return ""
	}
	p := ex.Project
	var b strings.Builder
	b.WriteString("## 需求承接\n\n")
	if v.Legacy {
		b.WriteString("这个阶段没有承接记录：项目在需求承接启用前就已立项并通过第一阶段，或这个阶段被直接跳过。\n")
		return b.String()
	}

	triage := "未做"
	if v.TriageDoneAt != nil {
		triage = orDash(v.TriageByName) + " · " + v.TriageDoneAt.Local().Format("2006-01-02 15:04")
	}
	var an struct {
		Conclusion string `json:"conclusion"`
	}
	if p.Analysis != nil {
		_ = json.Unmarshal(p.Analysis, &an)
	}
	facts := [][]string{
		{"当前环节", phaseLabel(v.Phase)},
		{"初级分析（PMO）", triage + "；改造价值 " + orDash(p.Value) + " · 复杂度 " + orDash(p.Complexity) + " · 优先级 " + label(priorityLabel, p.Priority)},
		{"初级分析结论", orDash(mdText(an.Conclusion, maxIntakeText))},
		{"自动诊断", fmt.Sprintf("立项时：线下节点 %d、系统不互通节点 %d、无法实现移动端节点 %d；当前工作副本：%d、%d、%d",
			len(v.AsIs.Offline), len(v.AsIs.Interop), len(v.AsIs.Mobile), len(v.Current.Offline), len(v.Current.Interop), len(v.Current.Mobile))},
		{"流程是否完整", completenessText(v.Completeness, v.CompletenessNote)},
		{"主负责 PM", orDash(v.LeadPmName)},
	}
	if v.CtoSupport.Status != SupportNone {
		facts = append(facts, []string{"CTO 协助", supportText(v.CtoSupport)})
	}
	b.WriteString(mdTable([]string{"项目", "内容"}, facts))
	b.WriteString("\n")
	if s := mdText(v.Summary, maxIntakeText); s != "" {
		fmt.Fprintf(&b, "**综合方案总述**：%s\n\n", s)
	}

	b.WriteString("三条推进线按解决顺序推进：先把线下节点转为线上，再打通系统互通，最后做线上节点的移动化。\n\n")
	rows := [][]string{}
	for i, l := range v.Lines {
		nodes := []string{}
		for _, n := range l.Nodes {
			nodes = append(nodes, nodeText(n))
		}
		reason, solution := mdText(l.Reason, maxIntakeText), mdText(l.Solution, maxIntakeText)
		if len(l.Nodes) == 0 {
			reason, solution = "（无此类节点）", "（无此类节点）"
		}
		rows = append(rows, []string{intakeOrder(i), intakeLineTitle(l.Key), orDash(strings.Join(nodes, "；")), reason, solution, orDash(l.OwnerName)})
	}
	b.WriteString(mdTable([]string{"顺序", "推进线", "诊断出的节点", "原因", "解决方案", "负责人"}, rows))
	b.WriteString("\n")

	if len(v.Points) > 0 || len(ex.IntakeAssessments) > 0 {
		b.WriteString("### 技术点与技术可行性评估\n\n")
		if len(v.Points) > 0 {
			prows := [][]string{}
			for _, pt := range v.Points {
				prows = append(prows, []string{intakeMark(pt.Line), mdCell(pt.Title), orDash(mdText(pt.Note, maxIntakeNote)), orDash(pt.CreatedByName)})
			}
			b.WriteString(mdTable([]string{"推进线", "技术点", "说明", "提出人"}, prows))
			b.WriteString("\n")
		}
		if len(ex.IntakeAssessments) > 0 {
			arows := [][]string{}
			for _, a := range ex.IntakeAssessments {
				arows = append(arows, []string{"第 " + itoa(a.Round) + " 轮", intakeMark(a.Line), mdCell(a.Title),
					mdCell(a.UserName), verdictLabel(a.Verdict), orDash(mdCell(a.Note))})
			}
			b.WriteString(mdTable([]string{"轮次", "推进线", "技术点", "评估人", "结论", "条件 / 替代方案"}, arows))
			b.WriteString("\n")
		} else {
			b.WriteString("还没有给出任何结论。\n\n")
		}
	}

	if len(v.Finals) > 0 {
		b.WriteString("### PMO 终审\n\n")
		frows := [][]string{}
		for _, f := range v.Finals {
			frows = append(frows, []string{f.DecidedAt.Local().Format("2006-01-02 15:04"), mdCell(f.DecidedByName),
				finalLabel(f.Decision), "第 " + itoa(f.Round) + " 轮评估", orDash(mdCell(f.Note))})
		}
		b.WriteString(mdTable([]string{"时间", "终审人", "结论", "终审对象", "意见"}, frows))
		b.WriteString("\n")
	}
	return b.String()
}
