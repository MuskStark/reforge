package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// 导出:项目清单(CSV,Excel 可直接打开)与单个项目的完整报告(Markdown / JSON)。
// 导出范围与查看范围一致——登录即可导出。

// ---- 文案(与前端 lib/labels.ts 保持同一口径) ----

var (
	projStatusLabel   = map[string]string{ProjActive: "进行中", ProjOnHold: "已搁置", ProjCancelled: "已取消", ProjDone: "已完成"}
	priorityLabel     = map[string]string{"high": "高", "medium": "中", "low": "低"}
	healthLabel       = map[string]string{"on_track": "正常", "at_risk": "有风险", "off_track": "已偏离"}
	stageStatusLabel  = map[string]string{StagePending: "待开始", StageInProgress: "进行中", StageInReview: "评审中", StageApproved: "已通过", StageSkipped: "已跳过"}
	pendingOnLabel    = map[string]string{"admin": "待指派 PM", "pm": "待 PM 处理", "cto": "待 CTO 评审", "handler": "待 BH 确认"}
	reviewStatusLabel = map[string]string{ReviewPending: "待决", ReviewApproved: "已通过", ReviewRejected: "已驳回", ReviewWithdrawn: "已撤回"}
	decisionLabel     = map[string]string{DecisionPending: "待表决", DecisionApprove: "通过", DecisionReject: "驳回"}
	modeLabel         = map[string]string{ModeAll: "会签", ModeAny: "或签"}
	reviewerRoleLabel = map[string]string{RoleCTO: "CTO", RoleHandler: "BH", "admin": "管理员裁决"}
	itemTypeLabel     = map[string]string{ItemTask: "任务", ItemDeliverable: "交付物", ItemIssue: "问题", ItemRisk: "风险", ItemChange: "变更"}
	versionKindLabel  = map[string]string{"as_is": "立项时（As-Is）", "to_be": "To-Be 基线", "published": "已发布"}
	// 岗位与成员角色的显示名一律用英文缩写(BH 业务经办、TH 科技经办、GM 总经理),与前端 lib/labels.ts 一致
	projectRoleLabel   = map[string]string{RolePM: "PM", RoleHandler: "BH", RoleDev: "TH", RoleViewer: "GM"}
	projectRoleOrderBy = map[string]int{RolePM: 0, RoleHandler: 1, RoleDev: 2, RoleViewer: 3}
	eventKindLabel     = map[string]string{
		"project_created": "建立项目", "project_updated": "修改项目信息", "project_status": "变更项目状态", "project_update": "提交简报",
		"member_added": "加入成员", "member_removed": "移除成员",
		"review_submitted": "提交评审", "review_voted": "评审表决", "review_approved": "评审通过", "review_rejected": "评审驳回",
		"review_withdrawn": "撤回评审", "review_admin_decided": "管理员裁决",
		"stage_rewound": "回退阶段", "stage_skipped": "跳过阶段",
		"item_created": "新建工作项", "item_updated": "修改工作项", "item_status": "变更工作项状态", "item_split": "拆分工作项",
		"item_deleted": "删除工作项", "comment_added": "发表评论",
		"legacy_analyzed": "完成分析（旧跟进）", "legacy_assigned": "指派跟进人（旧跟进）", "legacy_status": "变更跟进状态（旧跟进）",
		"legacy_stage": "推进阶段（旧跟进）", "legacy_edited_form": "编辑表单（旧跟进）", "legacy_edited_chart": "编辑流程图（旧跟进）",
	}
)

func label(m map[string]string, key string) string {
	if s, ok := m[key]; ok {
		return s
	}
	return key
}

// ---- 项目清单 CSV ----

