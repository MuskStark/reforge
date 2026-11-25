package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// 外部通知渠道:把站内通知转发到企业微信 / 钉钉 / 飞书群机器人或邮箱。
// 渠道在后台配置(notify_channels,本文件),发送与投递在 channels_delivery.go:
// 转发在业务事务提交之后由后台任务完成——业务事务里不做网络调用,外部服务不可用也不影响业务写入。

const channelSchema = `
CREATE TABLE IF NOT EXISTS notify_channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  webhook      TEXT NOT NULL DEFAULT '',
  secret       TEXT NOT NULL DEFAULT '',
  smtp_host    TEXT NOT NULL DEFAULT '',
  smtp_port    INTEGER NOT NULL DEFAULT 465,
  smtp_user    TEXT NOT NULL DEFAULT '',
  smtp_pass    TEXT NOT NULL DEFAULT '',
  smtp_from    TEXT NOT NULL DEFAULT '',
  recipients   TEXT NOT NULL DEFAULT '',
  kinds        JSONB NOT NULL DEFAULT '[]',
  enabled      BOOLEAN NOT NULL DEFAULT true,
  kinds_since  TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01',
  last_error   TEXT NOT NULL DEFAULT '',
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);
-- 每个渠道对"一条逻辑通知"只处理一次;失败后的重试状态也记在这里
CREATE TABLE IF NOT EXISTS notify_deliveries (
  channel_id      TEXT NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  project_id      TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  day             TEXT NOT NULL DEFAULT '',
  sent_at         TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel_id, kind, project_id, title, day)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_retry ON notify_deliveries (channel_id, next_attempt_at)
  WHERE sent_at IS NULL AND next_attempt_at IS NOT NULL;`

// 渠道类型
const (
	ChWecom    = "wecom"
	ChDingTalk = "dingtalk"
	ChFeishu   = "feishu"
	ChEmail    = "email"
)

var validChannelKinds = map[string]bool{ChWecom: true, ChDingTalk: true, ChFeishu: true, ChEmail: true}

// notifyKindCatalog 全部站内通知类型(与 notifyTx / notifyManyTx 各调用处一一对应),后台按它勾选转发范围
var notifyKindCatalog = []struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}{
	{"project_created", "新流程提交"},
	{"review_submitted", "提交评审"},
	{"review_approved", "评审通过"},
	{"review_rejected", "评审驳回"},
	{"review_withdrawn", "评审撤回"},
	{"review_aging", "评审积压"},
	{"overdue", "逾期提醒"},
	{"update_due", "简报到期"},
	{"health", "健康度变化"},
	{"stage_rewound", "阶段回退"},
	{"stage_skipped", "阶段跳过"},
	{"project_status", "项目状态变更"},
	{"member_added", "成员加入"},
	{"item_assigned", "任务指派"},
	{"mentioned", "被 @ 提及"},
	{"commented", "任务有新评论"},
}

// defaultChannelKinds 新渠道默认转发的事件:节点性的、管理层关心的;指派 / 评论这类个人向的不进群
var defaultChannelKinds = []string{
	"project_created", "review_submitted", "review_approved", "review_rejected", "review_aging",
	"overdue", "stage_rewound", "stage_skipped", "project_status",
}

// recurringNotifyKinds 按天重复提醒的类型:站内通知的幂等键带日期,外部渠道同样每天只提醒一次
var recurringNotifyKinds = []string{"overdue", "review_aging", "update_due"}

const (
	maxChannelAttempts = 6
	channelHistoryDays = 7
	channelBatchSize   = 10
	channelMessageCap  = 1500 // 每条消息的正文上限(UTF-8 字节);企业微信文本消息上限 2048 字节
	channelLineCap     = 300
)

// retryBackoff 第 n 次失败后等多久再试;用完即放弃(记录留在 notify_deliveries 里)
var retryBackoff = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 3 * time.Hour}

