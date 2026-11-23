package main

import (
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ---- 安全加固(docs/security-audit.md)----
// S1 请求体大小上限:防 JSON 炸弹/内存耗尽
// S2 登录限流:防口令暴破(按 IP+账号,失败锁定)
// S3 公开提交限流:防匿名灌库
// S4 安全响应头 + API 不缓存
// S5 服务器超时:防 slowloris

const maxBodyBytes = 1 << 20 // 1MB(流程 JSON 足够)

// ---- S2/S3 限流器(内存实现,单实例部署足够;多实例时应换 Redis) ----

type failWindow struct {
	count    int
	lastFail time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*failWindow
	limit   int
	window  time.Duration
	lockFor time.Duration
}

func newRateLimiter(limit int, window, lockFor time.Duration) *rateLimiter {
	return &rateLimiter{entries: map[string]*failWindow{}, limit: limit, window: window, lockFor: lockFor}
}

// allow 检查是否放行(未锁定);hit 记一次失败
func (rl *rateLimiter) allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	e, ok := rl.entries[key]
	if !ok {
		return true
	}
	// 锁定期内直接拒绝
	if e.count >= rl.limit && time.Since(e.lastFail) < rl.lockFor {
		return false
	}
	// 窗口外重置
	if time.Since(e.lastFail) > rl.window {
		delete(rl.entries, key)
	}
	return true
}

func (rl *rateLimiter) hit(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	key = normalizeKey(key) // F06:键长受控
	e, ok := rl.entries[key]
	if !ok || time.Since(e.lastFail) > rl.window {
		// F06:硬上限 2 万键——先清过期,仍超则淘汰最旧
		if len(rl.entries) >= 20_000 {
			for k, v := range rl.entries {
				if time.Since(v.lastFail) > rl.window {
					delete(rl.entries, k)
				}
			}
			for len(rl.entries) >= 20_000 {
				var oldestKey string
				var oldest time.Time
				first := true
				for k, v := range rl.entries {
					if first || v.lastFail.Before(oldest) {
						oldestKey, oldest, first = k, v.lastFail, false
					}
				}
				delete(rl.entries, oldestKey)
			}
		}
		e = &failWindow{}
		rl.entries[key] = e
	}
	e.count++
	e.lastFail = time.Now()
}

var (
	loginLimiter = newRateLimiter(5, 15*time.Minute, 15*time.Minute) // 登录:15 分钟 5 次失败即锁
	// F01:账号维度兜底计数——IP 轮换(或伪造)无法重置同一用户名的失败累计
	loginAccountLimiter = newRateLimiter(10, 15*time.Minute, 15*time.Minute)
	// F02:固定窗口计数器(每次尝试都计数),匿名提交 20 次/分钟
	submitWindow = newWindowLimiter(20, time.Minute)
)

// ---- F02:固定窗口限流器(总量计数,非失败计数) ----
type windowEntry struct {
	count  int
	window int64 // unix 秒
}

type windowLimiter struct {
	mu      sync.Mutex
	entries map[string]*windowEntry
	limit   int
	span    int64 // 窗口秒数
	maxKeys int
}

func newWindowLimiter(limit int, span time.Duration) *windowLimiter {
	return &windowLimiter{entries: map[string]*windowEntry{}, limit: limit,
		span: int64(span.Seconds()), maxKeys: 20000}
}

// allowHit 原子地「检查+计数」:窗口内超限返回 false
func (wl *windowLimiter) allowHit(key string) bool {
	wl.mu.Lock()
	defer wl.mu.Unlock()
	now := time.Now().Unix()
	key = normalizeKey(key)
	e, ok := wl.entries[key]
	if !ok || now-e.window >= wl.span {
		// 容量治理(F06 同源):超上限先清过期
		if len(wl.entries) >= wl.maxKeys {
			for k, v := range wl.entries {
				if now-v.window >= wl.span {
					delete(wl.entries, k)
				}
			}
			if len(wl.entries) >= wl.maxKeys {
				return false // 极端下拒绝新键,保护内存
			}
		}
		wl.entries[key] = &windowEntry{count: 1, window: now}
		return true
	}
	e.count++
	return e.count <= wl.limit
}

// normalizeKey(F06):限流键统一截断到 96 字节
func normalizeKey(k string) string {
	if len(k) > 96 {
		return k[:96]
	}
	return k
}

// ---- F01 修复:受信代理门控的 clientIP ----
// 默认(未配置 FLOW_TRUSTED_PROXY)一律使用 r.RemoteAddr,客户端伪造 XFF 无效;
// 配置了 CIDR 白名单时,仅当直连对端是受信代理才解析 XFF,并取「最右非受信跳」。

var trustedProxies = parseCIDRs(os.Getenv("FLOW_TRUSTED_PROXY"))

func parseCIDRs(csv string) []*net.IPNet {
	var nets []*net.IPNet
	for _, c := range splitCSV(csv) {
		if !strings.Contains(c, "/") {
			c += "/32"
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}

func remoteHost(r *http.Request) string {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

func isTrustedProxy(ip string) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	for _, n := range trustedProxies {
		if n.Contains(p) {
			return true
		}
	}
	return false
}

// clientIP:仅受信代理链下解析 XFF(从右往左跳过受信代理,取第一个非受信地址)
func clientIP(r *http.Request) string {
	remote := remoteHost(r)
	if !isTrustedProxy(remote) {
		return normalizeIPKey(remote)
	}
	fwd := r.Header.Get("X-Forwarded-For")
	parts := strings.Split(fwd, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		ip := trimSpaceStr(parts[i])
		if ip == "" || !isTrustedProxy(ip) {
			if net.ParseIP(ip) != nil {
				return normalizeIPKey(ip)
			}
		}
	}
	return normalizeIPKey(remote)
}

// normalizeIPKey(F06):键规范化,IPv6 文本上限 45 字符
func normalizeIPKey(ip string) string {
	if len(ip) > 45 {
		return ip[:45]
	}
	return ip
}

func trimSpaceStr(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// ---- S4 安全响应头 + API no-store ----

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/api" {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ---- CORS(收紧:默认同源走 Next 代理,不再放开 *)----

// withCORS 仅在 FLOW_ALLOWED_ORIGIN 设置时放行对应来源(逗号分隔);
// 默认空 = 不发送任何 CORS 头(浏览器同源策略生效)。
func withCORS(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range splitCSV(os.Getenv("FLOW_ALLOWED_ORIGIN")) {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func splitCSV(s string) []string {
	var out []string
	cur := ""
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			t := trimSpaceStr(cur)
			if t != "" {
				out = append(out, t)
			}
			cur = ""
			continue
		}
		cur += string(s[i])
	}
	return out
}

// dateRegex 目标完成日格式(YYYY-MM-DD)
var dateRegex = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// validDate 严格校验日期格式与真实日历日
func validDate(s string) bool {
	if !dateRegex.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

// validLevel 分析枚举(高/中/低;空值归一为"中")
func normalizeLevel(s string) string {
	switch s {
	case "高", "中", "低":
		return s
	default:
		return "中"
	}
}
