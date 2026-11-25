package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// captureLogs 把默认日志器换成写到缓冲区的,按给定级别和格式;测试结束还原
func captureLogs(t *testing.T, level slog.Leveler, jsonFormat bool) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	opts := &slog.HandlerOptions{Level: level}
	if jsonFormat {
		slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, opts)))
	} else {
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, opts)))
	}
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func serve(h http.Handler, method, target string, tweak ...func(*http.Request)) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, target, nil)
	for _, f := range tweak {
		f(req)
	}
	h.ServeHTTP(rec, req)
	return rec
}

func withHeader(k, v string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set(k, v) }
}

// flat 去掉日志行里的引号:slog 给不给值加引号的规则很细(纯英文带空格的加,含中文的不加),
// 断言关心的是内容,不是引号
func flat(s string) string { return strings.ReplaceAll(s, `"`, "") }

func postJSON(h http.Handler, path string, body string, tweak ...func(*http.Request)) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for _, f := range tweak {
		f(req)
	}
	h.ServeHTTP(rec, req)
	return rec
}

// 访问日志:每个请求一行,带编号、状态码、耗时、来源地址、登录人;失败请求带原因;
// 高频轮询的成功请求降到 debug;请求编号沿用来带的并写回响应头
func TestRequestLog(t *testing.T) {
	buf := captureLogs(t, slog.LevelDebug, false)
	prevSessions := sessions
	sessions = newSessionStore()
	t.Cleanup(func() { sessions = prevSessions })
	tok := sessions.create("alice", "admin", "u1", false)

	h := requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/missing":
			writeError(w, http.StatusNotFound, "流程不存在")
		case "/api/boom":
			writeError(w, http.StatusInternalServerError, "读取失败: pq: connection reset")
		case "/api/gateway":
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("<html>bad gateway</html>"))
		default:
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		}
	}))
	// 响应体原样送到客户端
	if rec := serve(h, "GET", "/api/projects?status=active&api_key=s3cr3t&token=abc", withHeader("CF-Connecting-IP", "203.0.113.9"), withHeader("Authorization", "Bearer "+tok)); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("响应体不应被访问日志改动: %d %q", rec.Code, rec.Body.String())
	}

	// 沿用来带的合法编号,并写回响应头
	rec := serve(h, "DELETE", "/api/admin/processes/abc", withHeader(requestIDHeader, "client-abc_123-x"), withHeader("X-Forwarded-For", "198.51.100.7, 10.0.0.1"))
	if got := rec.Header().Get(requestIDHeader); got != "client-abc_123-x" {
		t.Fatalf("应沿用并写回来带的请求编号,得到 %q", got)
	}
	// 不合法的编号换成新生成的(16 位十六进制)
	rec = serve(h, "DELETE", "/api/admin/processes/abc", withHeader(requestIDHeader, "bad id with spaces"))
	if id := rec.Header().Get(requestIDHeader); len(id) != 16 || strings.Trim(id, "0123456789abcdef") != "" {
		t.Fatalf("不合法的编号应被换成 16 位十六进制,得到 %q", id)
	}

	out := buf.String()
	lines := strings.Split(strings.TrimSpace(out), "\n")
	want := []string{
		// 成功的读请求:info,带查询串(凭据类的值打码)、来源地址、登录人与角色
		`level=INFO msg=request req=`,
		`method=GET path=/api/projects status=200`,
		`ip=203.0.113.9 query="api_key=***&status=active&token=***" user=alice role=admin`,
		// 写请求:没有 Cloudflare 头时取转发链最左的地址
		`method=DELETE path=/api/admin/processes/abc status=200`,
		`ip=198.51.100.7`,
	}
	for _, w := range want {
		if !strings.Contains(out, w) {
			t.Errorf("访问日志应包含 %q\n实际输出:\n%s", w, out)
		}
	}
	if n := len(lines); n != 3 {
		t.Errorf("三次请求应记三行,得到 %d:\n%s", n, out)
	}
	for _, l := range lines {
		if !strings.Contains(l, " dur=") || !strings.Contains(l, " bytes=") {
			t.Errorf("每行都应有耗时与字节数: %s", l)
		}
	}

	// 失败请求:4xx 告警、5xx 错误,都带上响应里的原因;非 JSON 的响应退回原文
	buf.Reset()
	serve(h, "GET", "/api/missing")
	serve(h, "GET", "/api/boom")
	serve(h, "GET", "/api/gateway")
	out = flat(buf.String())
	// 每个三元组(级别、状态码、原因)必须落在同一行上
	for _, w := range []string{
		`level=WARN msg=request`, `path=/api/missing status=404`, `ip=192.0.2.1 err=流程不存在`,
		`level=ERROR msg=request`, `path=/api/boom status=500`, `err=读取失败: pq: connection reset`,
		`path=/api/gateway status=502`, `err=<html>bad gateway</html>`,
	} {
		if !strings.Contains(out, w) {
			t.Errorf("失败请求的日志应包含 %q\n实际输出:\n%s", w, out)
		}
	}
	// 未登录的请求不写 user
	if strings.Contains(out, "user=") {
		t.Errorf("未登录的请求不应有 user: %s", out)
	}

	// 高频轮询的成功请求:debug 级
	buf.Reset()
	serve(h, "GET", "/api/notifications?unread=1")
	out = buf.String()
	if !strings.Contains(out, "level=DEBUG") || !strings.Contains(out, "msg=request") || !strings.Contains(out, "path=/api/notifications") {
		t.Errorf("轮询接口的成功请求应记在 debug 级:\n%s", out)
	}

	// 超过阈值的慢请求按告警记
	prevSlow := slowRequest
	slowRequest = time.Nanosecond
	t.Cleanup(func() { slowRequest = prevSlow })
	buf.Reset()
	serve(h, "GET", "/api/projects")
	if out = buf.String(); !strings.Contains(out, "level=WARN") || !strings.Contains(out, "slow=true") {
		t.Errorf("慢请求应记为告警并标出 slow:\n%s", out)
	}
}

