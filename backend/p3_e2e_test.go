package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- P3:阶段模板后台配置、外部通知渠道、导出、删除流程 ----

// raw 发 GET 并返回原始响应(导出件不是 JSON)
func (e *env) raw(token, path string) (int, http.Header, string) {
	e.t.Helper()
	r, _ := http.NewRequest("GET", e.srv.URL+path, nil)
	r.Header.Set("Authorization", "Bearer "+token)
	res, err := e.srv.Client().Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	body := make([]byte, 0, 4096)
	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
	}
	return res.StatusCode, res.Header, string(body)
}

func (e *env) projectByName(token, name string) string {
	e.t.Helper()
	_, projects := e.list(token, "/api/projects")
	for _, raw := range projects {
		if p := raw.(map[string]any); p["name"] == name {
			return p["id"].(string)
		}
	}
	e.t.Fatalf("找不到项目「%s」", name)
	return ""
}

func TestStageTemplateConfig(t *testing.T) {
	e := newTestEnv(t)
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	cto1, _ := e.createUser(admin, "张技术", RoleCTO)
	cto2, _ := e.createUser(admin, "钱技术", RoleCTO)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	h1, h1ID := e.createUser(admin, "王经办", RoleHandler)

	// 首次启动已把内置模板写进配置表
	tpl := e.mustArray(admin, "GET", "/api/admin/stage-templates", nil)
	if len(tpl) != 7 || dig(tpl[2], "key") != keyDesign || dig(tpl[5], "key") != keyAccept || dig(tpl[1], "name") != "需求确认" {
		t.Fatalf("内置模板不符: %+v", tpl)
	}
	e.fail(pm, "GET", "/api/admin/stage-templates", nil, 403, "管理员")
	e.fail(cto1, "PUT", "/api/admin/stage-templates", map[string]any{"templates": tpl}, 403, "管理员")

	// 改模板之前先立一个项目:它应当一直按内置模板走
	e.must("", "POST", "/api/processes", processPayload("旧流程"))
	pidA := e.projectByName(admin, "旧流程")
	e.must(admin, "PUT", "/api/projects/"+pidA+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	e.must(admin, "PUT", "/api/projects/"+pidA+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"})

	// 校验:关卡必须配评审人与表决方式;模板不能为空
	noReviewer := append([]any{}, tpl...)
	first := map[string]any{}
	for k, v := range noReviewer[0].(map[string]any) {
		first[k] = v
	}
	first["reviewerRole"] = ""
	noReviewer[0] = first
	e.fail(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": noReviewer}, 400, "评审人")
	e.fail(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": []any{}}, 400, "1–")
	_, afterBad := e.list(admin, "/api/admin/stage-templates")
	if len(afterBad) != 7 {
		t.Fatalf("校验失败不应改动已保存的模板,得到 %d 个阶段", len(afterBad))
	}

	// 改模板:阶段 2 改名并换成 CTO 或签;阶段 1 改成会签;末尾加一个带关卡的阶段
	next := []any{}
	for i, raw := range tpl {
		x := map[string]any{}
		for k, v := range raw.(map[string]any) {
			x[k] = v
		}
		switch i {
		case 0:
			x["mode"] = ModeAll
		case 1:
			x["name"], x["reviewerRole"], x["mode"] = "需求评审", RoleCTO, ModeAny
		}
		next = append(next, x)
	}
	next = append(next, map[string]any{"name": "推广复制", "gate": "G7 推广评审", "reviewerRole": RoleHandler, "mode": ModeAny,
		"required": []string{"推广计划", "推广计划"}, "tasks": []string{"选点", "推广计划"}})
	saved := e.mustArray(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": next})
	if len(saved) != 7+1 {
		t.Fatalf("保存后应有 8 个阶段: %+v", saved)
	}
	last := saved[7].(map[string]any)
	if last["seq"] != float64(8) || last["key"] == "" || len(last["required"].([]any)) != 1 || len(last["tasks"].([]any)) != 1 {
		t.Fatalf("新增阶段应自动编号、去重,且与必交付物重名的任务只留必交付物: %+v", last)
	}

	// 已立项的项目 A 不受影响:阶段名、数量、规则都还是立项时的
	a := e.project(pm, pidA)
	if len(a["stages"].([]any)) != 7 || dig(a, "stages", "1", "name") != "需求确认" || dig(a, "stages", "0", "mode") != ModeAny {
		t.Fatalf("已立项项目不应随模板变化: %+v", a["stages"])
	}
	e.completeRequired(pm, pidA, 1)
	e.must(pm, "PATCH", "/api/projects/"+pidA, map[string]any{"value": "高", "complexity": "中"})
	_, rvA := e.submit(pm, pidA, "旧项目立项")
	got(t, rvA, "mode", ModeAny) // A 的 G1 仍是或签
	got(t, e.must(cto1, "POST", "/api/reviews/"+rvA["id"].(string)+"/decide", map[string]any{"decision": "approve"}), "status", ReviewApproved)
	got(t, e.project(pm, pidA), "currentStage", float64(2))
	// A 的 G2 仍是经办会签
	e.completeRequired(pm, pidA, 2)
	_, rvA2 := e.submit(pm, pidA, "需求确认")
	got(t, rvA2, "reviewerRole", RoleHandler)
	got(t, rvA2, "mode", ModeAll)
	e.must(h1, "POST", "/api/reviews/"+rvA2["id"].(string)+"/decide", map[string]any{"decision": "approve"})
	// 新模板多出来的阶段对 A 不存在
	e.fail(pm, "POST", "/api/projects/"+pidA+"/items", map[string]any{"title": "推广", "stageSeq": 8}, 400, "阶段")
	oldItem := e.must(pm, "POST", "/api/projects/"+pidA+"/items", map[string]any{"title": "旧项目的任务", "stageSeq": 2})
	e.fail(pm, "PATCH", "/api/items/"+oldItem["id"].(string), map[string]any{"stageSeq": 8}, 400, "阶段")
	e.fail(pm, "POST", "/api/projects/"+pidA+"/stages/8/enter", map[string]any{"reason": "x"}, 400, "之前")
	e.fail(pm, "POST", "/api/projects/"+pidA+"/stages/99/enter", map[string]any{"reason": "x"}, 400, "序号")
	if _, p := e.list(cto1, "/api/reviews/pending"); len(p) != 0 {
		t.Fatalf("A 的 G2 是经办关卡,CTO 不应看到待评审: %+v", p)
	}

	// 改模板之后提交的流程按新模板立项
	e.must("", "POST", "/api/processes", processPayload("新流程"))
	pidB := e.projectByName(admin, "新流程")
	e.must(admin, "PUT", "/api/projects/"+pidB+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	e.must(admin, "PUT", "/api/projects/"+pidB+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"})
	b := e.project(pm, pidB)
	if len(b["stages"].([]any)) != 8 {
		t.Fatalf("新项目应有 8 个阶段: %+v", b["stages"])
	}
	got(t, b, "stages", "0", "mode", ModeAll)
	got(t, b, "stages", "1", "name", "需求评审")
	got(t, b, "stages", "1", "reviewerRole", RoleCTO)
	got(t, b, "stages", "1", "mode", ModeAny)
	got(t, b, "stages", "7", "gate", "G7 推广评审")
	got(t, b, "stages", "7", "reviewerRole", RoleHandler)
	// 新模板的必交付物与默认任务成为工作项
	_, items := e.list(pm, "/api/projects/"+pidB+"/items")
	var sawRequired, sawTask bool
	for _, raw := range items {
		it := raw.(map[string]any)
		if dig(it, "stageSeq") == float64(8) && it["title"] == "推广计划" && it["required"] == true && it["type"] == ItemDeliverable {
			sawRequired = true
		}
		if dig(it, "stageSeq") == float64(8) && it["title"] == "选点" {
			sawTask = true
		}
	}
	if !sawRequired || !sawTask {
		t.Fatalf("新阶段的必交付物与默认任务应生成工作项: %+v", items)
	}
	// B 的 G1 是会签:两位 CTO 都要通过
	e.completeRequired(pm, pidB, 1)
	e.must(pm, "PATCH", "/api/projects/"+pidB, map[string]any{"value": "中", "complexity": "低"})
	_, rvB := e.submit(pm, pidB, "新项目立项")
	got(t, rvB, "mode", ModeAll)
	rid := rvB["id"].(string)
	got(t, e.must(cto1, "POST", "/api/reviews/"+rid+"/decide", map[string]any{"decision": "approve"}), "status", ReviewPending)
	got(t, e.must(cto2, "POST", "/api/reviews/"+rid+"/decide", map[string]any{"decision": "approve"}), "status", ReviewApproved)
	// B 的阶段 2 现在是 CTO 或签:经办已不能表决,一位 CTO 即可
	e.completeRequired(pm, pidB, 2)
	_, rvB2 := e.submit(pm, pidB, "需求评审")
	got(t, rvB2, "reviewerRole", RoleCTO)
	got(t, rvB2, "mode", ModeAny)
	e.fail(h1, "POST", "/api/reviews/"+rvB2["id"].(string)+"/decide", map[string]any{"decision": "approve"}, 403, "权限")
	if _, p := e.list(cto2, "/api/reviews/pending"); len(p) != 1 {
		t.Fatalf("CTO 应看到 B 的待评审: %+v", p)
	}
	got(t, e.must(cto2, "POST", "/api/reviews/"+rvB2["id"].(string)+"/decide", map[string]any{"decision": "approve"}), "status", ReviewApproved)
	// 工作项可以挂到 B 的第 8 个阶段
	e.must(pm, "POST", "/api/projects/"+pidB+"/items", map[string]any{"title": "推广", "stageSeq": 8})

	// 大屏的阶段分布:新旧项目的同一阶段(key 相同)落在一起,名称与顺序取当前模板
	ov := e.must(admin, "GET", "/api/overview?full=1", nil)
	names := ov["stageNames"].([]any)
	// 此时新旧两个项目都已通过各自的 G2,停在阶段 3
	if len(ov["byStage"].([]any)) != 8 || names[1] != "需求评审" || dig(ov, "byStage", "2") != float64(2) || names[7] != "推广复制" {
		t.Fatalf("阶段分布不符: %v %v", ov["byStage"], names)
	}
	// 最新动态只上节点性事件:刚才建过工作项、投过票,这些都不该出现在大屏上
	allowed := map[string]bool{}
	for _, k := range tickerKinds {
		allowed[k] = true
	}
	events := ov["recentEvents"].([]any)
	if len(events) == 0 {
		t.Fatal("扩展聚合应带最新动态")
	}
	for _, raw := range events {
		if kind := dig(raw, "kind"); !allowed[kind.(string)] {
			t.Errorf("大屏最新动态不应包含细粒度事件 %q", kind)
		}
	}
	// 趋势、负载、来源、系统这些扩展维度都要有;还没有已完成项目,按期率与平均周期应为 null
	// (申报人是自由填写的"孙申报",对不上用户,部门归到"未登记部门")
	if len(ov["trend"].([]any)) != 6 || len(ov["pmLoad"].([]any)) != 1 || dig(ov, "pmLoad", "0", "name") != "李经理" ||
		len(ov["departmentTop"].([]any)) != 1 || dig(ov, "departmentTop", "0", "name") != "未登记部门" ||
		len(ov["systemTop"].([]any)) != 3 || dig(ov, "systemTop", "0", "name") != "OA" || dig(ov, "onTimeRate") != nil || dig(ov, "avgCycleDays") != nil {
		t.Fatalf("扩展维度不符: 趋势 %+v 负载 %+v 部门 %+v 系统 %+v 按期 %v 周期 %v", ov["trend"], ov["pmLoad"], ov["departmentTop"], ov["systemTop"], ov["onTimeRate"], ov["avgCycleDays"])
	}
	if p := dig(ov, "pmLoad", "0"); dig(p, "active") != float64(2) || dig(p, "overdue") != float64(0) || dig(p, "blocked") != float64(0) {
		t.Fatalf("项目经理负载不符: %+v", p)
	}
	// 基础接口不带扩展维度
	basic := e.must(pm, "GET", "/api/overview", nil)
	if basic["trend"] != nil || basic["pmLoad"] != nil || len(basic["byStage"].([]any)) != 8 {
		t.Fatalf("基础聚合不应带扩展维度: %+v", basic)
	}

	// "重启"后模板仍在;重启后新建的项目继续按新模板
	st2, err := newStore(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("重新连接失败: %v", err)
	}
	defer st2.Close()
	again, err := loadStageTemplates(context.Background(), st2.db)
	if err != nil || len(again) != 8 || again[1].Name != "需求评审" || again[0].Mode != ModeAll {
		t.Fatalf("重启后模板应保持: %v %+v", err, again)
	}
	e.must("", "POST", "/api/processes", processPayload("重启后的流程"))
	pidC := e.projectByName(admin, "重启后的流程")
	if len(dig(e.project(admin, pidC), "stages").([]any)) != 8 {
		t.Fatal("重启后新建的项目应按保存的模板立项")
	}

	// 恢复内置模板,不影响后续用例的假设
	built := []any{}
	for _, x := range defaultStageTemplates() {
		built = append(built, x)
	}
	e.must(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": built})
	if n := e.completeRequired(pm, pidB, 8); n != 1 {
		t.Fatalf("模板恢复后,B 仍按自己的快照有第 8 阶段的必交付物,得到 %d", n)
	}
}

func TestNotifyChannelsDelivery(t *testing.T) {
	e := newTestEnv(t)
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	cto1, _ := e.createUser(admin, "张技术", RoleCTO)
	cto2, _ := e.createUser(admin, "钱技术", RoleCTO)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	h1, h1ID := e.createUser(admin, "王经办", RoleHandler)
	if _, p := e.list(cto2, "/api/projects"); len(p) != 0 {
		t.Fatal("此时不应有项目")
	}

	// 假群机器人:记下收到的正文,可切换为故障
	var mu sync.Mutex
	sent := []string{}
	broken := false
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text struct{ Content string } `json:"text"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		defer mu.Unlock()
		if broken {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		sent = append(sent, body.Text.Content)
		_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
	}))
	defer bot.Close()
	inbox := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, sent...)
	}
	deliver := func() {
		e.t.Helper()
		if err := deliverChannels(context.Background(), e.st); err != nil {
			e.t.Fatalf("转发失败: %v", err)
		}
	}
	path := "/api/admin/notify-channels"

	// 只有系统管理员能配置
	e.fail(pm, "GET", path, nil, 403, "管理员")
	e.fail(pm, "POST", path, map[string]any{"name": "x", "kind": ChWecom, "webhook": bot.URL}, 403, "管理员")
	if len(inbox()) != 0 {
		t.Fatal("没有渠道时不应发送")
	}

	// 校验
	e.fail(admin, "POST", path, map[string]any{"kind": ChWecom, "webhook": bot.URL}, 400, "名称")
	e.fail(admin, "POST", path, map[string]any{"name": "群", "kind": ChWecom}, 400, "Webhook")
	e.fail(admin, "POST", path, map[string]any{"name": "群", "kind": ChWecom, "webhook": "javascript:alert(1)"}, 400, "Webhook")
	e.fail(admin, "POST", path, map[string]any{"name": "群", "kind": ChEmail, "webhook": bot.URL}, 400, "邮件服务器")
	e.fail(admin, "POST", path, map[string]any{"name": "群", "kind": ChWecom, "webhook": bot.URL, "kinds": []string{"nope"}}, 400, "通知类型")

	// 新建:不传转发范围 → 默认集合;凭据脱敏返回
	ch := e.must(admin, "POST", path, map[string]any{"name": "管理群", "kind": ChWecom,
		"webhook": bot.URL + "/cgi-bin/webhook/send?key=top-secret", "secret": "s3cret"})
	cid := ch["id"].(string)
	if len(ch["kinds"].([]any)) != len(defaultChannelKinds) || ch["enabled"] != true {
		t.Fatalf("新渠道的默认值不符: %+v", ch)
	}
	if ch["webhook"] != bot.URL+"/cgi-bin/webhook/send?key=****" || ch["secretSet"] != true || ch["secret"] != nil {
		t.Fatalf("凭据应脱敏: %+v", ch)
	}
	// 修改时把脱敏地址传回来 = 不改;真实地址仍在库里
	up := e.must(admin, "PATCH", path+"/"+cid, map[string]any{"name": "管理群 2", "webhook": ch["webhook"]})
	if up["name"] != "管理群 2" || !strings.Contains(up["webhook"].(string), "key=****") {
		t.Fatalf("修改结果不符: %+v", up)
	}
	var stored string
	if err := e.st.db.QueryRow(`SELECT webhook FROM notify_channels WHERE id = $1`, cid).Scan(&stored); err != nil || !strings.Contains(stored, "top-secret") {
		t.Fatalf("真实 Webhook 应保留在库里: %q %v", stored, err)
	}
	ls := e.must(admin, "GET", path, nil)
	if dig(ls, "list", "0", "id") != cid || len(ls["kinds"].([]any)) == 0 {
		t.Fatalf("渠道列表不符: %+v", ls)
	}
	// 测试消息:同步返回结果
	if res := e.must(admin, "POST", path+"/"+cid+"/test", nil); res["ok"] != true {
		t.Fatalf("测试消息应成功: %+v", res)
	}
	if n := len(inbox()); n != 1 || !strings.Contains(inbox()[0], "测试消息") {
		t.Fatalf("应收到 1 条测试消息,得到 %d 条: %v", n, inbox())
	}
	e.fail(admin, "POST", path+"/nope/test", nil, 404, "不存在")
	e.fail(admin, "PATCH", path+"/nope", map[string]any{"name": "x"}, 404, "不存在")

	// 提交流程 → 管理员的"新流程"通知被转发
	e.must("", "POST", "/api/processes", processPayload("报销流程"))
	pid := e.projectByName(admin, "报销流程")
	deliver()
	if got := inbox(); len(got) != 2 || !strings.Contains(got[1], "新流程「报销流程」已提交") {
		t.Fatalf("新流程通知应转发到群: %v", got)
	}
	// 幂等:同一件事不再发第二遍
	deliver()
	if len(inbox()) != 2 {
		t.Fatalf("重复执行不应重复发送: %v", inbox())
	}
	// 个人向的通知默认不进群
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"})
	e.must(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": "补齐票据", "assigneeId": h1ID})
	deliver()
	if len(inbox()) != 2 {
		t.Fatalf("任务指派默认不应进群: %v", inbox())
	}
	// 勾上之后,此后新产生的指派通知才转发(不回放改范围之前的)
	e.must(admin, "PATCH", path+"/"+cid, map[string]any{"kinds": append(append([]string{}, defaultChannelKinds...), "item_assigned")})
	time.Sleep(5 * time.Millisecond)
	e.must(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": "核对发票", "assigneeId": h1ID})
	deliver()
	if got := inbox(); len(got) != 3 || !strings.Contains(got[2], "核对发票") || strings.Contains(got[2], "补齐票据") {
		t.Fatalf("新范围内的指派通知应转发,旧的不回放: %v", got)
	}

	// 同一件事通知了两个人,群里只出现一行
	e.completeRequired(pm, pid, 1)
	e.must(pm, "PATCH", "/api/projects/"+pid, map[string]any{"value": "中", "complexity": "低"})
	e.submit(pm, pid, "请立项")
	deliver()
	got := inbox()
	if len(got) != 4 || strings.Count(got[3], "提交了 G1 立项评审") != 1 || !strings.Contains(got[3], "报销流程") {
		t.Fatalf("发给两位 CTO 的同一通知在群里应只有一行: %v", got)
	}
	// 停用渠道后不再转发
	e.must(admin, "PATCH", path+"/"+cid, map[string]any{"enabled": false})
	e.must(cto1, "POST", "/api/reviews/"+lastReviewID(e, pm, pid)+"/decide", map[string]any{"decision": "approve"})
	deliver()
	if len(inbox()) != 4 {
		t.Fatalf("停用的渠道不应发送: %v", inbox())
	}
	// 发送失败:记下错误并安排重试;没到重试时间不再发
	e.must(admin, "PATCH", path+"/"+cid, map[string]any{"enabled": true})
	time.Sleep(5 * time.Millisecond)
	e.completeRequired(pm, pid, 2)
	e.submit(pm, pid, "需求已核对")
	mu.Lock()
	broken = true
	mu.Unlock()
	deliver()
	if len(inbox()) != 4 {
		t.Fatalf("机器人故障时不应有消息送达: %v", inbox())
	}
	var attempts int
	var next sql.NullTime
	var lastError string
	if err := e.st.db.QueryRow(`SELECT attempts, next_attempt_at, last_error FROM notify_deliveries
		WHERE channel_id = $1 AND title LIKE '%提交了 G2%'`, cid).Scan(&attempts, &next, &lastError); err != nil {
		t.Fatalf("失败的投递应留下记录: %v", err)
	}
	if attempts != 1 || !next.Valid || !next.Time.After(time.Now()) || !strings.Contains(lastError, "发送失败") {
		t.Fatalf("失败记录不符: attempts=%d next=%v err=%q", attempts, next, lastError)
	}
	ch = dig(e.must(admin, "GET", path, nil), "list", "0").(map[string]any)
	if !strings.Contains(ch["lastError"].(string), "发送失败") {
		t.Fatalf("渠道上应显示最近一次错误: %+v", ch)
	}
	mu.Lock()
	broken = false
	mu.Unlock()
	deliver()
	if len(inbox()) != 4 {
		t.Fatalf("没到重试时间不应重发: %v", inbox())
	}
	// 到了重试时间:恢复后补发,错误清零
	if _, err := e.st.db.Exec(`UPDATE notify_deliveries SET next_attempt_at = now() - interval '1 minute' WHERE channel_id = $1`, cid); err != nil {
		t.Fatal(err)
	}
	deliver()
	if got := inbox(); len(got) != 5 || !strings.Contains(got[4], "提交了 G2") {
		t.Fatalf("到时间后应补发: %v", got)
	}
	ch = dig(e.must(admin, "GET", path, nil), "list", "0").(map[string]any)
	if ch["lastError"] != "" || ch["lastSentAt"] == nil {
		t.Fatalf("补发成功后应清掉错误并记录发送时间: %+v", ch)
	}

	// 重试用完即放弃:不再发,也不再排期
	mu.Lock()
	broken = true
	mu.Unlock()
	if _, err := e.st.db.Exec(`UPDATE notify_deliveries SET sent_at = NULL, attempts = $2, next_attempt_at = now() - interval '1 minute'
		WHERE channel_id = $1`, cid, maxChannelAttempts-1); err != nil {
		t.Fatal(err)
	}
	deliver()
	var stuck, pending, gaveUp, notMaxed int
	if err := e.st.db.QueryRow(`SELECT count(*), count(next_attempt_at),
		count(*) FILTER (WHERE last_error LIKE '已放弃%'), count(*) FILTER (WHERE attempts <> $2)
		FROM notify_deliveries WHERE channel_id = $1 AND sent_at IS NULL`, cid, maxChannelAttempts).
		Scan(&stuck, &pending, &gaveUp, &notMaxed); err != nil {
		t.Fatal(err)
	}
	if stuck == 0 || pending != 0 || gaveUp != stuck || notMaxed != 0 {
		t.Fatalf("用完重试次数的投递应全部放弃且不再排期: stuck=%d pending=%d gaveUp=%d notMaxed=%d", stuck, pending, gaveUp, notMaxed)
	}
	if len(inbox()) != 5 {
		t.Fatalf("机器人仍故障,不应有新消息: %v", inbox())
	}
	mu.Lock()
	broken = false
	mu.Unlock()
	deliver()
	if len(inbox()) != 5 {
		t.Fatalf("已放弃的投递不应再发: %v", inbox())
	}

	// 删除渠道:投递记录一并清掉
	e.must(admin, "DELETE", path+"/"+cid, nil)
	if n := len(dig(e.must(admin, "GET", path, nil), "list").([]any)); n != 0 {
		t.Fatalf("渠道应已删除,还剩 %d 个", n)
	}
	var left int
	_ = e.st.db.QueryRow(`SELECT count(*) FROM notify_deliveries WHERE channel_id = $1`, cid).Scan(&left)
	if left != 0 {
		t.Fatalf("投递记录应随渠道删除,还剩 %d 条", left)
	}
	e.fail(admin, "DELETE", path+"/"+cid, nil, 404, "不存在")
	// 没有渠道之后,后续通知不再外发(经办投出 G2 的票,会产生"评审通过"通知)
	e.must(h1, "POST", "/api/reviews/"+lastReviewID(e, pm, pid)+"/decide", map[string]any{"decision": "approve"})
	deliver()
	if len(inbox()) != 5 {
		t.Fatalf("渠道删除后不应发送: %v", inbox())
	}
}

// lastReviewID 项目最新一轮评审
func lastReviewID(e *env, token, pid string) string {
	e.t.Helper()
	proj := e.project(token, pid)
	return dig(proj, "review", "id").(string)
}

func TestExportAndDeleteProcess(t *testing.T) {
	e := newTestEnv(t)
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	cto, _ := e.createUser(admin, "张技术", RoleCTO)
	// 第二位 CTO 不投票:或签由首位表决人定论后,他那一票应显示为"未表决"
	e.createUser(admin, "钱技术", RoleCTO)
	pm, pmID := e.createUser(admin, "李经理", RolePM)
	_, h1ID := e.createUser(admin, "王经办", RoleHandler)

	e.fail("", "GET", "/api/projects/export.csv", nil, 401, "未登录")
	e.fail("", "GET", "/api/projects/x/export", nil, 401, "未登录")

	// 空清单也有表头,带 BOM,Excel 能直接识别中文
	code, hdr, body := e.raw(pm, "/api/projects/export.csv")
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/csv") || !strings.HasPrefix(body, "\xEF\xBB\xBF") ||
		len(strings.Split(strings.TrimSpace(body[3:]), "\r\n")) != 1 || !strings.Contains(body, "项目名称") {
		t.Fatalf("空清单不符: %d %s %q", code, hdr.Get("Content-Type"), body)
	}

	// 立项并推进一段
	e.must("", "POST", "/api/processes", processPayload("采购流程"))
	pid := e.projectByName(admin, "采购流程")
	var procID string
	_ = e.st.db.QueryRow(`SELECT process_id FROM projects WHERE id = $1`, pid).Scan(&procID)
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": pmID, "role": "pm", "action": "add"})
	e.must(admin, "PUT", "/api/projects/"+pid+"/members", map[string]any{"userId": h1ID, "role": "handler", "action": "add"})
	e.must(pm, "PATCH", "/api/projects/"+pid, map[string]any{"value": "高", "complexity": "中", "priority": "high", "dueDate": "2026-12-31"})
	// 标题里带竖线:Markdown 表格里必须转义
	e.must(pm, "POST", "/api/projects/"+pid+"/items", map[string]any{"title": "梳理接口清单（OA | 财务）", "assigneeId": h1ID, "stageSeq": 2})
	e.must(pm, "POST", "/api/projects/"+pid+"/comments", map[string]any{"body": "先对齐口径"})
	e.must(pm, "POST", "/api/projects/"+pid+"/updates", map[string]any{"progress": "立项材料已备齐", "next": "提交评审", "health": "at_risk", "risks": "合同系统排期紧"})
	e.completeRequired(pm, pid, 1)
	e.submit(pm, pid, "请立项，基线见附件")
	e.must(cto, "POST", "/api/reviews/"+lastReviewID(e, pm, pid)+"/decide", map[string]any{"decision": "approve", "comment": "同意立项"})

	// CSV:一行数据,字段与界面口径一致
	code, hdr, body = e.raw(pm, "/api/projects/export.csv")
	rows := strings.Split(strings.TrimSpace(body[3:]), "\r\n")
	if code != 200 || len(rows) != 2 || !strings.Contains(hdr.Get("Content-Disposition"), "attachment") {
		t.Fatalf("清单不符: %d %q", code, body)
	}
	for _, want := range []string{"采购流程", "孙申报", "进行中", "2. 需求确认", "待项目经理处理", "高", "高", "中", "有风险", "李经理", "2026-12-31"} {
		if !strings.Contains(rows[1], want) {
			t.Errorf("清单应包含 %q: %s", want, rows[1])
		}
	}
	// 未完成的必交付物逐项列出;流程改善指标同口径
	if !strings.Contains(rows[1], "现状核对记录、需求清单、KPI 基线") || !strings.Contains(rows[1], "17%") {
		t.Errorf("清单的必交付物 / 指标不符: %s", rows[1])
	}
	// 状态过滤
	if _, _, b := e.raw(pm, "/api/projects/export.csv?status=done"); len(strings.Split(strings.TrimSpace(b[3:]), "\r\n")) != 1 {
		t.Fatalf("按状态过滤后不应有已完成项目: %q", b)
	}
	e.fail(pm, "GET", "/api/projects/export.csv?status=bogus", nil, 400, "状态")

	// Markdown 报告
	code, hdr, md := e.raw(pm, "/api/projects/"+pid+"/export")
	if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/markdown") || !strings.Contains(hdr.Get("Content-Disposition"), "attachment") {
		t.Fatalf("报告响应头不符: %d %v", code, hdr)
	}
	for _, want := range []string{
		"# 项目报告：采购流程", "## 基本信息", "## 阶段与关卡", "## 评审记录", "## 工作项", "## 项目简报", "## 流程改善指标", "## 时间线",
		"G1 立项评审 · 分析立项 · 第 1 轮 —— 已通过", "同意立项", "或签 · CTO", "会签 · 经办",
		"★必交付", "梳理接口清单", "健康度：有风险", "合同系统排期紧", "立项时（As-Is）", "同意立项",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("报告应包含 %q", want)
		}
	}
	// 或签由首位表决人定论:另一位 CTO 没投票,报告里如实写"未表决"而不是"待表决"
	if !strings.Contains(md, "| 未表决 |") || strings.Contains(md, "| 待表决 |") {
		t.Errorf("已定论的评审里没投的票应写「未表决」:\n%s", md)
	}
	// 无关卡的阶段不留空白单元格
	if strings.Contains(md, "| 运营优化 | — |  |") {
		t.Errorf("无关卡阶段的评审规则应写「—」")
	}
	// 已通过的 G1:通过时间与轮次
	if !strings.Contains(md, "已通过 |") || !strings.Contains(md, "（第 1 轮通过）") {
		t.Errorf("阶段表应体现评审已通过: %s", md)
	}
	// 表格单元格里不能有未转义的竖线;工作项表的每行都是 6 列
	if !strings.Contains(md, "梳理接口清单（OA \\| 财务）") {
		t.Errorf("单元格里的竖线应转义")
	}
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "| ") && strings.Contains(line, "\r") {
			t.Errorf("表格行里不应有换行: %q", line)
		}
	}
	// 事件说明:提交评审带关卡、轮次与说明;时间线新到旧
	i1, i2 := strings.Index(md, "同意立项"), strings.Index(md, "## 时间线")
	if i1 < 0 || i2 < 0 || !strings.Contains(md[i2:], "提交评审 | 关卡「G1 立项评审」，第 1 轮；说明：请立项，基线见附件") ||
		!strings.Contains(md[i2:], "提交简报 | 健康度：正常 → 有风险") || !strings.Contains(md[i2:], "新建工作项 | 梳理接口清单") ||
		!strings.Contains(md[i2:], "修改项目信息 | 修改了 优先级、改造价值、复杂度、目标完成日") {
		t.Errorf("时间线说明不符:\n%s", md[i2:])
	}
	if strings.Index(md[i2:], "建立项目") < strings.Index(md[i2:], "提交评审") {
		t.Errorf("时间线应新到旧:\n%s", md[i2:])
	}

	// JSON 导出:同一份数据的结构化形式
	j := e.must(pm, "GET", "/api/projects/"+pid+"/export?format=json", nil)
	if dig(j, "project", "name") != "采购流程" || len(dig(j, "project", "can").(map[string]any)) != 0 ||
		len(dig(j, "reviews").([]any)) != 1 || len(dig(j, "items").([]any)) < 5 || len(dig(j, "comments").([]any)) != 2 ||
		len(dig(j, "events").([]any)) == 0 || len(dig(j, "versions").([]any)) != 1 {
		t.Fatalf("JSON 导出不符: %+v", j)
	}
	e.fail(pm, "GET", "/api/projects/nope/export", nil, 404, "不存在")

	// 删除流程:连同它的项目与全部关联记录一并删除(此前会被项目表的外键挡住而失败)
	tables := []struct {
		name, where string
	}{
		{"projects", "id = $1"}, {"project_stages", "project_id = $1"}, {"project_members", "project_id = $1"},
		{"gate_reviews", "project_id = $1"}, {"work_items", "project_id = $1"}, {"comments", "project_id = $1"},
		{"events", "project_id = $1"}, {"notifications", "project_id = $1"},
	}
	count := func(q, arg string) int {
		e.t.Helper()
		var n int
		if err := e.st.db.QueryRow(`SELECT count(*) FROM `+q, arg).Scan(&n); err != nil {
			e.t.Fatal(err)
		}
		return n
	}
	// 一票已投、一票未投:删除时两类表决记录都要清掉
	if n := count(`gate_reviewers gr JOIN gate_reviews r ON r.id = gr.review_id WHERE r.project_id = $1`, pid); n != 2 {
		t.Fatalf("删除前应有 2 条表决记录(一位 CTO 已投、一位未投),得到 %d", n)
	}
	if n := count(`process_versions WHERE project_id = $1`, pid); n != 1 {
		t.Fatalf("删除前应有 1 个版本快照,得到 %d", n)
	}
	if n := count(`notifications WHERE item_id IN (SELECT id FROM work_items WHERE project_id = $1)`, pid); n == 0 {
		t.Fatal("删除前应有与工作项相关的通知")
	}
	e.must(admin, "DELETE", "/api/admin/processes/"+procID, nil)
	for _, tb := range tables {
		if n := count(tb.name+" WHERE "+tb.where, pid); n != 0 {
			t.Errorf("%s 里应没有该流程项目的残留,还有 %d 行", tb.name, n)
		}
	}
	for _, q := range []string{
		`gate_reviewers gr JOIN gate_reviews r ON r.id = gr.review_id WHERE r.project_id = $1`,
		`process_versions WHERE project_id = $1 OR process_id = (SELECT id FROM projects WHERE id = $1)`,
		`process_versions WHERE process_id = $1`,
		`notifications WHERE item_id IN (SELECT id FROM work_items WHERE project_id = $1)`,
	} {
		if n := count(q, pid); n != 0 {
			t.Errorf("关联记录未清干净(%s): %d 行", q, n)
		}
	}
	e.fail(pm, "GET", "/api/projects/"+pid, nil, 404, "不存在")
	e.fail(pm, "GET", "/api/processes/"+procID, nil, 404, "不存在")
	// 再删一次:流程已不存在
	e.fail(admin, "DELETE", "/api/admin/processes/"+procID, nil, 404, "不存在")
	if code, out := e.req(pm, "DELETE", "/api/processes/whatever", nil); code != 403 {
		t.Fatalf("非管理员不能删除流程,得到 %d: %v", code, out)
	}

	// 按所选项目导出(看板上筛出哪些就导哪些),顺序与传入一致
	e.must("", "POST", "/api/processes", processPayload("另一个流程"))
	e.must("", "POST", "/api/processes", processPayload("又一个流程"))
	a1 := e.projectByName(admin, "另一个流程")
	a2 := e.projectByName(admin, "又一个流程")
	code, _, body = e.postRaw(pm, "/api/projects/export.csv", map[string]any{"ids": []string{a2, a1}})
	rows = strings.Split(strings.TrimSpace(body[3:]), "\r\n")
	if code != 200 || len(rows) != 3 || !strings.HasPrefix(rows[1], "又一个流程,") || !strings.HasPrefix(rows[2], "另一个流程,") {
		t.Fatalf("按所选导出不符: %d %q", code, body)
	}
	e.fail(pm, "POST", "/api/projects/export.csv", map[string]any{"ids": []string{}}, 400, "请选择")
	e.fail("", "POST", "/api/projects/export.csv", map[string]any{"ids": []string{a1}}, 401, "未登录")

	// 防公式注入:流程名与申报人是匿名提交的自由文本,以 = + - @ 开头时加单引号前缀
	const evilName = `=HYPERLINK("http://example.invalid","点我")`
	e.must("", "POST", "/api/processes", processPayload(evilName))
	eviID := e.projectByName(admin, evilName)
	var evilProc string
	if err := e.st.db.QueryRow(`SELECT process_id FROM projects WHERE id = $1`, eviID).Scan(&evilProc); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.db.Exec(`UPDATE processes SET applicant = '+SUM(1,1)' WHERE id = $1`, evilProc); err != nil {
		t.Fatal(err)
	}
	_, _, body = e.raw(pm, "/api/projects/export.csv")
	// 含逗号 / 引号的单元格会被 CSV 编码器用双引号包起来,单引号前缀在双引号里面
	lines := strings.Split(strings.TrimSpace(body[3:]), "\r\n")[1:]
	var evilRow string
	plain := false
	for _, line := range lines {
		if strings.Contains(line, "HYPERLINK") {
			evilRow = line
		}
		plain = plain || strings.HasPrefix(line, "另一个流程,")
	}
	if !strings.HasPrefix(evilRow, "\"'=HYPERLINK") || !strings.Contains(evilRow, "\"'+SUM(1,1)\"") {
		t.Fatalf("以公式符号开头的名称与申报人应加单引号前缀: %q", evilRow)
	}
	if !plain {
		t.Fatalf("普通名称不应被改写: %q", body)
	}
	e.must(admin, "DELETE", "/api/admin/processes/"+evilProc, nil)

	// 内置模板可单独取到(后台"恢复内置模板"用),与当前保存的模板互不影响
	builtin := e.mustArray(admin, "GET", "/api/admin/stage-templates?builtin=1", nil)
	if len(builtin) != 7 || dig(builtin[6], "name") != "运营优化" {
		t.Fatalf("内置模板不符: %+v", builtin)
	}
	changed := append([]any{}, builtin[:6]...)
	changed = append(changed, map[string]any{"name": "持续运营", "gate": "", "reviewerRole": "", "mode": "", "required": []string{}, "tasks": []string{}})
	e.must(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": changed})
	if dig(e.mustArray(admin, "GET", "/api/admin/stage-templates?builtin=1", nil)[6], "name") != "运营优化" {
		t.Fatal("内置模板不应随后台修改而变化")
	}
	if dig(e.mustArray(admin, "GET", "/api/admin/stage-templates", nil)[6], "name") != "持续运营" {
		t.Fatal("当前模板应为修改后的")
	}
	e.must(admin, "PUT", "/api/admin/stage-templates", map[string]any{"templates": builtin})
}

// postRaw 发带 JSON 请求体的 POST 并返回原始响应
func (e *env) postRaw(token, path string, payload any) (int, http.Header, string) {
	e.t.Helper()
	body, _ := json.Marshal(payload)
	r, err := http.NewRequest("POST", e.srv.URL+path, strings.NewReader(string(body)))
	if err != nil {
		e.t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	res, err := e.srv.Client().Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, res.Header, string(raw)
}
