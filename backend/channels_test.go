package main

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// 假的群机器人:记下每次收到的请求,按预设应答
type botCall struct {
	Query url.Values
	Path  string
	Body  map[string]any
}

func startBot(t *testing.T, status int, reply string) (*httptest.Server, *[]botCall) {
	t.Helper()
	calls := []botCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		calls = append(calls, botCall{Query: r.URL.Query(), Path: r.URL.Path, Body: body})
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func TestBotNotifiers(t *testing.T) {
	ctx := context.Background()
	lines := []string{"【ReForge 流程再造】", "「采购流程」提交了 G1，请你评审"}
	want := strings.Join(lines, "\n")

	// 企业微信:文本消息,key 原样留在查询串里
	srv, calls := startBot(t, 200, `{"errcode":0,"errmsg":"ok"}`)
	n, err := notifierFor(&notifyChannel{Kind: ChWecom, Webhook: srv.URL + "/cgi-bin/webhook/send?key=abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Send(ctx, lines); err != nil {
		t.Fatalf("企业微信发送失败: %v", err)
	}
	c := (*calls)[0]
	if c.Query.Get("key") != "abc123" || c.Body["msgtype"] != "text" || dig(c.Body, "text", "content") != want {
		t.Fatalf("企业微信报文不符: %+v", c)
	}

	// 钉钉加签:查询串带 timestamp 与 sign,签名可用同一密钥复算
	secret := "SEC0123456789abcdef"
	srv, calls = startBot(t, 200, `{"errcode":0,"errmsg":"ok"}`)
	n, _ = notifierFor(&notifyChannel{Kind: ChDingTalk, Webhook: srv.URL + "/robot/send?access_token=tok-1", Secret: secret})
	if err := n.Send(ctx, lines); err != nil {
		t.Fatalf("钉钉发送失败: %v", err)
	}
	c = (*calls)[0]
	ts, err := strconv.ParseInt(c.Query.Get("timestamp"), 10, 64)
	if err != nil || c.Query.Get("access_token") != "tok-1" || c.Query.Get("sign") == "" {
		t.Fatalf("钉钉加签参数不符: %+v", c.Query)
	}
	if time.Since(time.UnixMilli(ts)) > time.Minute {
		t.Fatalf("钉钉时间戳应是当前时间: %d", ts)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d\n%s", ts, secret)))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); c.Query.Get("sign") != want {
		t.Fatalf("钉钉签名不符: got %q want %q", c.Query.Get("sign"), want)
	}
	if dig(c.Body, "text", "content") != want {
		t.Fatalf("钉钉正文不符: %+v", c.Body)
	}

	// 飞书签名校验:签名放在报文体里;key = 时间戳 + "\n" + 密钥,报文为空
	srv, calls = startBot(t, 200, `{"code":0,"msg":"success","data":{}}`)
	n, _ = notifierFor(&notifyChannel{Kind: ChFeishu, Webhook: srv.URL + "/open-apis/bot/v2/hook/27f3bb62-xxxx", Secret: secret})
	if err := n.Send(ctx, lines); err != nil {
		t.Fatalf("飞书发送失败: %v", err)
	}
	c = (*calls)[0]
	sec, err := strconv.ParseInt(fmt.Sprint(c.Body["timestamp"]), 10, 64)
	if err != nil {
		t.Fatalf("飞书时间戳不符: %+v", c.Body)
	}
	mac = hmac.New(sha256.New, []byte(fmt.Sprintf("%d\n%s", sec, secret)))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); c.Body["sign"] != want || c.Body["msg_type"] != "text" {
		t.Fatalf("飞书签名或报文类型不符: %+v", c.Body)
	}
	// 飞书旧版应答只带 StatusCode
	srv, _ = startBot(t, 200, `{"StatusCode":0,"StatusMessage":"success","code":0,"data":{},"msg":"success"}`)
	n, _ = notifierFor(&notifyChannel{Kind: ChFeishu, Webhook: srv.URL + "/hook"})
	if err := n.Send(ctx, lines); err != nil {
		t.Fatalf("飞书旧版应答应视为成功: %v", err)
	}
}

func TestBotNotifiersFailures(t *testing.T) {
	ctx := context.Background()
	lines := []string{"【ReForge 流程再造】", "一条通知"}
	cases := []struct {
		name   string
		kind   string
		status int
		reply  string
		substr string
	}{
		{"企业微信业务错误", ChWecom, 200, `{"errcode":93000,"errmsg":"invalid webhook url"}`, "invalid webhook url"},
		{"钉钉业务错误", ChDingTalk, 200, `{"errcode":310000,"errmsg":"keywords not in content"}`, "keywords not in content"},
		{"飞书签名错误", ChFeishu, 200, `{"code":19021,"msg":"sign match fail or timestamp is not within one hour from current time"}`, "sign match fail"},
		{"飞书旧版关键词错误", ChFeishu, 200, `{"StatusCode":19024,"StatusMessage":"Key Words Not Found"}`, "Key Words Not Found"},
		{"HTTP 5xx", ChWecom, 502, `<html>bad gateway</html>`, "502"},
	}
	for _, tc := range cases {
		srv, _ := startBot(t, tc.status, tc.reply)
		n, _ := notifierFor(&notifyChannel{Kind: tc.kind, Webhook: srv.URL + "/hook"})
		err := n.Send(ctx, lines)
		if err == nil || !strings.Contains(err.Error(), tc.substr) {
			t.Errorf("%s: 期望错误含 %q,得到 %v", tc.name, tc.substr, err)
		}
	}
	// 连不上的机器人:报错可读,且不 panic
	srv, _ := startBot(t, 200, `{}`)
	srv.Close()
	n, _ := notifierFor(&notifyChannel{Kind: ChWecom, Webhook: srv.URL})
	if err := n.Send(ctx, lines); err == nil || !strings.Contains(err.Error(), "连接机器人失败") {
		t.Fatalf("连不上时应提示连接失败,得到 %v", err)
	}
	if _, err := notifierFor(&notifyChannel{Kind: "sms", Webhook: srv.URL}); err == nil {
		t.Fatal("未知渠道类型应报错")
	}
}

// 假的邮件服务器:不加密、不要认证,把每封邮件的原文存下来
func startFakeSMTP(t *testing.T) (string, func() []string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	mails := []string{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				fmt.Fprint(c, "220 fake ESMTP\r\n")
				var mail strings.Builder
				inData := false
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					if inData {
						if line == ".\r\n" {
							inData = false
							mu.Lock()
							mails = append(mails, mail.String())
							mu.Unlock()
							fmt.Fprint(c, "250 OK queued\r\n")
							continue
						}
						mail.WriteString(line)
						continue
					}
					cmd := strings.ToUpper(strings.TrimSpace(line))
					switch {
					case cmd == "DATA":
						inData = true
						fmt.Fprint(c, "354 end with <CRLF>.<CRLF>\r\n")
					case cmd == "QUIT":
						fmt.Fprint(c, "221 bye\r\n")
						return
					default:
						fmt.Fprint(c, "250 OK\r\n")
					}
				}
			}(conn)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().String(), func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, mails...)
	}
}

