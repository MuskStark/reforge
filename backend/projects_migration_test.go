package main

import (
	"context"
	"testing"
)

// TestLegacyMigration 旧跟进体系(跟进字段内嵌 processes + followup_events)迁入流程项目。
// 用例直接往库里写旧结构的数据,模拟升级前的库。
func TestLegacyMigration(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	_, pmID := e.createUser(admin, "老跟进", RolePM)

	steps := `[{"id":"a","name":"提交","mode":"online","countersign":false,` +
		`"online":{"systemName":"OA","mobileSupported":true},"offline":{"documents":[],"handlers":[]},"parties":[],"waitFor":null,"remark":""}]`
	insertProcess := func(id, name, follow string, stage int, assignee, due, analysis string) {
		t.Helper()
		_, err := e.st.db.Exec(`INSERT INTO processes
			(id, name, description, applicant, steps, created_at, updated_at, follow_status, assignee_id, due_date, stage, analysis)
			VALUES ($1, $2, '', '申报人', $3::jsonb, now() - interval '10 days', now(), $4, NULLIF($5,''), NULLIF($6,'')::date, $7, $8::jsonb)`,
			id, name, steps, follow, assignee, due, stage, analysis)
		if err != nil {
			t.Fatal(err)
		}
	}
	insertProcess("proc-follow", "在途流程", "following", 3, pmID, "2026-12-31",
		`{"value":"高","complexity":"低","priority":"高","conclusion":"旧分析结论"}`)
	insertProcess("proc-done", "已完成流程", "done", 5, "", "", `{"value":"中","complexity":"中","priority":"中"}`)
	insertProcess("proc-shelved", "搁置流程", "shelved", 1, pmID, "", `{}`)
	for _, ev := range []struct{ id, proc, actor, kind, detail string }{
		{"ev1", "proc-follow", "rootadmin", "analyzed", `{"pass":true}`},
		{"ev2", "proc-follow", "老跟进", "assigned", `{"assignee":"老跟进"}`},
		{"ev3", "proc-follow", "老跟进", "stage", `{"from":"需求确认","to":"方案设计"}`},
		{"ev4", "proc-done", "老跟进", "edited_chart", `{"steps":1}`},
	} {
		if _, err := e.st.db.Exec(`INSERT INTO followup_events (id, process_id, actor_id, actor_name, kind, detail, created_at)
			VALUES ($1, $2, $3, $3, $4, $5::jsonb, now() - interval '5 days')`, ev.id, ev.proc, ev.actor, ev.kind, ev.detail); err != nil {
			t.Fatal(err)
		}
	}

	n, err := e.st.EnsureProjects(ctx)
	if err != nil {
		t.Fatalf("迁移失败: %v", err)
	}
	if n != 3 {
		t.Fatalf("应为 3 条存量流程建立项目,得到 %d", n)
	}

	byProc := map[string]map[string]any{}
	_, projects := e.list(admin, "/api/projects")
	for _, raw := range projects {
		p := raw.(map[string]any)
		byProc[p["processId"].(string)] = p
	}
	// 跟进中·阶段 3 → 阶段 4「系统改造」进行中,前三个阶段已通过
	f := byProc["proc-follow"]
	if f == nil {
		t.Fatalf("缺少在途流程的项目: %+v", byProc)
	}
	got(t, f, "status", "active")
	got(t, f, "currentStage", float64(4))
	got(t, f, "stages", "2", "status", "approved")
	got(t, f, "stages", "3", "status", "in_progress")
	got(t, f, "stages", "4", "status", "pending")
	got(t, f, "pendingOn", "pm")
	got(t, f, "hasPm", true)
	got(t, f, "value", "高")
	got(t, f, "complexity", "低")
	got(t, f, "priority", "high")
	got(t, f, "dueDate", "2026-12-31")
	got(t, f, "applicant", "申报人")
	if dig(f, "analysis", "conclusion") != "旧分析结论" { // 告别旧版把 JSONB 序列化成 base64 的缺陷
		t.Fatalf("分析结论应可读: %v", f["analysis"])
	}
	if len(dig(f, "members").([]any)) != 1 || dig(f, "members", "0", "userId") != pmID || dig(f, "members", "0", "role") != "pm" {
		t.Fatalf("原跟进人应迁为项目经理: %+v", f["members"])
	}
	// 已完成:六个带关卡的阶段全部通过,停在运营优化
	d := byProc["proc-done"]
	got(t, d, "status", "done")
	got(t, d, "currentStage", float64(7))
	for i := 0; i < 6; i++ {
		got(t, d, "stages", itoa(i), "status", "approved")
	}
	got(t, d, "pendingOn", "")
	// 已搁置:恢复后应回到原阶段(跟进人 + 阶段 1 → 阶段 2 进行中)
	s := byProc["proc-shelved"]
	got(t, s, "status", "on_hold")
	got(t, s, "currentStage", float64(2))
	got(t, s, "stages", "1", "status", "in_progress")

	// 已通过阶段的必交付物视为已完成;未通过的仍是待办
	_, items := e.list(admin, "/api/projects/"+f["id"].(string)+"/items")
	for _, raw := range items {
		it := raw.(map[string]any)
		if it["required"] != true {
			continue
		}
		seq := int(dig(it, "stageSeq").(float64))
		if seq <= 3 && it["status"] != "done" {
			t.Fatalf("已通过阶段 %d 的必交付物应已完成: %+v", seq, it)
		}
		if seq == 4 && it["status"] != "todo" {
			t.Fatalf("进行中阶段的必交付物不应完成: %+v", it)
		}
	}

	// 旧时间线迁入统一事件流,放在项目创建事件之后;被原地编辑过的流程,As-Is 快照带提示
	_, events := e.list(admin, "/api/projects/"+f["id"].(string)+"/events")
	kinds := make([]string, 0, len(events))
	for _, raw := range events {
		kinds = append(kinds, dig(raw, "kind").(string))
	}
	// 时间线新到旧:建项目(刚刚)在最上,其下是五天前的旧动态(阶段 → 指派 → 分析)
	if len(kinds) != 4 || kinds[0] != "project_created" || kinds[1] != "legacy_stage" || kinds[2] != "legacy_assigned" || kinds[3] != "legacy_analyzed" {
		t.Fatalf("在途流程的时间线不符: %v", kinds)
	}
	_, versions := e.list(admin, "/api/projects/"+d["id"].(string)+"/versions")
	if len(versions) != 1 || dig(versions[0], "note") == "" {
		t.Fatalf("已完成流程应有 1 个 As-Is 快照: %+v", versions)
	}
	_, versions = e.list(admin, "/api/projects/"+f["id"].(string)+"/versions")
	if len(versions) != 1 {
		t.Fatalf("在途流程应有 1 个 As-Is 快照: %+v", versions)
	}

	// 重复执行:不再新建,也不重复导入事件
	if n, err := e.st.EnsureProjects(ctx); err != nil || n != 0 {
		t.Fatalf("重复迁移应新建 0 个项目,得到 %d (%v)", n, err)
	}
	_, events = e.list(admin, "/api/projects/"+f["id"].(string)+"/events")
	if len(events) != 4 {
		t.Fatalf("重复迁移后事件数应不变,得到 %d", len(events))
	}
	var total int
	_ = e.st.db.QueryRow(`SELECT count(*) FROM projects`).Scan(&total)
	if total != 3 {
		t.Fatalf("项目总数应为 3,得到 %d", total)
	}

	// 旧跟进接口已下线
	e.fail(admin, "POST", "/api/admin/processes/proc-follow/analyze", map[string]any{"pass": true}, 404, "")
	e.fail(admin, "POST", "/api/admin/processes/proc-follow/stage", map[string]any{"stage": 4}, 404, "")
	// 迁入的项目照常可以继续推进:老跟进人(现为项目经理)直接提交 G4 之外的当前阶段——先补齐必交付物
	pmToken := e.login("老跟进", userPassword)
	e.completeRequired(pmToken, f["id"].(string), 4)
	e.submit(pmToken, f["id"].(string), "迁入后继续推进")
	if _, p := e.list(admin, "/api/projects?pending=cto"); len(p) != 1 || dig(p[0], "id") != f["id"].(string) {
		t.Fatalf("迁入的项目提交后应出现在待 CTO 评审列表: %+v", p)
	}
}
