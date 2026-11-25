package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"time"
)

/*
日志系统(2026-11-25)。排查线上问题时,从浏览器到后端要经过 Cloudflare 隧道和前端容器,
这两层出了状况,服务器上看不到任何痕迹;界面上的失败提示又未必说得清原因。
所以把三处日志汇到后端的一条流里,看一处就够(docker logs flow-prod-backend):

	后端自身    每个请求一行(方法、路径、状态码、耗时、来源地址、登录人),失败的请求带上原因
	浏览器      页面报错、没接住的 Promise、失败的接口调用,由前端自动上报到 POST /api/logs
	Next 服务端 渲染与路由处理出错,由 frontend/instrumentation.ts 转发到同一个接口

开关(环境变量):
	FLOW_LOG_LEVEL   debug | info | warn | error,默认 info
	FLOW_LOG_FORMAT  text | json,默认 text(人直接读);要接采集系统时用 json

请求编号把一次请求在各处的记录串起来。后端收到请求时沿用前端带来的 X-Request-Id
(没有或不合法就自己生成),写回响应头,并放进这次请求的上下文——之后这次请求里所有的日志
都带 req=<编号>;界面上的失败提示也带同一个编号,用户报出来就能查。
前端上报失败的接口调用时用的也是这个编号,所以"请求到底到没到后端"grep 一下就知道:
	只有浏览器那一行        没到后端(断网,或被网关、隧道拦下)
	两行都有                看后端那一行的状态码与原因

不写进日志的东西:令牌、密码、Cookie、请求体。查询串会记,但键名像凭据的值会打码。
原有零散的 log.Printf 不用逐个改:slog.SetDefault 之后它们同样经过这里输出。
*/

const (
	requestIDHeader = "X-Request-Id"
	// clientLogsPath 浏览器与 Next 服务端上报日志的入口
	clientLogsPath = "/api/logs"
)

var (
	requestIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	// secretQueryKey 查询串里键名像凭据的,值一律打码
	secretQueryKey = regexp.MustCompile(`(?i)token|pass|secret|key|auth|credential|sign`)
	// quietGET 页面每 30 秒轮询一次的读接口:成功时降到 debug 级免得刷屏(失败照常记)
	quietGET = map[string]bool{
		"/api/notifications":  true,
		"/api/overview":       true,
		"/api/admin/overview": true,
		"/api/health":         true,
	}
	// slowRequest 超过这个耗时的请求按告警记
	slowRequest = 2 * time.Second
	// maxCapturedError 失败响应里最多截留多少字节,用来取出其中的错误说明
	maxCapturedError = 2048
)

// ---- 日志器 ----

// newLogger 按 FLOW_LOG_LEVEL / FLOW_LOG_FORMAT 建日志器。设为默认之后,
// 包里原有的 log.Printf 也会经它输出成同样格式的 info 行。
func newLogger() *slog.Logger {
	opts := &slog.HandlerOptions{Level: logLevel()}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("FLOW_LOG_FORMAT")), "json") {
		return slog.New(slog.NewJSONHandler(os.Stdout, opts))
	}
	return slog.New(slog.NewTextHandler(os.Stdout, opts))
}

func logLevel() slog.Level {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("FLOW_LOG_LEVEL"))) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func logFormat() string {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("FLOW_LOG_FORMAT")), "json") {
		return "json"
	}
	return "text"
}

// dbTarget 连接串里带口令,日志里只留"主机/库名"
func dbTarget(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil || u.Host == "" {
		return "PostgreSQL"
	}
	return u.Host + u.Path
}

// newHandler 生产与测试共用的中间件链。访问日志在最外层(记最终的状态码),
// panic 恢复在其内(恢复后写出的 500 才会被访问日志记到)。
func newHandler(mux http.Handler) http.Handler {
	return requestLog(recoverPanics(withSecurityHeaders(withCORS(mux))))
}

// ---- 请求编号与请求级日志器 ----

func newRequestID() string { return newID()[:16] }