func TestSMTPNotifier(t *testing.T) {
	addr, inbox := startFakeSMTP(t)
	host, port, _ := net.SplitHostPort(addr)
	n, err := notifierFor(&notifyChannel{Kind: ChEmail, SMTPHost: host, SMTPPort: atoi(port), SMTPFrom: "reforge@example.com",
		Recipients: "pm@example.com; cto@example.com\n"})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Send(context.Background(), []string{"【ReForge 流程再造】", "「采购流程」的 G1 立项评审 已通过", "详见工作台：http://reforge.local/work"}); err != nil {
		t.Fatalf("发信失败: %v", err)
	}
	got := inbox()
	if len(got) != 1 {
		t.Fatalf("应发出 1 封邮件,得到 %d", len(got))
	}
	m := got[0]
	if !strings.HasPrefix(m, "From: reforge@example.com\r\nTo: pm@example.com, cto@example.com\r\nSubject: =?UTF-8?B?") {
		t.Fatalf("邮件头不符: %q", m)
	}
	if !strings.Contains(m, "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64") {
		t.Fatalf("邮件应声明 UTF-8 与 base64: %q", m)
	}
	// 标题与正文都能解码回中文;标题 = 标头 + 首条通知 + 条数
	subjectEnc := m[strings.Index(m, "Subject: =?UTF-8?B?")+len("Subject: =?UTF-8?B?"):]
	subjectEnc = subjectEnc[:strings.Index(subjectEnc, "?=")]
	subject := decodeB64(t, subjectEnc)
	if subject != "【ReForge 流程再造】 「采购流程」的 G1 立项评审 已通过" {
		t.Fatalf("邮件标题不符: %q", subject)
	}
	body := m[strings.Index(m, "\r\n\r\n")+4:]
	var enc strings.Builder
	for _, line := range strings.Split(strings.TrimSpace(body), "\r\n") {
		enc.WriteString(line)
	}
	if text := decodeB64(t, enc.String()); text != "【ReForge 流程再造】\r\n「采购流程」的 G1 立项评审 已通过\r\n详见工作台：http://reforge.local/work" {
		t.Fatalf("邮件正文不符: %q", text)
	}
	// 多条通知时标题带条数;工作台链接不算通知
	if subject := mailSubject([]string{"【ReForge 流程再造】", "第一条", "第二条", "第三条", "详见工作台：http://x/work"}); subject != "【ReForge 流程再造】 第一条 等 3 条" {
		t.Fatalf("多条通知的标题不符: %q", subject)
	}
	if subject := mailSubject([]string{"【ReForge 流程再造】"}); subject != "【ReForge 流程再造】" {
		t.Fatalf("只有标头时标题不符: %q", subject)
	}
	// 没有收件人 / 连不上服务器:报错可读
	empty, _ := notifierFor(&notifyChannel{Kind: ChEmail, SMTPHost: host, SMTPPort: atoi(port), SMTPFrom: "a@example.com"})
	if err := empty.Send(context.Background(), []string{"x"}); err == nil || !strings.Contains(err.Error(), "收件人") {
		t.Fatalf("没有收件人应报错,得到 %v", err)
	}
	dead, _ := notifierFor(&notifyChannel{Kind: ChEmail, SMTPHost: "127.0.0.1", SMTPPort: 1, SMTPFrom: "a@example.com", Recipients: "b@example.com"})
	if err := dead.Send(context.Background(), []string{"x"}); err == nil || !strings.Contains(err.Error(), "连接邮件服务器失败") {
		t.Fatalf("连不上邮件服务器应报错,得到 %v", err)
	}
}