// 默认级别(info)下看不到轮询与 debug 行;失败的不受级别影响
func TestRequestLogDefaultLevelHidesNoise(t *testing.T) {
	buf := captureLogs(t, slog.LevelInfo, false)
	h := requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/notifications" && r.URL.Query().Get("expired") != "" {
			writeError(w, http.StatusUnauthorized, "未登录或会话已过期")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
	serve(h, "GET", "/api/notifications?unread=1")
	serve(h, "GET", "/api/overview?full=1")
	serve(h, "OPTIONS", "/api/projects")
	serve(h, "GET", "/api/projects")
	if out := buf.String(); strings.Count(strings.TrimSpace(out), "\n") != 0 || !strings.Contains(out, "path=/api/projects") {
		t.Fatalf("info 级别下只应记下 /api/projects 这一行:\n%s", out)
	}
	buf.Reset()
	serve(h, "GET", "/api/notifications?expired=1")
	if out := buf.String(); !strings.Contains(out, "level=WARN") || !strings.Contains(out, "status=401") {
		t.Fatalf("轮询接口失败时照常要记:\n%s", out)
	}
}

// json 格式:每行是一个对象,字段名固定,便于采集系统解析
func TestRequestLogJSONFormat(t *testing.T) {
	buf := captureLogs(t, slog.LevelInfo, true)
	h := requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) }))
	serve(h, "GET", "/api/projects", withHeader(requestIDHeader, "json-req-0001"))
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("json 日志应能解析: %v\n%s", err, buf.String())
	}
	if line["msg"] != "request" || line["req"] != "json-req-0001" || line["level"] != "INFO" || line["status"] != float64(200) || line["dur"] == nil {
		t.Fatalf("字段不符: %v", line)
	}
}

