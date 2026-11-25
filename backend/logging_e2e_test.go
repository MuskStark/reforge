package main

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// 走完整的中间件链(与生产相同):请求编号写回响应头;登录、删流程这些动作留下审计行;
// 浏览器上报接口认出登录人,并把"被上报的那次请求"的编号记到那一行上。
func TestLoggingEndToEnd(t *testing.T) {
	e := newTestEnv(t)

	// 请求编号:沿用请求带来的,并写回响应头
	req, _ := http.NewRequest(http.MethodGet, e.srv.URL+"/api/auth/status", nil)
	req.Header.Set(requestIDHeader, "e2e-req-0001")
	res, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := res.Header.Get(requestIDHeader); got != "e2e-req-0001" {
		t.Fatalf("响应头应写回请求编号 e2e-req-0001,得到 %q", got)
	}
	// 没带编号时后端自己生成一个
	res2, err := e.srv.Client().Get(e.srv.URL + "/api/auth/status")
	if err != nil {
		t.Fatal(err)
	}
	res2.Body.Close()
	if id := res2.Header.Get(requestIDHeader); !requestIDRe.MatchString(id) {
		t.Fatalf("没带编号时应生成一个合法编号,得到 %q", id)
	}

	// 接住日志流,看登录与删除留下了什么
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))

	reg := e.must("", "POST", "/api/auth/register", map[string]any{"username": "rootadmin", "password": "pass1234"})
	admin := reg["token"].(string)
	e.must("", "POST", "/api/auth/login", map[string]any{"username": "rootadmin", "password": "pass1234"})
	// 密码错了:留一条告警
	e.fail("", "POST", "/api/auth/login", map[string]any{"username": "rootadmin", "password": "wrong-pass"}, 401, "账号或密码错误")

	pid := e.submitProject(admin, "日志审计用流程")
	procID := e.must(admin, "GET", "/api/projects/"+pid, nil)["processId"].(string)
	e.must(admin, "DELETE", "/api/admin/processes/"+procID, nil)
	// 删第二次:404,访问日志记成告警
	e.fail(admin, "DELETE", "/api/admin/processes/"+procID, nil, 404, "不存在")

	out := flat(buf.String())
	for _, w := range []string{
		`msg=audit req=`, `action=auth.register user=rootadmin`,
		`action=auth.login user=rootadmin how=password`,
		`level=WARN msg=audit`, `action=auth.login_failed user=rootadmin`,
		`action=process.delete user=rootadmin process=` + procID,
		`level=WARN msg=request`, `path=/api/admin/processes/` + procID + ` status=404`,
		`method=DELETE path=/api/admin/processes/` + procID + ` status=200`, `user=rootadmin role=admin`,
		`msg=新流程提交`,
	} {
		if !strings.Contains(out, w) {
			t.Errorf("日志流应包含 %q\n实际输出:\n%s", w, out)
		}
	}
	// 审计行和访问日志靠同一个请求编号对应:删流程那两条的编号一致
	reqOf := func(l string) string {
		for _, f := range strings.Fields(l) {
			if strings.HasPrefix(f, "req=") {
				return f
			}
		}
		return ""
	}
	auditLine, accessLine := "", ""
	for _, l := range strings.Split(out, string(rune(10))) {
		if strings.Contains(l, "action=process.delete") {
			auditLine = l
		}
		if strings.Contains(l, "msg=request") && strings.Contains(l, "path=/api/admin/processes/"+procID+" status=200") {
			accessLine = l
		}
	}
	if auditLine == "" || accessLine == "" {
		t.Fatalf("应同时有删除流程的审计行与访问日志行:\n%s", out)
	}
	if reqOf(auditLine) == "" || reqOf(auditLine) != reqOf(accessLine) {
		t.Errorf("审计行与访问日志应带同一个请求编号:\n%s\n%s", auditLine, accessLine)
	}

	// 浏览器上报:登录人以后端会话为准;被上报的请求编号落在那一行上
	buf.Reset()
	code, resp := e.req(admin, "POST", "/api/logs", map[string]any{
		"source": "browser",
		"entries": []map[string]any{{
			"level": "error", "message": "接口调用失败", "page": "/admin/processes",
			"request": map[string]any{"method": "DELETE", "path": "/api/admin/processes/x", "status": 0, "requestId": "client-req-0009", "error": "Failed to fetch"},
		}},
	})
	e.expectCode(code, http.StatusAccepted, "浏览器日志上报")
	got(t, resp, "accepted", float64(1))
	if out = flat(buf.String()); !strings.Contains(out, `msg=接口调用失败 req=client-req-0009 source=client:browser page=/admin/processes user=rootadmin`) {
		t.Errorf("上报的日志应带被上报请求的编号与登录人:\n%s", out)
	}
	e.fail(admin, "POST", "/api/logs", map[string]any{"entries": []any{}}, http.StatusBadRequest, "没有日志条目")
}