func decodeB64(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("base64 解码失败: %v (%q)", err, s)
	}
	return string(b)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func TestComposeChannelMessage(t *testing.T) {
	t.Setenv("FLOW_PUBLIC_URL", "http://reforge.local/")
	lines, used := composeChannelMessage([]string{"第一条", "第二条"})
	if used != 2 || strings.Join(lines, "|") != "【ReForge 流程再造】|第一条|第二条|详见工作台：http://reforge.local/work" {
		t.Fatalf("短消息应全部带上并附工作台链接: %d %v", used, lines)
	}
	if _, used := composeChannelMessage(nil); used != 0 {
		t.Fatalf("没有通知时不应带任何一条,得到 %d", used)
	}
	// 超长:一次带不完的留给下一轮,总字节数不超上限,单条按字符边界截断
	t.Setenv("FLOW_PUBLIC_URL", "")
	titles := make([]string, channelBatchSize*3)
	for i := range titles {
		titles[i] = "「很长很长的项目名称」的 G1 立项评审 已提交，" + strings.Repeat("说明", 60)
	}
	lines, used = composeChannelMessage(titles)
	total := 0
	for _, l := range lines {
		if !utf8.ValidString(l) {
			t.Fatalf("截断不应切坏多字节字符: %q", l)
		}
		total += len(l) + 1
	}
	if used == 0 || used >= len(titles) || used > channelBatchSize || total > channelMessageCap+channelLineCap+1 {
		t.Fatalf("超长通知应分批: used=%d total=%d", used, total)
	}
	if !strings.HasSuffix(lines[1], "…") || len(lines[1]) > channelLineCap+len("…") {
		t.Fatalf("超长的一行应被截断: %d 字节", len(lines[1]))
	}
	// 一条通知就有很多条时,一批最多带 channelBatchSize 条
	short := make([]string, 40)
	for i := range short {
		short[i] = "短通知"
	}
	if _, used := composeChannelMessage(short); used != channelBatchSize {
		t.Fatalf("一批最多 %d 条,得到 %d", channelBatchSize, used)
	}
}