type notifyChannel struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	Webhook    string   `json:"webhook"`
	Secret     string   `json:"secret"`
	SMTPHost   string   `json:"smtpHost"`
	SMTPPort   int      `json:"smtpPort"`
	SMTPUser   string   `json:"smtpUser"`
	SMTPPass   string   `json:"smtpPass"`
	SMTPFrom   string   `json:"smtpFrom"`
	Recipients string   `json:"recipients"`
	Kinds      []string `json:"kinds"`
	Enabled    bool     `json:"enabled"`
	// KindsSince 当前转发范围的生效时间:改了转发范围之后,不回放此前积压的旧通知
	KindsSince time.Time  `json:"kindsSince"`
	LastError  string     `json:"lastError"`
	LastSentAt *time.Time `json:"lastSentAt"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

const channelCols = `id, name, kind, webhook, secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, recipients,
	kinds, enabled, kinds_since, last_error, last_sent_at, created_at, updated_at`

func scanChannel(sc scanner) (*notifyChannel, error) {
	var ch notifyChannel
	var kinds []byte
	if err := sc.Scan(&ch.ID, &ch.Name, &ch.Kind, &ch.Webhook, &ch.Secret, &ch.SMTPHost, &ch.SMTPPort, &ch.SMTPUser,
		&ch.SMTPPass, &ch.SMTPFrom, &ch.Recipients, &kinds, &ch.Enabled, &ch.KindsSince, &ch.LastError, &ch.LastSentAt, &ch.CreatedAt, &ch.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(kinds, &ch.Kinds)
	if ch.Kinds == nil {
		ch.Kinds = []string{}
	}
	return &ch, nil
}

func listChannelsTx(ctx context.Context, q runner) ([]*notifyChannel, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+channelCols+` FROM notify_channels ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*notifyChannel{}
	for rows.Next() {
		ch, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ch)
	}
	return out, rows.Err()
}

func getChannel(ctx context.Context, q runner, id string) (*notifyChannel, error) {
	ch, err := scanChannel(q.QueryRowContext(ctx, `SELECT `+channelCols+` FROM notify_channels WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return ch, err
}

// ---- 后台接口(仅系统管理员) ----

func registerChannelRoutes(mux *http.ServeMux, st *postgresStore) {
	mux.HandleFunc("GET /api/admin/notify-channels", st.handleListChannels)
	mux.HandleFunc("POST /api/admin/notify-channels", st.handleCreateChannel)
	mux.HandleFunc("PATCH /api/admin/notify-channels/{id}", st.handleUpdateChannel)
	mux.HandleFunc("DELETE /api/admin/notify-channels/{id}", st.handleDeleteChannel)
	mux.HandleFunc("POST /api/admin/notify-channels/{id}/test", st.handleTestChannel)
}

const redacted = "****"

// channelView 对外返回的渠道:Webhook 地址与口令是凭据,脱敏后返回(只说明是否已设置)
func channelView(ch *notifyChannel) map[string]any {
	return map[string]any{
		"id": ch.ID, "name": ch.Name, "kind": ch.Kind,
		"webhook": maskWebhook(ch.Webhook), "secretSet": ch.Secret != "",
		"smtpHost": ch.SMTPHost, "smtpPort": ch.SMTPPort, "smtpUser": ch.SMTPUser, "smtpPassSet": ch.SMTPPass != "",
		"smtpFrom": ch.SMTPFrom, "recipients": ch.Recipients, "kinds": ch.Kinds, "enabled": ch.Enabled,
		"lastError": ch.LastError, "lastSentAt": ch.LastSentAt, "createdAt": ch.CreatedAt, "updatedAt": ch.UpdatedAt,
	}
}

func (s *postgresStore) handleListChannels(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	list, err := listChannelsTx(r.Context(), s.db)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, ch := range list {
		out = append(out, channelView(ch))
	}
	writeJSON(w, http.StatusOK, map[string]any{"list": out, "kinds": notifyKindCatalog, "defaultKinds": defaultChannelKinds})
}

func (s *postgresStore) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var in channelInput
	if err := decodeJSON(w, r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	now := time.Now()
	ch := &notifyChannel{ID: newID(), SMTPPort: 465, Kinds: append([]string{}, defaultChannelKinds...), Enabled: true,
		CreatedAt: now, UpdatedAt: now, KindsSince: now}
	ch.apply(in)
	if err := validateChannel(ch); err != nil {
		writeErr(w, r, err)
		return
	}
	kinds, _ := json.Marshal(ch.Kinds)
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO notify_channels
		(id, name, kind, webhook, secret, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, recipients, kinds, enabled,
		 kinds_since, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16)`,
		ch.ID, ch.Name, ch.Kind, ch.Webhook, ch.Secret, ch.SMTPHost, ch.SMTPPort, ch.SMTPUser, ch.SMTPPass, ch.SMTPFrom,
		ch.Recipients, string(kinds), ch.Enabled, now, now, now); err != nil {
		writeErr(w, r, err)
		return
	}
	audit(r, "channel.create", "target", ch.Name, "kind", ch.Kind, "enabled", ch.Enabled)
	writeJSON(w, http.StatusCreated, channelView(ch))
}

func (s *postgresStore) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var in channelInput
	if err := decodeJSON(w, r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "请求数据格式不正确")
		return
	}
	ch, err := getChannel(r.Context(), s.db, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if ch == nil {
		writeError(w, http.StatusNotFound, "渠道不存在")
		return
	}
	ch.apply(in)
	if err := validateChannel(ch); err != nil {
		writeErr(w, r, err)
		return
	}
	kinds, _ := json.Marshal(ch.Kinds)
	if _, err := s.db.ExecContext(r.Context(), `UPDATE notify_channels SET
		name = $2, kind = $3, webhook = $4, secret = $5, smtp_host = $6, smtp_port = $7, smtp_user = $8, smtp_pass = $9,
		smtp_from = $10, recipients = $11, kinds = $12::jsonb, enabled = $13, kinds_since = $14, updated_at = now() WHERE id = $1`,
		ch.ID, ch.Name, ch.Kind, ch.Webhook, ch.Secret, ch.SMTPHost, ch.SMTPPort, ch.SMTPUser, ch.SMTPPass,
		ch.SMTPFrom, ch.Recipients, string(kinds), ch.Enabled, ch.KindsSince); err != nil {
		writeErr(w, r, err)
		return
	}
	ch.UpdatedAt = time.Now()
	// 渠道地址与密钥会在这里被换掉,必须留痕;密钥本身不进日志,只记"是否改了"
	audit(r, "channel.update", "target", ch.Name, "kind", ch.Kind, "enabled", ch.Enabled, "secret_changed", in.Secret != nil || in.ClearSecret != nil)
	writeJSON(w, http.StatusOK, channelView(ch))
}

