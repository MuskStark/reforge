package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---- 组合聚合:工作台与数据大屏共用 ----

type overviewTrend struct {
	Month     string `json:"month"` // YYYY-MM
	Collected int    `json:"collected"`
	Done      int    `json:"done"`
}

type overviewLoad struct {
	UserID  string `json:"userId"`
	Name    string `json:"name"`
	Active  int    `json:"active"`
	Overdue int    `json:"overdue"`
	Blocked int    `json:"blocked"`
}

type overviewNamedCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type overviewEvent struct {
	ID          int64           `json:"id"`
	ProjectID   string          `json:"projectId"`
	ProjectName string          `json:"projectName"`
	Actor       string          `json:"actor"`
	Kind        string          `json:"kind"`
	Detail      json.RawMessage `json:"detail"`
	CreatedAt   time.Time       `json:"createdAt"`
}

// overview 聚合数据。基础部分(计数、阶段分布、待评审、逾期、健康度)工作台与大屏都用,每次都算;
// 带 ?full=1 时再附加趋势、负载、来源、系统涉及度与最新动态(大屏专用)。
type overview struct {
	Collected      int                  `json:"collected"`
	MonthlyNew     int                  `json:"monthlyNew"`
	Active         int                  `json:"active"`
	OnHold         int                  `json:"onHold"`
	Cancelled      int                  `json:"cancelled"`
	Done           int                  `json:"done"`
	Following      int                  `json:"following"` // 兼容旧大屏:等于 active
	ByStage        []int                `json:"byStage"`   // 与 stageKeys / stageNames 一一对应
	StageKeys      []string             `json:"stageKeys"`
	StageNames     []string             `json:"stageNames"`
	PendingReviews int                  `json:"pendingReviews"`
	ReviewWaitDays float64              `json:"reviewWaitDays"`
	OverdueItems   int                  `json:"overdueItems"`
	BlockedItems   int                  `json:"blockedItems"`
	OverdueStages  int                  `json:"overdueStages"`
	ByHealth       map[string]int       `json:"byHealth"`
	MonthlyDone    int                  `json:"monthlyDone"`
	OnTimeRate     *float64             `json:"onTimeRate"`   // 按期完成率;没有可比数据时为 null
	AvgCycleDays   *float64             `json:"avgCycleDays"` // 已完成项目从启动到完成的平均天数;没有数据时为 null
	Trend          []overviewTrend      `json:"trend"`
	PMLoad         []overviewLoad       `json:"pmLoad"`
	DepartmentTop  []overviewNamedCount `json:"departmentTop"`
	SystemTop      []overviewNamedCount `json:"systemTop"`
	RecentEvents   []overviewEvent      `json:"recentEvents"`
}