// incomingRequestID 沿用请求带来的编号(前端给每次接口调用都生成了一个),没有或不合法才新建
func incomingRequestID(r *http.Request) string {
	if id := strings.TrimSpace(r.Header.Get(requestIDHeader)); requestIDRe.MatchString(id) {
		return id
	}
	return newRequestID()
}

type requestLoggerKey struct{}

// requestLogger 这次请求专用的日志器(带 req 编号);没经过访问日志中间件时退回默认日志器
func requestLogger(r *http.Request) *slog.Logger {
	if l, ok := r.Context().Value(requestLoggerKey{}).(*slog.Logger); ok && l != nil {
		return l
	}
	return slog.Default()
}

// audit 记一条操作审计:谁、做了什么、对象是谁。和同一次请求的访问日志靠 req 编号对应,
// 这里把登录人也写上,是为了只看审计行时不用再去对。
func audit(r *http.Request, action string, args ...any) {
	user := "-"
	if sd := sessions.get(bearerToken(r)); sd != nil {
		user = sd.Username
	}
	requestLogger(r).Info("audit", append([]any{"action", action, "user", user}, args...)...)
}

// ---- 访问日志 ----

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := incomingRequestID(r)
		r = r.WithContext(context.WithValue(r.Context(), requestLoggerKey{}, slog.Default().With(slog.String("req", id))))
		rw := &logResponseWriter{ResponseWriter: w}
		rw.Header().Set(requestIDHeader, id)
		// 登录人在请求开始时就认好:登录接口本身不带走来的令牌,那一条由登录处的审计行补上
		user, role := "", ""
		if sd := sessions.get(bearerToken(r)); sd != nil {
			user, role = sd.Username, sd.Role
		}
		next.ServeHTTP(rw, r)
		logRequest(r, rw, user, role, time.Since(start))
	})
}

// logResponseWriter 记下最终的状态码与响应体大小;失败响应(≥400)顺手截留开头的错误说明
type logResponseWriter struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
	errBody     []byte
}

func (w *logResponseWriter) WriteHeader(code int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader, w.status = true, code
	w.ResponseWriter.WriteHeader(code)
}

func (w *logResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += n
	if w.status >= 400 && len(w.errBody) < maxCapturedError {
		w.errBody = append(w.errBody, p[:min(n, maxCapturedError-len(w.errBody))]...)
	}
	return n, err
}

// Unwrap 让 http.ResponseController 能找到里面真正的 ResponseWriter(Flush 等能力不因包装而丢失)
func (w *logResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func logRequest(r *http.Request, rw *logResponseWriter, user, role string, took time.Duration) {
	if r.Method == http.MethodOptions { // 预检不是业务请求
		return
	}
	attrs := []any{
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Int("status", rw.status),
		slog.Duration("dur", took),
		slog.Int("bytes", rw.bytes),
		slog.String("ip", clientIPForLog(r)),
	}
	if r.URL.RawQuery != "" {
		attrs = append(attrs, slog.String("query", redactQuery(r.URL.RawQuery)))
	}
	if user != "" {
		attrs = append(attrs, slog.String("user", user), slog.String("role", role))
	}
	if ray := trimRunes(r.Header.Get("CF-Ray"), 40); ray != "" {
		attrs = append(attrs, slog.String("cf_ray", ray))
	}
	if msg := errorMessage(rw.errBody); msg != "" {
		attrs = append(attrs, slog.String("err", msg))
	}
	level := slog.LevelInfo
	switch {
	case rw.status >= 500:
		level = slog.LevelError
	case rw.status >= 400:
		level = slog.LevelWarn
	case isQuiet(r):
		level = slog.LevelDebug
	}
	if took >= slowRequest && level < slog.LevelWarn {
		level = slog.LevelWarn
		attrs = append(attrs, slog.Bool("slow", true))
	}
	requestLogger(r).Log(r.Context(), level, "request", attrs...)
}

// isQuiet 成功时不必逐条记的请求:高频轮询的读接口,以及日志上报本身
func isQuiet(r *http.Request) bool {
	if r.URL.Path == clientLogsPath {
		return true
	}
	return (r.Method == http.MethodGet || r.Method == http.MethodHead) && quietGET[r.URL.Path]
}

// errorMessage 从失败响应的开头取出 error 字段;不是 JSON 就退回原文
func errorMessage(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		return trimRunes(e.Error, 300)
	}
	return trimRunes(string(body), 300)
}