func (s *postgresStore) handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	ch, err := getChannel(r.Context(), s.db, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if ch == nil {
		writeError(w, http.StatusNotFound, "渠道不存在")
		return
	}
	// 投递记录随渠道级联删除
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM notify_channels WHERE id = $1`, ch.ID); err != nil {
		writeErr(w, r, err)
		return
	}
	audit(r, "channel.delete", "target", ch.Name, "kind", ch.Kind)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleTestChannel 发一条测试消息,同步返回结果,方便管理员确认机器人 / 邮箱配置是否可用
func (s *postgresStore) handleTestChannel(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	ch, err := getChannel(r.Context(), s.db, pathID(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if ch == nil {
		writeError(w, http.StatusNotFound, "渠道不存在")
		return
	}
	n, err := notifierFor(ch)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	lines, _ := composeChannelMessage([]string{"通知渠道「" + ch.Name + "」测试消息：配置成功，之后这里会收到项目的关键动态。"})
	if err := n.Send(ctx, lines); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// channelInput 创建 / 修改渠道的请求体。指针字段区分"没传"与"传了空";
// Webhook / 密钥 / 口令传回脱敏值或留空都表示"不改"。
type channelInput struct {
	Name        *string  `json:"name"`
	Kind        *string  `json:"kind"`
	Webhook     *string  `json:"webhook"`
	Secret      *string  `json:"secret"`
	ClearSecret *bool    `json:"clearSecret"`
	SMTPHost    *string  `json:"smtpHost"`
	SMTPPort    *int     `json:"smtpPort"`
	SMTPUser    *string  `json:"smtpUser"`
	SMTPPass    *string  `json:"smtpPass"`
	ClearPass   *bool    `json:"clearPass"`
	SMTPFrom    *string  `json:"smtpFrom"`
	Recipients  *string  `json:"recipients"`
	Kinds       []string `json:"kinds"`
	Enabled     *bool    `json:"enabled"`
}

// apply 把请求体合到渠道上
func (ch *notifyChannel) apply(in channelInput) {
	if in.Name != nil {
		ch.Name = trimRunes(*in.Name, 40)
	}
	if in.Kind != nil {
		ch.Kind = strings.TrimSpace(*in.Kind)
	}
	if in.Webhook != nil && !strings.Contains(*in.Webhook, redacted) {
		ch.Webhook = strings.TrimSpace(*in.Webhook)
	}
	if in.Secret != nil && strings.TrimSpace(*in.Secret) != "" {
		ch.Secret = strings.TrimSpace(*in.Secret)
	}
	if in.ClearSecret != nil && *in.ClearSecret {
		ch.Secret = ""
	}
	if in.SMTPHost != nil {
		ch.SMTPHost = strings.TrimSpace(*in.SMTPHost)
	}
	if in.SMTPPort != nil {
		ch.SMTPPort = *in.SMTPPort
	}
	if in.SMTPUser != nil {
		ch.SMTPUser = strings.TrimSpace(*in.SMTPUser)
	}
	if in.SMTPPass != nil && *in.SMTPPass != "" {
		ch.SMTPPass = *in.SMTPPass
	}
	if in.ClearPass != nil && *in.ClearPass {
		ch.SMTPPass = ""
	}
	if in.SMTPFrom != nil {
		ch.SMTPFrom = strings.TrimSpace(*in.SMTPFrom)
	}
	if in.Recipients != nil {
		ch.Recipients = *in.Recipients
	}
	// kinds 缺省 = 不改;传空数组 = 恢复默认转发范围
	if in.Kinds != nil {
		ch.Kinds, ch.KindsSince = in.Kinds, time.Now()
	}
	if in.Enabled != nil {
		ch.Enabled = *in.Enabled
	}
}

// validateChannel 保存前校验:按类型检查必填项,规整转发范围
func validateChannel(ch *notifyChannel) error {
	if ch.Name == "" {
		return badRequest("请填写渠道名称")
	}
	if !validChannelKinds[ch.Kind] {
		return badRequest("渠道类型不合法")
	}
	if ch.Kind == ChEmail {
		if ch.SMTPHost == "" || ch.SMTPPort < 1 || ch.SMTPPort > 65535 {
			return badRequest("请填写邮件服务器地址与端口")
		}
		if ch.SMTPFrom == "" {
			return badRequest("请填写发件人地址")
		}
		to, seenTo := []string{}, map[string]bool{}
		for _, rcpt := range splitRecipients(ch.Recipients) {
			if !seenTo[rcpt] {
				seenTo[rcpt] = true
				to = append(to, rcpt)
			}
		}
		if len(to) == 0 {
			return badRequest("请至少填写一个收件邮箱")
		}
		if len(to) > 20 {
			return badRequest("收件邮箱最多 20 个")
		}
		for _, rcpt := range to {
			if !strings.Contains(rcpt, "@") || strings.ContainsAny(rcpt, " \t\r\n,<>()") {
				return badRequest("收件邮箱格式不正确：" + rcpt)
			}
		}
		ch.Recipients = strings.Join(to, ", ")
	} else {
		u, err := url.Parse(ch.Webhook)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return badRequest("请填写正确的机器人 Webhook 地址（http / https）")
		}
	}
	valid := map[string]bool{}
	for _, k := range notifyKindCatalog {
		valid[k.Kind] = true
	}
	kinds := []string{}
	seen := map[string]bool{}
	for _, k := range ch.Kinds {
		if !valid[k] {
			return badRequest("未知的通知类型：" + k)
		}
		if !seen[k] {
			seen[k] = true
			kinds = append(kinds, k)
		}
	}
	if len(kinds) == 0 {
		kinds = append(kinds, defaultChannelKinds...)
	}
	ch.Kinds = kinds
	return nil
}

// maskWebhook 只保留协议、主机与路径,查询参数的值全部打码(机器人的 key / token 就在里面)
func maskWebhook(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		if i := strings.Index(raw, "?"); i >= 0 {
			return raw[:i+1] + redacted
		}
		return raw
	}
	values := u.Query()
	parts := make([]string, 0, len(values))
	for k := range values {
		parts = append(parts, url.QueryEscape(k)+"="+redacted)
	}
	sort.Strings(parts)
	u.RawQuery = strings.Join(parts, "&")
	// 飞书这类机器人的凭据在路径的最后一段里:长的那一段也打码
	if i := strings.LastIndexByte(u.Path, '/'); i >= 0 && len(u.Path[i+1:]) >= 16 {
		u.Path, u.RawPath = u.Path[:i+1]+redacted, u.Path[:i+1]+redacted
	}
	return u.String()
}