// 处理函数 panic:连接不断,记下堆栈,回一个带请求编号的 500;访问日志记到 500
func TestRecoverPanics(t *testing.T) {
	buf := captureLogs(t, slog.LevelInfo, false)
	h := requestLog(recoverPanics(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/panic":
			panic("boom: assignment to entry in nil map")
		case "/late":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("partial"))
			panic("after headers were sent")
		case "/abort":
			panic(http.ErrAbortHandler)
		}
		w.WriteHeader(http.StatusOK)
	})))

	rec := serve(h, "GET", "/panic", withHeader(requestIDHeader, "panic-req-0001"))
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != 500 || body["requestId"] != "panic-req-0001" || body["error"] == "" {
		t.Fatalf("panic 应回 500 并带请求编号,得到 %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("panic 的内容不该返回给浏览器: %s", rec.Body.String())
	}
	out := buf.String()
	for _, w := range []string{`level=ERROR msg=panic req=panic-req-0001 err="boom: assignment to entry in nil map"`, `stack=`, `TestRecoverPanics`, `msg=request req=panic-req-0001 method=GET path=/panic status=500`} {
		if !strings.Contains(out, w) {
			t.Errorf("panic 的日志应包含 %q\n实际输出:\n%s", w, out)
		}
	}

	// 响应头已经发出去了:状态码改不了,但 panic 照样记
	buf.Reset()
	rec = serve(h, "GET", "/late")
	if rec.Code != 200 || rec.Body.String() != "partial" {
		t.Fatalf("已发出的响应不应被改写: %d %q", rec.Code, rec.Body.String())
	}
	if out = buf.String(); !strings.Contains(out, "msg=panic") || strings.Contains(out, "status=500") {
		t.Errorf("响应头已发出时只记 panic、不改状态码:\n%s", out)
	}

	// http.ErrAbortHandler 是中止响应的约定信号,照常交给 net/http
	func() {
		defer func() {
			if v := recover(); v != http.ErrAbortHandler {
				t.Fatalf("ErrAbortHandler 应原样抛出,得到 %v", v)
			}
		}()
		serve(h, "GET", "/abort")
	}()
}

// 中间件链与预检:OPTIONS 不记日志
func TestNewHandlerSkipsPreflight(t *testing.T) {
	buf := captureLogs(t, slog.LevelDebug, false)
	h := newHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	if rec := serve(h, "OPTIONS", "/api/projects"); rec.Code != http.StatusNoContent {
		t.Fatalf("预检应由 CORS 中间件回 204,得到 %d", rec.Code)
	}
	if buf.Len() != 0 {
		t.Fatalf("预检不应记日志: %s", buf.String())
	}
	// 安全头与响应编号都还在
	rec := serve(h, "GET", "/api/projects")
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" || rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get(requestIDHeader) == "" {
		t.Fatalf("中间件链应保留安全头并写回请求编号: %v", rec.Header())
	}
}