func (s *postgresStore) handleOverview(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentActor(w, r, s); !ok {
		return
	}
	ov, err := s.buildOverview(r.Context(), r.URL.Query().Get("full") == "1")
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *postgresStore) buildOverview(ctx context.Context, full bool) (*overview, error) {
	ov := &overview{ByHealth: map[string]int{"on_track": 0, "at_risk": 0, "off_track": 0}}
	err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM processes),
		(SELECT count(*) FROM processes WHERE created_at >= date_trunc('month', now())),
		(SELECT count(*) FROM projects WHERE status = 'active'),
		(SELECT count(*) FROM projects WHERE status = 'on_hold'),
		(SELECT count(*) FROM projects WHERE status = 'cancelled'),
		(SELECT count(*) FROM projects WHERE status = 'done'),
		(SELECT count(*) FROM projects WHERE status = 'done' AND completed_at >= date_trunc('month', now()))`).
		Scan(&ov.Collected, &ov.MonthlyNew, &ov.Active, &ov.OnHold, &ov.Cancelled, &ov.Done, &ov.MonthlyDone)
	if err != nil {
		return nil, err
	}
	ov.Following = ov.Active

	if err := s.stageDistribution(ctx, ov); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT count(*), COALESCE(avg(extract(epoch FROM now() - submitted_at)) / 86400.0, 0)
		FROM gate_reviews WHERE status = 'pending'`).Scan(&ov.PendingReviews, &ov.ReviewWaitDays); err != nil {
		return nil, err
	}
	ov.ReviewWaitDays = float64(int(ov.ReviewWaitDays*10)) / 10
	// 连表后 status / due_date 两张表都有,必须带表别名
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE w.due_date IS NOT NULL AND w.due_date < CURRENT_DATE),
		count(*) FILTER (WHERE w.status = 'blocked')
		FROM work_items w JOIN projects pr ON pr.id = w.project_id
		WHERE pr.status = 'active' AND w.status IN ('todo','in_progress','blocked','in_review')`).Scan(&ov.OverdueItems, &ov.BlockedItems); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT count(*)
		FROM projects pr JOIN project_stages ps ON ps.project_id = pr.id AND ps.seq = pr.current_stage
		WHERE pr.status = 'active' AND ps.status IN ('in_progress','in_review')
		  AND ps.due_date IS NOT NULL AND ps.due_date < CURRENT_DATE`).Scan(&ov.OverdueStages); err != nil {
		return nil, err
	}
	hrows, err := s.db.QueryContext(ctx, `SELECT health, count(*) FROM projects WHERE status = 'active' GROUP BY health`)
	if err != nil {
		return nil, err
	}
	for hrows.Next() {
		var h string
		var n int
		if err := hrows.Scan(&h, &n); err != nil {
			hrows.Close()
			return nil, err
		}
		ov.ByHealth[h] = n
	}
	hrows.Close()
	if err := hrows.Err(); err != nil {
		return nil, err
	}
	if !full {
		return ov, nil
	}
	if err := s.overviewFull(ctx, ov); err != nil {
		return nil, err
	}
	return ov, nil
}

