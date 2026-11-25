package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"runtime/debug"
	"strings"
	"time"
	"unicode/utf8"
)

// ---- 发送端:每种渠道一个 notifier ----

// notifier 外部通知渠道的发送接口;接入新渠道只要实现它并在 notifierFor 里登记
type notifier interface {
	Send(ctx context.Context, lines []string) error
}

var httpClient = &http.Client{Timeout: 8 * time.Second}

func notifierFor(ch *notifyChannel) (notifier, error) {
	switch ch.Kind {
	case ChWecom, ChDingTalk, ChFeishu:
		return botNotifier{kind: ch.Kind, webhook: ch.Webhook, secret: ch.Secret}, nil
	case ChEmail:
		return smtpNotifier{
			host: ch.SMTPHost, port: ch.SMTPPort, user: ch.SMTPUser, pass: ch.SMTPPass,
			from: ch.SMTPFrom, to: splitRecipients(ch.Recipients),
		}, nil
	}
	return nil, badRequest("不支持的渠道类型")
}

// botNotifier 群机器人:企业微信 / 钉钉 / 飞书的 Incoming Webhook 都是"POST 一段 JSON 文本消息"
type botNotifier struct {
	kind, webhook, secret string
}

func (b botNotifier) Send(ctx context.Context, lines []string) error {
	content := strings.Join(lines, "\n")
	var payload any
	endpoint := b.webhook
	body := map[string]string{"content": content}
	switch b.kind {
	case ChWecom:
		payload = map[string]any{"msgtype": "text", "text": body}
	case ChDingTalk:
		payload = map[string]any{"msgtype": "text", "text": body}
		if b.secret != "" {
			ts := time.Now().UnixMilli()
			endpoint = withQuery(endpoint, url.Values{"timestamp": {fmt.Sprint(ts)}, "sign": {dingTalkSign(ts, b.secret)}})
		}
	case ChFeishu:
		payload = map[string]any{"msg_type": "text", "content": body}
		if b.secret != "" {
			ts := time.Now().Unix()
			payload = map[string]any{"msg_type": "text", "content": body, "timestamp": fmt.Sprint(ts), "sign": feishuSign(ts, b.secret)}
		}
	default:
		return errors.New("不支持的机器人类型")
	}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return errors.New("Webhook 地址不正确")
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return errors.New("连接机器人失败：" + shortErr(err))
	}
	defer res.Body.Close()
	var out struct {
		ErrCode    *float64 `json:"errcode"` // 企业微信 / 钉钉
		ErrMsg     string   `json:"errmsg"`
		Code       *float64 `json:"code"` // 飞书
		Msg        string   `json:"msg"`
		StatusCode *float64 `json:"StatusCode"` // 飞书旧版接口
		StatusMsg  string   `json:"StatusMessage"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(nil, res.Body, 4096)).Decode(&out)
	failed := res.StatusCode < 200 || res.StatusCode >= 300
	for _, c := range []*float64{out.ErrCode, out.Code, out.StatusCode} {
		if c != nil && *c != 0 {
			failed = true
		}
	}
	if !failed {
		return nil
	}
	msg := firstNonEmpty(out.ErrMsg, out.Msg, out.StatusMsg, res.Status)
	return fmt.Errorf("机器人拒绝了消息：%s", trimRunes(msg, 120))
}

// dingTalkSign 钉钉加签:HmacSHA256(key = 密钥, msg = 时间戳 + "\n" + 密钥)后 Base64。
// 返回未编码的签名:放进查询串时的 URL 编码由 withQuery 统一做,这里再编一次就成了双重编码。
func dingTalkSign(millis int64, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d\n%s", millis, secret)))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// feishuSign 飞书签名校验:key = 时间戳 + "\n" + 密钥,msg 为空
func feishuSign(seconds int64, secret string) string {
	mac := hmac.New(sha256.New, []byte(fmt.Sprintf("%d\n%s", seconds, secret)))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// withQuery 在地址上追加查询参数(钉钉加签用)
func withQuery(raw string, q url.Values) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	values := u.Query()
	for k, vs := range q {
		for _, v := range vs {
			values.Add(k, v)
		}
	}
	u.RawQuery = values.Encode()
	return u.String()
}

// smtpNotifier 邮件:465 走 SSL,其余端口在服务器支持时升级 STARTTLS
type smtpNotifier struct {
	host string
	port int
	user string
	pass string
	from string
	to   []string
}

func (n smtpNotifier) Send(ctx context.Context, lines []string) error {
	if len(n.to) == 0 {
		return errors.New("没有收件人")
	}
	addr := fmt.Sprintf("%s:%d", n.host, n.port)
	dialer := net.Dialer{Timeout: 10 * time.Second}
	var conn net.Conn
	var err error
	if n.port == 465 {
		conn, err = tls.DialWithDialer(&dialer, "tcp", addr, &tls.Config{ServerName: n.host})
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return errors.New("连接邮件服务器失败：" + shortErr(err))
	}
	c, err := smtp.NewClient(conn, n.host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if n.port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: n.host}); err != nil {
				return errors.New("STARTTLS 失败：" + shortErr(err))
			}
		}
	}
	if n.user != "" {
		if err := c.Auth(smtp.PlainAuth("", n.user, n.pass, n.host)); err != nil {
			return errors.New("邮箱登录失败：" + shortErr(err))
		}
	}
	if err := c.Mail(n.from); err != nil {
		return errors.New("发件人被拒绝：" + shortErr(err))
	}
	for _, rcpt := range n.to {
		if err := c.Rcpt(rcpt); err != nil {
			return errors.New("收件人被拒绝：" + shortErr(err))
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(mailMessage(n.from, n.to, mailSubject(lines), lines)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return errors.New("邮件正文被拒绝：" + shortErr(err))
	}
	return c.Quit()
}

// splitRecipients 逗号 / 分号 / 换行分隔的收件人
func splitRecipients(s string) []string {
	out := []string{}
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == '\n' || r == '\r' }) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// mailSubject 首行是标头,末行在配置了站点地址时是工作台链接,其余每行是一条通知
func mailSubject(lines []string) string {
	subject := lines[0]
	if len(lines) > 1 {
		body := lines[1:]
		if strings.HasPrefix(body[len(body)-1], "详见工作台") {
			body = body[:len(body)-1]
		}
		if len(body) > 0 {
			subject += " " + trimRunes(body[0], 40)
			if len(body) > 1 {
				subject += fmt.Sprintf(" 等 %d 条", len(body))
			}
		}
	}
	return subject
}

// mailMessage 组装一封 UTF-8 邮件(标题与正文都按 RFC 2047 / base64 编码)
func mailMessage(from string, to []string, subject string, lines []string) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
		from, strings.Join(to, ", "), "=?UTF-8?B?"+base64.StdEncoding.EncodeToString([]byte(subject))+"?=")
	enc := base64.StdEncoding.EncodeToString([]byte(strings.Join(lines, "\r\n")))
	for len(enc) > 76 {
		b.WriteString(enc[:76])
		b.WriteString("\r\n")
		enc = enc[76:]
	}
	b.WriteString(enc)
	b.WriteString("\r\n")
	return b.Bytes()
}

func shortErr(err error) string { return trimRunes(err.Error(), 160) }

// ---- 投递:后台任务把站内通知转发到外部渠道 ----

// composeChannelMessage 把一批通知拼成一条消息:标头 + 每条一行 + 工作台链接。
// 超过长度上限的部分留给下一轮;返回正文行数与实际带上的通知条数。
func composeChannelMessage(titles []string) ([]string, int) {
	header := "【ReForge 流程再造】"
	lines := []string{header}
	total := len(header)
	used := 0
	for _, t := range titles {
		line := cutBytes(t, channelLineCap)
		if used > 0 && total+len(line) > channelMessageCap {
			break
		}
		lines = append(lines, line)
		total += len(line) + 1
		used++
		if used >= channelBatchSize {
			break
		}
	}
	if base := strings.TrimRight(os.Getenv("FLOW_PUBLIC_URL"), "/"); base != "" {
		lines = append(lines, "详见工作台："+base+"/work")
	}
	return lines, used
}

// cutBytes 按 UTF-8 字节数截断,不切断多字节字符
func cutBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// channelItem 一条待发的逻辑通知(同一件事发给多个人只算一条)
type channelItem struct {
	kind, projectID, title, day string
	attempts                    int
}

// dueForChannel 这个渠道此刻该发的通知:先补发上次失败后到了重试时间的,
// 再取"建立渠道(或最近一次改转发范围)之后"产生的新通知——新渠道、新范围都不回放积压的旧通知
func dueForChannel(ctx context.Context, q runner, ch *notifyChannel) ([]channelItem, error) {
	out := []channelItem{}
	since := ch.CreatedAt
	if ch.KindsSince.After(since) {
		since = ch.KindsSince
	}
	rrows, err := q.QueryContext(ctx, `SELECT kind, project_id, title, day, attempts FROM notify_deliveries
		WHERE channel_id = $1 AND sent_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
		ORDER BY next_attempt_at LIMIT $2`, ch.ID, channelBatchSize)
	if err != nil {
		return nil, err
	}
	for rrows.Next() {
		var it channelItem
		if err := rrows.Scan(&it.kind, &it.projectID, &it.title, &it.day, &it.attempts); err != nil {
			rrows.Close()
			return nil, err
		}
		out = append(out, it)
	}
	rrows.Close()
	if err := rrows.Err(); err != nil {
		return nil, err
	}
	if len(out) >= channelBatchSize {
		return out, nil
	}
	// 同一件事会给每个相关的人各写一条站内通知:按(类型, 项目, 标题)归并,只发一条到群里
	nrows, err := q.QueryContext(ctx, `WITH fresh AS (
		SELECT n.kind, COALESCE(n.project_id,'') AS project_id, n.title, min(n.created_at) AS at
		FROM notifications n
		WHERE n.created_at >= $2 AND n.created_at > now() - interval '7 days' AND n.kind = ANY($3)
		GROUP BY n.kind, COALESCE(n.project_id,''), n.title
	)
	SELECT f.kind, f.project_id, f.title,
		CASE WHEN f.kind = ANY($4) THEN to_char(f.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') ELSE '' END
	FROM fresh f
	WHERE NOT EXISTS (SELECT 1 FROM notify_deliveries d
		WHERE d.channel_id = $1 AND d.kind = f.kind AND d.project_id = f.project_id AND d.title = f.title
		  AND d.day = CASE WHEN f.kind = ANY($4) THEN to_char(f.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') ELSE '' END)
	ORDER BY f.at LIMIT $5`, ch.ID, since, ch.Kinds, recurringNotifyKinds, channelBatchSize-len(out))
	if err != nil {
		return nil, err
	}
	for nrows.Next() {
		var it channelItem
		if err := nrows.Scan(&it.kind, &it.projectID, &it.title, &it.day); err != nil {
			nrows.Close()
			return nil, err
		}
		out = append(out, it)
	}
	nrows.Close()
	return out, nrows.Err()
}

// recordDelivery 记下这一批的处理结果:成功记发送时间;失败累计次数,按退避安排下一次,用完次数即放弃
func recordDelivery(ctx context.Context, q runner, channelID string, it channelItem, now time.Time, sendErr error) error {
	var sentAt, next any
	lastError := ""
	if sendErr == nil {
		sentAt = now
	} else if it.attempts < len(retryBackoff) {
		next, lastError = now.Add(retryBackoff[it.attempts]), "发送失败："+shortErr(sendErr)
	} else {
		lastError = "已放弃重试：" + shortErr(sendErr)
	}
	_, err := q.ExecContext(ctx, `INSERT INTO notify_deliveries
		(channel_id, kind, project_id, title, day, sent_at, attempts, next_attempt_at, last_error)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (channel_id, kind, project_id, title, day) DO UPDATE SET
			sent_at = EXCLUDED.sent_at, attempts = EXCLUDED.attempts,
			next_attempt_at = EXCLUDED.next_attempt_at, last_error = EXCLUDED.last_error`,
		channelID, it.kind, it.projectID, it.title, it.day, sentAt, it.attempts+1, next, lastError)
	return err
}

// deliverChannels 把各启用渠道此刻该发的通知发出去。由后台任务周期调用,测试里直接调用。
func deliverChannels(ctx context.Context, st *postgresStore) error {
	channels, err := listChannelsTx(ctx, st.db)
	if err != nil {
		return err
	}
	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		items, err := dueForChannel(ctx, st.db, ch)
		if err != nil {
			return err
		}
		if len(items) == 0 {
			continue
		}
		titles := make([]string, len(items))
		for i, it := range items {
			titles[i] = it.title
		}
		n, err := notifierFor(ch)
		var sendErr error
		lines, used := []string{}, 0
		if err != nil {
			sendErr = err
		} else {
			lines, used = composeChannelMessage(titles)
			sendErr = n.Send(ctx, lines)
		}
		// 正文放不下的通知不记结果,下一轮接着发
		if sendErr == nil && used < len(items) {
			items = items[:used]
		}
		now := time.Now()
		err = st.withTx(ctx, func(tx *sql.Tx) error {
			for _, it := range items {
				if err := recordDelivery(ctx, tx, ch.ID, it, now, sendErr); err != nil {
					return err
				}
			}
			_, err := tx.ExecContext(ctx, `UPDATE notify_channels SET last_error = $2,
				last_sent_at = CASE WHEN $3 THEN $4 ELSE last_sent_at END WHERE id = $1`,
				ch.ID, channelErrText(sendErr), sendErr == nil, now)
			return err
		})
		if err != nil {
			return err
		}
		if sendErr != nil {
			slog.Warn("外部通知发送失败", "channel", ch.Name, "kind", ch.Kind, "count", len(items), "err", sendErr)
		}
	}
	return nil
}

func channelErrText(err error) string {
	if err == nil {
		return ""
	}
	return "发送失败：" + shortErr(err)
}

// startChannelDelivery 每 15 秒转发一次。单实例部署;重复投递由 notify_deliveries 的主键挡住。
func startChannelDelivery(st *postgresStore) {
	go func() {
		time.Sleep(5 * time.Second) // 启动后稍等,让 HTTP 服务先就绪
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for ; true; <-ticker.C {
			func() {
				defer func() {
					if v := recover(); v != nil {
						slog.Error("外部通知转发 panic", "err", fmt.Sprint(v), "stack", string(debug.Stack()))
					}
				}()
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				defer cancel()
				if err := deliverChannels(ctx, st); err != nil {
					slog.Error("外部通知转发失败", "err", err)
				}
			}()
		}
	}()
}