// clientIPForLog 日志里记的来源地址。有上游代理(Cloudflare 隧道、前端容器)时取它报告的访客地址,
// 否则是直连对端。只供排查参考,不参与限流与鉴权——那两个仍然只信 FLOW_TRUSTED_PROXY 配置的代理。
func clientIPForLog(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); net.ParseIP(ip) != nil {
		return ip
	}
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first := strings.TrimSpace(strings.Split(fwd, ",")[0]); net.ParseIP(first) != nil {
			return first
		}
	}
	return remoteHost(r)
}

// redactQuery 查询串原样记(都是筛选条件,排障用得上),但键名像凭据的值打码。键按字母序输出,同一请求每次都长得一样。
func redactQuery(raw string) string {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return "<无法解析>"
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(values))
	for _, key := range keys {
		if secretQueryKey.MatchString(key) {
			parts = append(parts, key+"=***")
			continue
		}
		for _, v := range values[key] {
			parts = append(parts, key+"="+v)
		}
	}
	return trimRunes(strings.Join(parts, "&"), 500)
}

// ---- panic 恢复 ----

// recoverPanics 处理函数 panic 时不让整个连接直接断掉:记下堆栈,给浏览器一个带请求编号的 500
func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler { // 中止响应的约定信号,照常交给 net/http 处理
				panic(v)
			}
			requestLogger(r).Error("panic", "err", fmt.Sprint(v), "method", r.Method, "path", r.URL.Path, "stack", string(debug.Stack()))
			// 响应头已经发出去了就没办法再改状态码
			if lw, ok := w.(*logResponseWriter); ok && lw.wroteHeader {
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "服务器内部错误，请稍后重试", "requestId": w.Header().Get(requestIDHeader),
			})
		}()
		next.ServeHTTP(w, r)
	})
}

// ---- 浏览器与 Next 服务端的日志上报 ----

const (
	clientLogsMaxBody    = 64 << 10 // 一批最多 64KB
	clientLogsMaxEntries = 20       // 一批最多 20 条
	clientLogsPerMinute  = 60       // 每个来源地址每分钟最多 60 批
)

var clientLogLimiter = newWindowLimiter(clientLogsPerMinute, time.Minute)