// stageDistribution 在途项目的阶段分布。各项目按自己的模板快照取阶段标识,再按当前模板的顺序排列:
// 后台改过模板(改名、增减阶段)之后,新旧项目的同一个阶段仍能落在一起。
func (s *postgresStore) stageDistribution(ctx context.Context, ov *overview) error {
	current, err := loadStageTemplates(ctx, s.db)
	if err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT pr.current_stage, pr.template FROM projects pr WHERE pr.status = 'active'`)
	if err != nil {
		return err
	}
	defer rows.Close()
	keys, names := []string{}, []string{}
	counts := map[string]int{}
	ensure := func(key, name string) {
		if _, ok := counts[key]; !ok {
			keys = append(keys, key)
			names = append(names, name)
			counts[key] = 0
		}
	}
	for _, t := range current {
		ensure(t.Key, t.Name)
	}
	for rows.Next() {
		var seq int
		var raw []byte
		if err := rows.Scan(&seq, &raw); err != nil {
			return err
		}
		key, name := fmt.Sprintf("stage_%d", seq), fmt.Sprintf("阶段 %d", seq)
		if t, ok := templateAt(parseTemplate(raw), seq); ok {
			key, name = t.Key, t.Name
		}
		ensure(key, name)
		counts[key]++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	ov.StageKeys, ov.StageNames, ov.ByStage = keys, names, make([]int, len(keys))
	for i, k := range keys {
		ov.ByStage[i] = counts[k]
	}
	return nil
}

func (s *postgresStore) overviewFull(ctx context.Context, ov *overview) error {
	// 按期完成率:有目标完成日且已完成的项目里,按期完成所占比例
	var withDue, onTime int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*),
		count(*) FILTER (WHERE pr.completed_at::date <= pr.due_date)
		FROM projects pr WHERE pr.status = 'done' AND pr.completed_at IS NOT NULL AND pr.due_date IS NOT NULL`).
		Scan(&withDue, &onTime); err != nil {
		return err
	}
	if withDue > 0 {
		v := float64(int(float64(onTime)/float64(withDue)*1000)) / 1000
		ov.OnTimeRate = &v
	}
	var cycles int
	var avg float64
	// 周期 = 启动到完成;补建 / 迁入的历史项目可能带着早于启动时间的完成时间,负时长按 0 计
	if err := s.db.QueryRowContext(ctx, `SELECT count(*), COALESCE(avg(GREATEST(0, extract(epoch FROM pr.completed_at - pr.started_at))) / 86400.0, 0)
		FROM projects pr WHERE pr.status = 'done' AND pr.completed_at IS NOT NULL AND pr.started_at IS NOT NULL`).Scan(&cycles, &avg); err != nil {
		return err
	}
	if cycles > 0 {
		avg = float64(int(avg*10)) / 10
		ov.AvgCycleDays = &avg
	}

	// 近 6 个月:每月新收集的流程数与完成的项目数
	trows, err := s.db.QueryContext(ctx, `WITH m AS (
		SELECT generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') AS start
	)
	SELECT to_char(m.start, 'YYYY-MM'),
		(SELECT count(*) FROM processes p WHERE p.created_at >= m.start AND p.created_at < m.start + interval '1 month'),
		(SELECT count(*) FROM projects pr WHERE pr.completed_at >= m.start AND pr.completed_at < m.start + interval '1 month')
	FROM m ORDER BY m.start`)
	if err != nil {
		return err
	}
	ov.Trend = []overviewTrend{}
	for trows.Next() {
		var p overviewTrend
		if err := trows.Scan(&p.Month, &p.Collected, &p.Done); err != nil {
			trows.Close()
			return err
		}
		ov.Trend = append(ov.Trend, p)
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		return err
	}

	// 项目经理负载:在办项目数,以及这些项目里逾期 / 阻塞的工作项
	lrows, err := s.db.QueryContext(ctx, `WITH pm AS (
		SELECT m.user_id, pr.id AS project_id FROM project_members m JOIN projects pr ON pr.id = m.project_id
		WHERE m.role = 'pm' AND pr.status = 'active'
	)
	SELECT pm.user_id, COALESCE(NULLIF(u.display_name, ''), u.username), count(DISTINCT pm.project_id),
		count(w.id) FILTER (WHERE w.due_date IS NOT NULL AND w.due_date < CURRENT_DATE),
		count(w.id) FILTER (WHERE w.status = 'blocked')
	FROM pm JOIN users u ON u.id = pm.user_id
	LEFT JOIN work_items w ON w.project_id = pm.project_id AND w.status IN ('todo','in_progress','blocked','in_review')
	GROUP BY pm.user_id, u.display_name, u.username
	ORDER BY 3 DESC, 2 LIMIT 8`)
	if err != nil {
		return err
	}
	ov.PMLoad = []overviewLoad{}
	for lrows.Next() {
		var x overviewLoad
		if err := lrows.Scan(&x.UserID, &x.Name, &x.Active, &x.Overdue, &x.Blocked); err != nil {
			lrows.Close()
			return err
		}
		ov.PMLoad = append(ov.PMLoad, x)
	}
	lrows.Close()
	if err := lrows.Err(); err != nil {
		return err
	}

	// 申报部门 TOP5:申报人是自由填写的姓名,按显示名 / 用户名对上用户后取其部门
	drows, err := s.db.QueryContext(ctx, `SELECT COALESCE(NULLIF(u.department, ''), '未登记部门') AS dept, count(*)
		FROM processes p
		LEFT JOIN LATERAL (
			SELECT department FROM users
			WHERE department <> '' AND (display_name = p.applicant OR username = p.applicant)
			ORDER BY created_at LIMIT 1
		) u ON true
		GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 5`)
	if err != nil {
		return err
	}
	ov.DepartmentTop = []overviewNamedCount{}
	for drows.Next() {
		var x overviewNamedCount
		if err := drows.Scan(&x.Name, &x.Count); err != nil {
			drows.Close()
			return err
		}
		ov.DepartmentTop = append(ov.DepartmentTop, x)
	}
	drows.Close()
	if err := drows.Err(); err != nil {
		return err
	}

	if ov.SystemTop, err = s.systemTop(ctx); err != nil {
		return err
	}

	// 最新动态:只取节点性事件(允许名单),细粒度动态不上墙
	erows, err := s.db.QueryContext(ctx, `SELECT e.id, e.project_id, COALESCE(pr.name, ''), e.actor_name, e.kind, e.detail, e.created_at
		FROM events e LEFT JOIN projects pr ON pr.id = e.project_id
		WHERE e.kind = ANY($1)
		ORDER BY e.created_at DESC, e.id DESC LIMIT 12`, tickerKinds)
	if err != nil {
		return err
	}
	ov.RecentEvents = []overviewEvent{}
	for erows.Next() {
		var e overviewEvent
		if err := erows.Scan(&e.ID, &e.ProjectID, &e.ProjectName, &e.Actor, &e.Kind, &e.Detail, &e.CreatedAt); err != nil {
			erows.Close()
			return err
		}
		ov.RecentEvents = append(ov.RecentEvents, e)
	}
	erows.Close()
	return erows.Err()
}