func (s *postgresStore) handleExportProjectsCSV(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	where, args := "", []any{}
	var order []string // 传了 ids 时按传入顺序输出,和界面上的筛选结果一致
	if r.Method == http.MethodPost {
		var body struct {
			IDs []string `json:"ids"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "请求数据格式不正确")
			return
		}
		if len(body.IDs) == 0 || len(body.IDs) > 5000 {
			writeError(w, http.StatusBadRequest, "请选择要导出的项目")
			return
		}
		where, args, order = `WHERE pr.id = ANY($1)`, []any{body.IDs}, body.IDs
	} else if st := strings.TrimSpace(r.URL.Query().Get("status")); st != "" {
		if _, known := projStatusLabel[st]; !known {
			writeError(w, http.StatusBadRequest, "项目状态取值不合法")
			return
		}
		where, args = `WHERE pr.status = $1`, []any{st}
	}
	projects, err := listProjects(r.Context(), s.db, where, args...)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if order != nil {
		rank := map[string]int{}
		for i, id := range order {
			rank[id] = i
		}
		sort.SliceStable(projects, func(i, j int) bool { return rank[projects[i].ID] < rank[projects[j].ID] })
	}
	ids := make([]string, 0, len(projects))
	for _, pr := range projects {
		ids = append(ids, pr.ID)
	}
	bundle, err := loadBundle(r.Context(), s.db, ids)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="reforge-projects-`+time.Now().Format("20060102")+`.csv"`)
	// 字节序标记:让 Excel 直接按 UTF-8 识别中文
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	_ = cw.Write([]string{
		"项目名称", "申报人", "状态", "当前阶段", "待处理", "优先级", "改造价值", "复杂度", "健康度", "PM", "目标完成日",
		"工作项", "已完成", "逾期", "阻塞", "未完成必交付物",
		"步骤数", "线下步骤占比", "断点数", "涉及系统数", "移动端支持率", "会签数", "创建时间", "完成时间",
	})
	for _, pr := range projects {
		v := bundle.view(pr, nil, caps{})
		pms := []string{}
		for _, m := range v.Members {
			if m.Role == RolePM {
				pms = append(pms, m.DisplayName)
			}
		}
		stage := ""
		if t, ok := pr.stageAt(pr.CurrentStage); ok {
			stage = fmt.Sprintf("%d. %s", t.Seq, t.Name)
		}
		completed := ""
		if pr.CompletedAt != nil {
			completed = pr.CompletedAt.Local().Format("2006-01-02 15:04")
		}
		_ = cw.Write([]string{
			csvCell(pr.Name), csvCell(v.Applicant), label(projStatusLabel, pr.Status), csvCell(stage), label(pendingOnLabel, v.PendingOn),
			label(priorityLabel, pr.Priority), pr.Value, pr.Complexity, label(healthLabel, pr.Health), csvCell(strings.Join(pms, "、")), pr.DueDate,
			itoa(v.Stats.Total), itoa(v.Stats.Done), itoa(v.Stats.Overdue), itoa(v.Stats.Blocked), csvCell(strings.Join(v.Stats.Missing, "、")),
			itoa(v.Metrics.Steps), percent(v.Metrics.OfflineShare), itoa(v.Metrics.Breakpoints), itoa(v.Metrics.Systems),
			percent(v.Metrics.MobileShare), itoa(v.Metrics.Countersigns),
			pr.CreatedAt.Local().Format("2006-01-02 15:04"), completed,
		})
	}
	cw.Flush()
}

func percent(f float64) string { return fmt.Sprintf("%d%%", int(f*100+0.5)) }

// csvCell 防公式注入:以 = + - @ 或制表 / 回车开头的单元格,Excel 会当作公式执行。
// 流程名称与申报人是匿名提交的自由文本,会原样进入清单,所以统一加一个单引号前缀让 Excel 按文本处理。
func csvCell(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}

// ---- 单个项目报告 ----

// projectExport 一个项目的完整数据(JSON 导出的结构;Markdown 报告由同样的数据渲染)
type projectExport struct {
	GeneratedAt time.Time         `json:"generatedAt"`
	Project     *ProjectView      `json:"project"`
	Reviews     []*GateReview     `json:"reviews"`
	Items       []*WorkItem       `json:"items"`
	Comments    []*Comment        `json:"comments"`
	Versions    []*ProcessVersion `json:"versions"`
	Events      []Event           `json:"events"`
}

func (s *postgresStore) handleExportProject(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	id := pathID(r)
	pr, err := getProject(r.Context(), s.db, id, false)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if pr == nil {
		writeError(w, http.StatusNotFound, "项目不存在")
		return
	}
	ex, err := s.collectExport(r, id, pr)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	safe := fmt.Sprintf("reforge-project-%s", id)
	if r.URL.Query().Get("format") == "json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+safe+`.json"; filename*=UTF-8''`+url.PathEscape(pr.Name)+`.json`)
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		_ = enc.Encode(ex)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+safe+`.md"; filename*=UTF-8''`+url.PathEscape(pr.Name)+`.md`)
	_, _ = w.Write([]byte(renderProjectMarkdown(ex)))
}

func (s *postgresStore) collectExport(r *http.Request, id string, pr *Project) (*projectExport, error) {
	ctx := r.Context()
	bundle, err := loadBundle(ctx, s.db, []string{id})
	if err != nil {
		return nil, err
	}
	ex := &projectExport{GeneratedAt: time.Now(), Project: bundle.view(pr, nil, caps{})}
	ex.Project.Can = map[string]bool{} // 导出件不带"当前用户能做什么"
	if ex.Reviews, err = listReviewsTx(ctx, s.db, id); err != nil {
		return nil, err
	}
	sort.SliceStable(ex.Reviews, func(i, j int) bool {
		if ex.Reviews[i].StageSeq != ex.Reviews[j].StageSeq {
			return ex.Reviews[i].StageSeq < ex.Reviews[j].StageSeq
		}
		return ex.Reviews[i].Round < ex.Reviews[j].Round
	})
	items, err := queryItems(ctx, s.db, `SELECT `+itemCols+itemFrom+` WHERE w.project_id = $1 ORDER BY w.stage_seq NULLS LAST, w.sort_key, w.created_at`, id)
	if err != nil {
		return nil, err
	}
	if err := attachLinks(ctx, s.db, items); err != nil {
		return nil, err
	}
	ex.Items = items
	crows, err := s.db.QueryContext(ctx, `SELECT `+commentCols+`
		FROM comments c LEFT JOIN work_items w ON w.id = c.item_id LEFT JOIN users u ON u.id = c.author_id
		WHERE c.project_id = $1 ORDER BY c.created_at ASC`, id)
	if err != nil {
		return nil, err
	}
	ex.Comments = []*Comment{}
	for crows.Next() {
		c, err := scanComment(crows)
		if err != nil {
			crows.Close()
			return nil, err
		}
		ex.Comments = append(ex.Comments, c)
	}
	crows.Close()
	if err := crows.Err(); err != nil {
		return nil, err
	}
	vrows, err := s.db.QueryContext(ctx, `SELECT `+versionCols+` FROM process_versions v
		LEFT JOIN users u ON u.id = v.created_by WHERE v.project_id = $1 ORDER BY v.version ASC`, id)
	if err != nil {
		return nil, err
	}
	ex.Versions = []*ProcessVersion{}
	for vrows.Next() {
		v, err := scanVersion(vrows, false)
		if err != nil {
			vrows.Close()
			return nil, err
		}
		ex.Versions = append(ex.Versions, v)
	}
	vrows.Close()
	if err := vrows.Err(); err != nil {
		return nil, err
	}
	erows, err := s.db.QueryContext(ctx, `SELECT id, project_id, scope, target_id, actor_id, actor_name, kind, detail, created_at
		FROM events WHERE project_id = $1 ORDER BY created_at ASC, id ASC`, id)
	if err != nil {
		return nil, err
	}
	ex.Events = []Event{}
	for erows.Next() {
		var e Event
		var detail []byte
		if err := erows.Scan(&e.ID, &e.ProjectID, &e.Scope, &e.TargetID, &e.ActorID, &e.ActorName, &e.Kind, &detail, &e.CreatedAt); err != nil {
			erows.Close()
			return nil, err
		}
		e.Detail = rawOrNull(detail)
		ex.Events = append(ex.Events, e)
	}
	erows.Close()
	return ex, erows.Err()
}

// ---- Markdown 渲染 ----

// mdCell 表格单元格里的一段文字:转义竖线、压掉换行
func mdCell(s string) string {
	s = strings.Join(strings.FieldsFunc(s, func(r rune) bool { return r == '\n' || r == '\r' }), " ")
	s = strings.ReplaceAll(s, "|", "\\|")
	return trimRunes(s, 200)
}

// mdText 独立成段的文字:不转义 Markdown 语法(评审意见里写个星号是有意的),只限长
func mdText(s string, max int) string {
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}
	return trimRunes(strings.TrimSpace(s), max)
}