type clientLogEntry struct {
	Level   string `json:"level"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
	Page    string `json:"page"`
	UA      string `json:"ua"`
	Session string `json:"session"`
	TS      int64  `json:"ts"`
	Count   int    `json:"count"`
	// Tag 上报方自己分的类(渲染出错、资源加载失败、接口调用失败……),用来筛
	Tag string `json:"tag"`
	// Detail 一句话说不完的上下文(错误摘要、路由类型……)
	Detail  string `json:"detail"`
	Request *struct {
		Method    string `json:"method"`
		Path      string `json:"path"`
		Status    int    `json:"status"`
		RequestID string `json:"requestId"`
		Error     string `json:"error"`
	} `json:"request"`
}

// handleClientLogs POST /api/logs —— 收下浏览器与 Next 服务端上报的日志,原样写进后端日志流。
// 不要求登录(公开的收集表也会出错),所以有三道闸:限流、体积上限、逐字段截断。
// 内容一律当成不可信文本处理:不解析、不执行,长度与字符都有上限,slog 输出时会转义。
func handleClientLogs(limiter *windowLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !limiter.allowHit("clientlog:" + clientIP(r)) {
			writeError(w, http.StatusTooManyRequests, "上报过于频繁")
			return
		}
		var body struct {
			Source  string           `json:"source"`
			Entries []clientLogEntry `json:"entries"`
		}
		// 不拒绝未知字段:前端先于后端发版时,新加的字段不该让整批日志被丢掉
		err := json.NewDecoder(http.MaxBytesReader(w, r.Body, clientLogsMaxBody)).Decode(&body)
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(err, &tooBig):
			writeError(w, http.StatusRequestEntityTooLarge, "日志体积过大")
			return
		case err != nil:
			writeError(w, http.StatusBadRequest, "日志格式不正确")
			return
		case len(body.Entries) == 0:
			writeError(w, http.StatusBadRequest, "没有日志条目")
			return
		case len(body.Entries) > clientLogsMaxEntries:
			writeError(w, http.StatusRequestEntityTooLarge, "单批日志条数过多")
			return
		}
		if body.Source != "browser" && body.Source != "next-server" {
			body.Source = "browser"
		}
		// 谁报的以后端认出来的会话为准,不信上报里自己写的
		user := ""
		if sd := sessions.get(bearerToken(r)); sd != nil {
			user = sd.Username
		}
		for _, e := range body.Entries {
			emitClientLog(body.Source, e, user)
		}
		writeJSON(w, http.StatusAccepted, map[string]int{"accepted": len(body.Entries)})
	}
}

func emitClientLog(source string, e clientLogEntry, user string) {
	level := slog.LevelInfo
	switch strings.ToLower(e.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error", "fatal":
		level = slog.LevelError
	}
	// 刻意不用上报这次请求自己的日志器:那一行的 req 编号要留给"被上报的那次请求"
	l := slog.Default()
	attrs := []any{slog.String("source", "client:"+source), slog.String("page", clip(e.Page, 500))}
	if e.Tag != "" {
		attrs = append(attrs, slog.String("tag", clip(e.Tag, 40)))
	}
	if e.Detail != "" {
		attrs = append(attrs, slog.String("detail", clip(e.Detail, 500)))
	}
	if e.Session != "" {
		attrs = append(attrs, slog.String("session", clip(e.Session, 64)))
	}
	if user != "" {
		attrs = append(attrs, slog.String("user", user))
	}
	if e.Count > 1 {
		attrs = append(attrs, slog.Int("count", e.Count))
	}
	if e.UA != "" {
		attrs = append(attrs, slog.String("ua", clip(e.UA, 300)))
	}
	if e.Request != nil {
		// 页面级的报错只有一个编号(没有对应的接口调用),不写空的方法与路径
		if e.Request.Method != "" || e.Request.Path != "" {
			attrs = append(attrs, slog.String("http_method", clip(e.Request.Method, 10)), slog.Int("http_status", e.Request.Status), slog.String("http_path", clip(e.Request.Path, 500)))
		}
		if e.Request.Error != "" {
			attrs = append(attrs, slog.String("err", clip(e.Request.Error, 500)))
		}
		if requestIDRe.MatchString(e.Request.RequestID) {
			l = l.With(slog.String("req", e.Request.RequestID))
		}
	}
	if e.Stack != "" {
		attrs = append(attrs, slog.String("stack", clip(e.Stack, 4000)))
	}
	l.Log(context.Background(), level, clip(e.Message, 300), attrs...)
}

// clip 去掉换行、制表以外的控制字符(NUL、终端转义序列等),再按字符数截断
func clip(s string, max int) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 && r != '\n' && r != '\t' }) {
		return trimRunesKeep(s, max)
	}
	var b strings.Builder
	for _, r := range s {
		if r >= 0x20 || r == '\n' || r == '\t' {
			b.WriteRune(r)
		}
	}
	return trimRunesKeep(b.String(), max)
}

// trimRunesKeep 只截断、不去首尾空白(日志里的报错信息保留原样)
func trimRunesKeep(s string, max int) string {
	if n := len([]rune(s)); n > max {
		return string([]rune(s)[:max]) + "…"
	}
	return s
}