// tickerKinds 大屏"最新动态"只展示这些节点性事件。用允许名单而不是排除名单:
// 逐票表决、逐条建任务、评论这类细粒度动态不上墙,以后新增的事件类型也不会意外漏上来。
var tickerKinds = []string{
	"project_created", "review_submitted", "review_approved", "review_rejected", "review_withdrawn", "review_admin_decided",
	"stage_rewound", "stage_skipped", "project_status",
}

// systemTopCache 线上系统涉及度要读全部流程定义,是大屏里最重的一项;缓存 30 秒(大屏自己也是 30 秒刷一次)
var systemTopCache struct {
	sync.Mutex
	at   time.Time
	data []overviewNamedCount
}

func (s *postgresStore) systemTop(ctx context.Context) ([]overviewNamedCount, error) {
	systemTopCache.Lock()
	if systemTopCache.data != nil && time.Since(systemTopCache.at) < 30*time.Second {
		data := systemTopCache.data
		systemTopCache.Unlock()
		return data, nil
	}
	systemTopCache.Unlock()

	procs, err := s.List()
	if err != nil {
		return nil, err
	}
	counts := map[string]int{}
	for _, p := range procs {
		seen := map[string]bool{}
		for _, name := range processSystems(p) {
			if !seen[name] {
				seen[name] = true
				counts[name]++
			}
		}
	}
	out := topNamedCounts(counts, 8)
	systemTopCache.Lock()
	systemTopCache.at, systemTopCache.data = time.Now(), out
	systemTopCache.Unlock()
	return out, nil
}

// processSystems 一条流程里线上步骤引用的系统(去重;口径与流程改善指标的"涉及系统数"一致)
func processSystems(p *Process) []string {
	var out []string
	seen := map[string]bool{}
	add := func(name string) {
		if n := strings.TrimSpace(name); n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, st := range p.Steps {
		if st.Countersign {
			for _, pt := range st.Parties {
				for _, sub := range pt.SubSteps {
					if strings.TrimSpace(sub.Name) != "" && subOnline(sub) {
						add(sub.Online.SystemName)
					}
				}
			}
			continue
		}
		if stepMode(st) == "online" {
			add(st.Online.SystemName)
		}
	}
	return out
}

// topNamedCounts 按数量从多到少(同数按名称)取前 n 项
func topNamedCounts(counts map[string]int, n int) []overviewNamedCount {
	out := make([]overviewNamedCount, 0, len(counts))
	for k, v := range counts {
		out = append(out, overviewNamedCount{Name: k, Count: v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}