func mdTable(header []string, rows [][]string) string {
	var b strings.Builder
	b.WriteString("| " + strings.Join(header, " | ") + " |\n")
	b.WriteString("|" + strings.Repeat(" --- |", len(header)) + "\n")
	for _, row := range rows {
		b.WriteString("| " + strings.Join(row, " | ") + " |\n")
	}
	return b.String()
}

func localTime(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Local().Format("2006-01-02 15:04")
}

func stageNameOfView(v *ProjectView, seq int) string {
	for _, st := range v.Stages {
		if st.Seq == seq {
			return st.Name
		}
	}
	return "未知阶段"
}

// renderProjectMarkdown 把项目数据渲染成人能直接读的报告
func renderProjectMarkdown(ex *projectExport) string {
	p := ex.Project
	var b strings.Builder
	fmt.Fprintf(&b, "# 项目报告：%s\n\n", p.Name)
	fmt.Fprintf(&b, "> 由 ReForge 导出于 %s。\n\n", ex.GeneratedAt.Local().Format("2006年1月2日 15:04"))

	// 基本信息
	pms, members := []string{}, []string{}
	roleOf := map[string]string{}
	for _, m := range p.Members {
		roleOf[m.UserID] = m.Role
	}
	names := make([]*MemberView, 0, len(p.Members))
	// 去重(同一人可能身兼数个角色)
	seen := map[string]bool{}
	for i := range p.Members {
		m := p.Members[i]
		if seen[m.UserID] {
			continue
		}
		seen[m.UserID] = true
		roles := []string{}
		for _, x := range p.Members {
			if x.UserID == m.UserID {
				roles = append(roles, label(projectRoleLabel, x.Role))
			}
		}
		sort.Strings(roles)
		names = append(names, &MemberView{UserID: m.UserID, DisplayName: m.DisplayName, Role: strings.Join(roles, " / ")})
	}
	sort.SliceStable(names, func(i, j int) bool { return names[i].DisplayName < names[j].DisplayName })
	for _, m := range names {
		members = append(members, m.DisplayName+"（"+m.Role+"）")
		if roleOf[m.UserID] == RolePM {
			pms = append(pms, m.DisplayName)
		}
	}
	status := label(projStatusLabel, p.Status)
	if p.PendingOn != "" {
		status += "，" + label(pendingOnLabel, p.PendingOn)
	}
	completedOn := ""
	if p.CompletedAt != nil {
		completedOn = p.CompletedAt.Local().Format("2006-01-02")
	}
	b.WriteString("## 基本信息\n\n")
	b.WriteString(mdTable([]string{"项目", "内容"}, [][]string{
		{"申报人", mdCell(p.Applicant)},
		{"状态", status},
		{"当前阶段", mdCell(stageNameOfView(p, p.CurrentStage))},
		{"优先级 / 改造价值 / 复杂度", label(priorityLabel, p.Priority) + " / " + orDash(p.Value) + " / " + orDash(p.Complexity)},
		{"健康度", label(healthLabel, p.Health)},
		{"PM", orDash(strings.Join(pms, "、"))},
		{"项目成员", orDash(strings.Join(members, "、"))},
		{"目标完成日", orDash(p.DueDate)},
		{"建立 / 完成", p.CreatedAt.Local().Format("2006-01-02") + " / " + orDash(completedOn)},
		{"工作项", fmt.Sprintf("共 %d 项，完成 %d，逾期 %d，阻塞 %d", p.Stats.Total, p.Stats.Done, p.Stats.Overdue, p.Stats.Blocked)},
		{"未完成的必交付物", orDash(strings.Join(p.Stats.Missing, "、"))},
	}))
	b.WriteString("\n")

	// 阶段与关卡
	b.WriteString("## 阶段与关卡\n\n")
	stageRows := [][]string{}
	for _, st := range p.Stages {
		gate, rule := "—", "—"
		if st.Gate != "" {
			gate = st.Gate
			rule = label(modeLabel, st.Mode) + " · " + label(reviewerRoleLabel, st.ReviewerRole)
		}
		end := localTime(st.ExitedAt)
		if st.Rounds > 0 {
			end = orDash(end) + fmt.Sprintf("（第 %d 轮通过）", st.Rounds)
		}
		stageRows = append(stageRows, []string{itoa(st.Seq), mdCell(st.Name), gate, rule, label(stageStatusLabel, st.Status),
			localTime(st.EnteredAt), end, orDash(st.DueDate)})
	}
	b.WriteString(mdTable([]string{"序号", "阶段", "出口关卡", "评审规则", "状态", "进入时间", "通过时间", "截止日"}, stageRows))
	b.WriteString("\n")

	// 评审记录
	if len(ex.Reviews) > 0 {
		b.WriteString("## 评审记录\n\n")
		for _, rv := range ex.Reviews {
			stage := stageNameOfView(p, rv.StageSeq)
			gate := ""
			for _, st := range p.Stages {
				if st.Seq == rv.StageSeq {
					gate = st.Gate
				}
			}
			fmt.Fprintf(&b, "### %s · %s · 第 %d 轮 —— %s\n\n", gate, stage, rv.Round, label(reviewStatusLabel, rv.Status))
			fmt.Fprintf(&b, "- 提交人：%s，提交时间：%s\n", mdCell(rv.SubmittedByName), rv.SubmittedAt.Local().Format("2006-01-02 15:04"))
			if rv.DecidedAt != nil {
				fmt.Fprintf(&b, "- 定论时间：%s\n", rv.DecidedAt.Local().Format("2006-01-02 15:04"))
			}
			if s := mdText(rv.Summary, 2000); s != "" {
				fmt.Fprintf(&b, "- 提交说明：%s\n", strings.ReplaceAll(s, "\n", " "))
			}
			b.WriteString("\n")
			votes := [][]string{}
			for _, g := range rv.Reviewers {
				decision := label(decisionLabel, g.Decision)
				if g.Decision == DecisionPending && rv.Status != ReviewPending {
					// 或签由首位表决人定论,其余人没投;会签被驳回后也会留下未投的票
					decision = "未表决"
				}
				votes = append(votes, []string{mdCell(g.DisplayName), decision, localTime(g.DecidedAt), mdCell(g.Comment)})
			}
			if len(votes) > 0 {
				b.WriteString(mdTable([]string{"评审人", "表决", "时间", "意见"}, votes))
			}
			b.WriteString("\n")
		}
	}

	// 工作项
	b.WriteString("## 工作项\n\n")
	if len(ex.Items) == 0 {
		b.WriteString("（暂无工作项）\n\n")
	} else {
		byID := map[string]*WorkItem{}
		children := map[string][]*WorkItem{}
		for _, it := range ex.Items {
			byID[it.ID] = it
		}
		roots := []*WorkItem{}
		for _, it := range ex.Items {
			if it.ParentID != "" {
				children[it.ParentID] = append(children[it.ParentID], it)
			} else {
				roots = append(roots, it)
			}
		}
		rows := [][]string{}
		var add func(it *WorkItem, prefix string)
		add = func(it *WorkItem, prefix string) {
			mark := ""
			if it.Required {
				mark = " ★必交付"
			}
			note := ""
			if it.Status == ItemBlocked && it.BlockReason != "" {
				note = "（阻塞原因：" + mdCell(it.BlockReason) + "）"
			}
			stage := "—"
			if it.StageSeq > 0 {
				stage = stageNameOfView(p, it.StageSeq)
			}
			overdue := ""
			if it.DueDate != "" && it.Status != ItemDone && it.Status != ItemCancelled && it.DueDate < time.Now().Format("2006-01-02") {
				overdue = "（已逾期）"
			}
			rows = append(rows, []string{prefix + mdCell(it.Title) + mark, stage, label(itemTypeLabel, it.Type), itemStatusLabel(it.Status),
				orDash(it.AssigneeDisplay), orDash(it.DueDate) + overdue + note})
			for _, c := range children[it.ID] {
				add(c, prefix+"　└ ")
			}
		}
		for _, it := range roots {
			add(it, "")
		}
		b.WriteString(mdTable([]string{"工作项", "阶段", "类型", "状态", "负责人", "截止日"}, rows))
		b.WriteString("\n★ 为必交付物：未完成不能提交该阶段的评审。\n\n")
	}

	// 项目简报
	updates := []*Comment{}
	for _, c := range ex.Comments {
		if c.Kind == "update" {
			updates = append(updates, c)
		}
	}
	// 简报本身不存健康度(健康度记在项目上):从同一时刻的 project_update 事件里取当时标注的值
	healthAt := map[string]string{}
	for _, ev := range ex.Events {
		if ev.Kind != "project_update" {
			continue
		}
		var d struct {
			Health string `json:"health"`
		}
		if json.Unmarshal(ev.Detail, &d) == nil && d.Health != "" {
			healthAt[ev.TargetID] = label(healthLabel, d.Health)
		}
	}
	b.WriteString("## 项目简报\n\n")
	if len(updates) == 0 {
		b.WriteString("（暂无简报）\n\n")
	} else {
		for i := len(updates) - 1; i >= 0; i-- {
			c := updates[i]
			var st struct {
				Progress, Next, Risks, Help string
			}
			_ = json.Unmarshal(c.Structured, &st)
			fmt.Fprintf(&b, "### %s · %s · 健康度：%s\n\n", c.CreatedAt.Local().Format("2006-01-02"), mdCell(c.AuthorDisplay), orDash(healthAt[c.ID]))
			for _, x := range []struct{ name, text string }{
				{"进展", st.Progress}, {"下一步", st.Next}, {"风险与问题", st.Risks}, {"需要的支持", st.Help},
			} {
				if s := mdText(x.text, 2000); s != "" {
					fmt.Fprintf(&b, "- **%s**：%s\n", x.name, strings.ReplaceAll(s, "\n", " "))
				}
			}
			b.WriteString("\n")
		}
	}

	// 流程改善指标
	b.WriteString("## 流程改善指标\n\n")
	asIs := (*ProcessVersion)(nil)
	for _, v := range ex.Versions {
		if v.Kind == "as_is" {
			asIs = v
			break
		}
	}
	var base FlowMetrics
	if asIs != nil {
		_ = json.Unmarshal(asIs.Metrics, &base)
	}
	cur := p.Metrics
	rows := [][]string{}
	for _, m := range []struct {
		name, hint string
		a, b       int
		percent    bool // 比例类指标以千分数存储
	}{
		{"步骤数", "主步骤 + 会签内部子步骤", base.Steps, cur.Steps, false},
		{"线下步骤占比", "线下步骤 / 全部步骤", int(base.OfflineShare * 1000), int(cur.OfflineShare * 1000), true},
		{"断点数", "线上↔线下衔接 + 相邻线上步骤系统不互通", base.Breakpoints, cur.Breakpoints, false},
		{"涉及系统数", "去重后的线上系统", base.Systems, cur.Systems, false},
		{"移动端支持率", "支持移动端的线上步骤 / 全部线上步骤", int(base.MobileShare * 1000), int(cur.MobileShare * 1000), true},
		{"会签数", "会签步骤个数", base.Countersigns, cur.Countersigns, false},
	} {
		unit, disp := "", func(n int) int { return n }
		if m.percent {
			unit, disp = "%", func(n int) int { return (n + 5) / 10 }
		}
		a, b := disp(m.a), disp(m.b)
		change := "—"
		if asIs != nil && a != b {
			change = fmt.Sprintf("%+d%s", b-a, unit)
		}
		rows = append(rows, []string{m.name, m.hint, orDash2(asIs != nil, itoa(a)+unit), itoa(b) + unit, change})
	}
	b.WriteString(mdTable([]string{"指标", "口径", "立项时（As-Is）", "当前（To-Be）", "变化"}, rows))
	if len(ex.Versions) > 0 {
		vrows := [][]string{}
		for _, v := range ex.Versions {
			vrows = append(vrows, []string{"v" + itoa(v.Version), label(versionKindLabel, v.Kind), v.CreatedAt.Local().Format("2006-01-02 15:04"), mdCell(v.Note)})
		}
		b.WriteString("\n版本快照：\n\n")
		b.WriteString(mdTable([]string{"版本", "类型", "时间", "说明"}, vrows))
	}
	b.WriteString("\n")

	// 时间线
	b.WriteString("## 时间线\n\n")
	if len(ex.Events) == 0 {
		b.WriteString("（暂无动态）\n\n")
	} else {
		rows := [][]string{}
		for i := len(ex.Events) - 1; i >= 0; i-- {
			e := ex.Events[i]
			actor := e.ActorName
			if actor == "" {
				actor = "系统"
			}
			rows = append(rows, []string{e.CreatedAt.Local().Format("2006-01-02 15:04"), mdCell(actor), mdCell(label(eventKindLabel, e.Kind)), mdCell(describeEvent(ex, e))})
		}
		b.WriteString(mdTable([]string{"时间", "操作人", "动作", "详情"}, rows))
	}
	return b.String()
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func orDash2(ok bool, s string) string {
	if !ok {
		return "—"
	}
	return s
}

// describeEvent 事件的时间线说明:按类型挑出有信息量的字段
func describeEvent(ex *projectExport, e Event) string {
	var d map[string]any
	_ = json.Unmarshal(e.Detail, &d)
	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := d[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	num := func(key string) int {
		if v, ok := d[key].(float64); ok {
			return int(v)
		}
		return 0
	}
	stage := func(key string) string {
		if n := num(key); n > 0 {
			return stageNameOfView(ex.Project, n)
		}
		return ""
	}
	list := func(key string) string {
		items, _ := d[key].([]any)
		names := make([]string, len(items))
		for i, x := range items {
			names[i] = fmt.Sprint(x)
		}
		return strings.Join(names, "、")
	}
	round := "第 " + itoa(num("round")) + " 轮"
	switch e.Kind {
	case "review_submitted":
		s := "关卡「" + str("gate") + "」，" + round
		if x := str("summary"); x != "" {
			s += "；说明：" + x
		}
		return s
	case "review_voted":
		return label(decisionLabel, str("decision")) + " " + str("comment")
	case "review_approved", "review_rejected":
		return "阶段「" + stage("stage") + "」" + round
	case "review_withdrawn", "review_admin_decided":
		s := round
		if x := str("decision"); x != "" {
			s += " " + label(decisionLabel, x)
		}
		return s + " " + str("comment")
	case "stage_rewound":
		return "从「" + str("from") + "」退回到「" + str("to") + "」：" + str("reason")
	case "stage_skipped":
		return "跳过「" + stage("stage") + "」：" + str("reason")
	case "member_added", "member_removed":
		return str("user") + " · " + label(projectRoleLabel, str("role"))
	case "item_created":
		return str("title") + "（" + label(itemTypeLabel, str("type")) + "）"
	case "item_status":
		s := str("title") + "：" + itemStatusLabel(str("from")) + " → " + itemStatusLabel(str("to"))
		if x := str("reason"); x != "" {
			s += "（" + x + "）"
		}
		return s
	case "item_updated":
		return str("title") + "：" + list("changes")
	case "project_updated":
		return "修改了 " + list("fields")
	case "item_split":
		return "拆分「" + str("title") + "」"
	case "item_deleted":
		return "删除「" + str("title") + "」"
	case "project_status":
		s := label(projStatusLabel, str("from")) + " → " + label(projStatusLabel, str("to"))
		if x := str("note"); x != "" {
			s += "：" + x
		}
		return s
	case "comment_added":
		return str("excerpt")
	case "project_update":
		return "健康度：" + label(healthLabel, str("previous")) + " → " + label(healthLabel, str("health")) + "；" + str("excerpt")
	case "project_created":
		if migrated, _ := d["migrated"].(bool); migrated {
			return "由存量流程迁入"
		}
		return ""
	}
	// 旧跟进体系迁入的事件等:原样列出字段
	parts := []string{}
	for k, v := range d {
		parts = append(parts, k+"="+fmt.Sprint(v))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}