func TestChannelMaskAndValidate(t *testing.T) {
	cases := map[string]string{
		"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123":                       "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****",
		"https://oapi.dingtalk.com/robot/send?access_token=tok&x=1":                         "https://oapi.dingtalk.com/robot/send?access_token=****&x=****",
		"https://open.feishu.cn/open-apis/bot/v2/hook/27f3bb62-aaaa-bbbb-cccc-000011112222": "https://open.feishu.cn/open-apis/bot/v2/hook/****",
		"": "",
	}
	for in, want := range cases {
		if got := maskWebhook(in); got != want {
			t.Errorf("maskWebhook(%q) = %q, want %q", in, got, want)
		}
	}
	if got := maskWebhook("不是地址?-secret=1"); !strings.HasSuffix(got, "?-secret=****") {
		t.Errorf("没有协议的地址也应打码查询串,得到 %q", got)
	}
	// 脱敏值传回修改接口时会被识别为"不改"
	if strings.Contains(maskWebhook("https://open.feishu.cn/open-apis/bot/v2/hook/27f3bb62-aaaa-bbbb-cccc-000011112222"), "27f3bb62") {
		t.Error("脱敏后不应残留凭据")
	}

	// 修改时传回脱敏值或留空 = 不改凭据;clearSecret 才清掉
	ch := &notifyChannel{Webhook: "https://x.test/send?key=real", Secret: "s3cret", SMTPPass: "pw", Kinds: []string{"overdue"}}
	name := "运维群"
	ch.apply(channelInput{Name: &name, Webhook: strp(maskWebhook(ch.Webhook)), Secret: strp(""), SMTPPass: strp(""), ClearSecret: boolp(true), Kinds: []string{}})
	if ch.Webhook != "https://x.test/send?key=real" || ch.Secret != "" || ch.SMTPPass != "pw" {
		t.Fatalf("凭据的保留 / 清除不符: %+v", ch)
	}
	ch.apply(channelInput{ClearPass: boolp(true), SMTPPass: strp("")})
	if ch.SMTPPass != "" {
		t.Fatalf("clearPass 应清掉邮箱口令: %+v", ch)
	}
	if len(ch.Kinds) != 0 {
		t.Fatalf("传空数组应把转发范围置空(保存时恢复默认): %+v", ch.Kinds)
	}
	ch.apply(channelInput{Kinds: nil})
	if len(ch.Kinds) != 0 {
		t.Fatal("kinds 缺省时不应改动")
	}

	// 校验:各类型的必填项与转发范围
	bot := &notifyChannel{Name: "群", Kind: ChWecom, Webhook: "https://qyapi.weixin.qq.com/send?key=1"}
	if err := validateChannel(bot); err != nil {
		t.Fatalf("合法的机器人渠道应通过: %v", err)
	}
	if strings.Join(bot.Kinds, ",") != strings.Join(defaultChannelKinds, ",") {
		t.Fatalf("未指定转发范围时应取默认集合: %v", bot.Kinds)
	}
	mail := &notifyChannel{Name: "邮件", Kind: ChEmail, SMTPHost: "smtp.example.com", SMTPPort: 465, SMTPFrom: "r@example.com",
		Recipients: "a@example.com, b@example.com;a@example.com", Kinds: []string{"overdue", "overdue"}}
	if err := validateChannel(mail); err != nil {
		t.Fatalf("合法的邮件渠道应通过: %v", err)
	}
	if mail.Recipients != "a@example.com, b@example.com" {
		t.Fatalf("收件人应规整: %q", mail.Recipients)
	}
	if strings.Join(mail.Kinds, ",") != "overdue" {
		t.Fatalf("转发范围应去重: %v", mail.Kinds)
	}
	bad := map[string]error{
		"没有名称":        validateChannel(&notifyChannel{Kind: ChWecom, Webhook: "https://a.test/x"}),
		"类型不合法":       validateChannel(&notifyChannel{Name: "x", Kind: "sms"}),
		"机器人没有地址":     validateChannel(&notifyChannel{Name: "x", Kind: ChDingTalk}),
		"机器人地址非 http": validateChannel(&notifyChannel{Name: "x", Kind: ChFeishu, Webhook: "ftp://a.test/x"}),
		"邮件没有服务器":     validateChannel(&notifyChannel{Name: "x", Kind: ChEmail}),
		"邮件没有发件人":     validateChannel(&notifyChannel{Name: "x", Kind: ChEmail, SMTPHost: "smtp.a.test", Recipients: "a@b.c"}),
		"邮件没有收件人":     validateChannel(&notifyChannel{Name: "x", Kind: ChEmail, SMTPHost: "smtp.a.test", SMTPFrom: "a@b.c"}),
		"收件箱格式不对":     validateChannel(&notifyChannel{Name: "x", Kind: ChEmail, SMTPHost: "smtp.a.test", SMTPFrom: "a@b.c", Recipients: "not-an-email"}),
		"未知通知类型":      validateChannel(&notifyChannel{Name: "x", Kind: ChWecom, Webhook: "https://a.test/x", Kinds: []string{"nope"}}),
	}
	for name, err := range bad {
		if err == nil {
			t.Errorf("%s: 应校验失败", name)
		}
	}
	// 目录里登记的类型必须与代码里实际发出的通知类型一致,否则后台勾不到、也校验不过
	for _, k := range append(append([]string{}, defaultChannelKinds...), recurringNotifyKinds...) {
		found := false
		for _, c := range notifyKindCatalog {
			found = found || c.Kind == k
		}
		if !found {
			t.Errorf("通知类型 %s 不在目录里", k)
		}
	}
	if got := strings.Join(splitRecipients(" a@x.com ;;b@x.com\nc@x.com,"), "|"); got != "a@x.com|b@x.com|c@x.com" {
		t.Fatalf("收件人拆分不符: %q", got)
	}
}

func strp(s string) *string { return &s }