func TestRedactQueryAndClientIP(t *testing.T) {
	if got := redactQuery("view=mine&status=active&password=hunter2&signature=abc&access_token=t1"); got != "access_token=***&password=***&signature=***&status=active&view=mine" {
		t.Errorf("查询串打码不符: %s", got)
	}
	if got := redactQuery("a=%zz"); got != "<无法解析>" {
		t.Errorf("解析不了的查询串应有占位: %s", got)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "192.0.2.5:1234"
	if got := clientIPForLog(req); got != "192.0.2.5" {
		t.Errorf("直连时记对端地址,得到 %s", got)
	}
	req.Header.Set("CF-Connecting-IP", "203.0.113.9")
	if got := clientIPForLog(req); got != "203.0.113.9" {
		t.Errorf("有 Cloudflare 头时记访客地址,得到 %s", got)
	}
	req.Header.Set("CF-Connecting-IP", "not-an-ip")
	req.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.1")
	if got := clientIPForLog(req); got != "198.51.100.7" {
		t.Errorf("没有合法的 Cloudflare 头时取转发链最左的地址,得到 %s", got)
	}
	if got := dbTarget("postgres://flow:s3cret@db.example.internal:5432/flowdb?sslmode=disable"); got != "db.example.internal:5432/flowdb" {
		t.Errorf("连接串只应留主机和库名,得到 %s", got)
	}
	if got := dbTarget("not a url"); got != "PostgreSQL" {
		t.Errorf("解析不了的连接串应有占位,得到 %s", got)
	}
}

// 日志上报接口:收下并原样写进日志流(级别映射、请求编号、登录人以后端会话为准),
// 拒绝空批次、超量、坏格式,并限流
func TestClientLogsEndpoint(t *testing.T) {
	buf := captureLogs(t, slog.LevelDebug, false)
	prevSessions := sessions
	sessions = newSessionStore()
	t.Cleanup(func() { sessions = prevSessions })
	tok := sessions.create("bob", "member", "u2", false)
	h := handleClientLogs(newWindowLimiter(3, time.Minute))
	withTok := withHeader("Authorization", "Bearer "+tok)

	batch := `{"source":"browser","entries":[
		{"level":"error","message":"未捕获的异常: x is not a function","stack":"TypeError: x is not a function\n    at a (app.js:1:1)","page":"/projects/abc","session":"s-1","count":3,
		 "request":{"method":"DELETE","path":"/api/admin/processes/9","status":0,"requestId":"client-req-0001","error":"Failed to fetch"}},
		{"level":"warn","message":"console.error: Hydration failed","page":"/work"},
		{"level":"bogus","message":"` + strings.Repeat("长", 400) + `\u0000","page":"/x"}
	]}`
	rec := postJSON(h, clientLogsPath, batch, withTok)
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"accepted":3`) {
		t.Fatalf("合法批次应 202,得到 %d %s", rec.Code, rec.Body.String())
	}
	out := buf.String()
	if n := strings.Count(strings.TrimSpace(out), "\n") + 1; n != 3 {
		t.Errorf("三条上报应记三行,得到 %d:\n%s", n, out)
	}
	// 第一条:error 级;req 是"被上报的那次请求"的编号;登录人来自会话;带请求信息与堆栈
	out = flat(out)
	for _, w := range []string{
		`level=ERROR msg=未捕获的异常: x is not a function req=client-req-0001 source=client:browser page=/projects/abc session=s-1 user=bob count=3 http_method=DELETE http_status=0 http_path=/api/admin/processes/9 err=Failed to fetch`,
		`stack=TypeError: x is not a function`, `at a (app.js:1:1)`,
		`level=WARN msg=console.error: Hydration failed source=client:browser page=/work user=bob`,
	} {
		if !strings.Contains(out, w) {
			t.Errorf("上报日志应包含 %q\n实际输出:\n%s", w, out)
		}
	}
	// 不认识的级别按 info;超长内容截断;NUL 被去掉
	third := ""
	for _, l := range strings.Split(out, "\n") {
		if strings.Contains(l, "page=/x") {
			third = l
		}
	}
	if !strings.Contains(third, "level=INFO msg="+strings.Repeat("长", 300)+"…") || !strings.Contains(third, "page=/x") {
		t.Errorf("不认识的级别按 info、超长截断: %s", third)
	}
	if strings.Contains(out, "\x00") {
		t.Errorf("控制字符不应进入日志")
	}

	// 来路不认识的 source 一律按浏览器
	buf.Reset()
	postJSON(h, clientLogsPath, `{"source":"forge-server","entries":[{"level":"info","message":"pretend","page":"/"}]}`, withHeader("Authorization", "Bearer not-a-real-token"))
	out = buf.String()
	if !strings.Contains(out, "source=client:browser") || strings.Contains(out, "user=") {
		t.Errorf("source 应归一成 browser,没有有效会话就不写 user:\n%s", out)
	}

	// 不合法的输入
	prev := buf.String()
	_ = prev
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"空批次", `{"entries":[]}`, http.StatusBadRequest},
		{"不是 JSON", `<html>`, http.StatusBadRequest},
		{"缺 entries", `{"source":"browser"}`, http.StatusBadRequest},
		{"超过 20 条", `{"entries":[` + strings.Repeat(`{"level":"info","message":"x"},`, 20) + `{"level":"info","message":"x"}]}`, http.StatusRequestEntityTooLarge},
		{"超过 64KB", `{"entries":[{"level":"info","message":"` + strings.Repeat("a", 70<<10) + `"}]}`, http.StatusRequestEntityTooLarge},
	} {
		// 上面的几项各占一次限流名额:每轮换一个新限流器,免得和真正的限流用例互相干扰
		h = handleClientLogs(newWindowLimiter(100, time.Minute))
		if rec := postJSON(h, clientLogsPath, tc.body, withHeader("Authorization", "Bearer "+tok)); rec.Code != tc.want {
			t.Errorf("%s: 期望 %d,得到 %d %s", tc.name, tc.want, rec.Code, rec.Body.String())
		}
	}

	// 限流:同一来源每分钟 3 批
	limiter := newWindowLimiter(3, time.Minute)
	h = handleClientLogs(limiter)
	ok := `{"entries":[{"level":"info","message":"x"}]}`
	for i := 0; i < 3; i++ {
		if rec := postJSON(h, clientLogsPath, ok); rec.Code != http.StatusAccepted {
			t.Fatalf("前 3 批应被接受,第 %d 批得到 %d", i+1, rec.Code)
		}
	}
	if rec := postJSON(h, clientLogsPath, ok); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第 4 批应被限流,得到 %d", rec.Code)
	}
	// 上报自己的成败不产生 info 级的访问日志噪音,失败照常记
	buf.Reset()
	serve(requestLog(h), http.MethodPost, clientLogsPath, func(r *http.Request) { r.Body = http.NoBody })
	// 上一行会被限流(429),属于失败,应该记
	if out := buf.String(); !strings.Contains(out, "status=429") {
		t.Fatalf("上报失败应记访问日志:\n%s", out)
	}
}

// 审计行:带动作、登录人和请求编号
func TestAuditLine(t *testing.T) {
	buf := captureLogs(t, slog.LevelInfo, false)
	prevSessions := sessions
	sessions = newSessionStore()
	t.Cleanup(func() { sessions = prevSessions })
	tok := sessions.create("carol", "admin", "u3", false)

	h := requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		audit(r, "process.delete", "process", "p-1", "name", "采购申请审批流程")
		w.WriteHeader(http.StatusOK)
	}))
	serve(h, "DELETE", "/api/admin/processes/p-1", withHeader("Authorization", "Bearer "+tok), withHeader(requestIDHeader, "audit-req-0001"))
	want := `level=INFO msg=audit req=audit-req-0001 action=process.delete user=carol process=p-1 name=采购申请审批流程`
	if out := buf.String(); !strings.Contains(out, want) {
		t.Fatalf("审计行不符,应包含 %q\n实际输出:\n%s", want, out)
	}
}

// writeErr:业务错误原样返回;内部错误只回通用提示,真实原因带请求编号进日志
func TestWriteErrKeepsDetailsInLog(t *testing.T) {
	buf := captureLogs(t, slog.LevelInfo, false)
	h := requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/business" {
			writeErr(w, r, conflict("版本已更新，请刷新后重试"))
			return
		}
		writeErr(w, r, context.DeadlineExceeded)
	}))
	rec := serve(h, "PUT", "/api/business", withHeader(requestIDHeader, "err-req-0001"))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "版本已更新，请刷新后重试") {
		t.Fatalf("业务错误应原样返回: %d %s", rec.Code, rec.Body.String())
	}
	rec = serve(h, "PUT", "/api/internal", withHeader(requestIDHeader, "err-req-0002"))
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "deadline") {
		t.Fatalf("内部错误不应把细节返回给浏览器: %d %s", rec.Code, rec.Body.String())
	}
	out := flat(buf.String())
	for _, w := range []string{
		`level=ERROR msg=内部错误 req=err-req-0002 err=context deadline exceeded`,
		`level=WARN msg=request req=err-req-0001 method=PUT path=/api/business status=409`, `err=版本已更新，请刷新后重试`,
		`level=ERROR msg=request req=err-req-0002 method=PUT path=/api/internal status=500`,
	} {
		if !strings.Contains(out, w) {
			t.Errorf("日志应包含 %q\n实际输出:\n%s", w, out)
		}
	}
}
