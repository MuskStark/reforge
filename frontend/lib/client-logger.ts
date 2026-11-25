/**
 * 浏览器端日志:页面报错、没接住的 Promise、资源加载失败、失败的接口调用,自动送到后端
 * (POST /api/logs),和服务端日志汇成一条流——排查线上问题时不必去用户的浏览器里翻控制台。
 * 由 <ClientLogger /> 在根布局里初始化一次,全站每个页面都生效。
 *
 * 只收"出了什么事":不记操作轨迹,不记用户输入的内容。
 * 涉及接口调用的条目带那次调用的请求编号(见 lib/auth.ts 的 authFetch),
 * 后端按编号把"浏览器看到的失败"和"后端记下的那次请求"对上。
 *
 * 发不出去(断网、后端正在重启)就先留在本机,下一次发得出去时补发;存量有上限。
 * 这个模块自己出错时一律静默:记日志绝不能再引出新的报错。
 */

export type ClientLogLevel = "debug" | "info" | "warn" | "error";

/** 一条浏览器日志,和后端 POST /api/logs 收的结构一致 */
export interface ClientLogEntry {
  level: ClientLogLevel;
  message: string;
  stack?: string;
  page: string;
  ua: string;
  session: string;
  ts: number;
  count?: number;
  tag?: string;
  detail?: string;
  request?: { method: string; path: string; status: number; requestId: string; error: string };
  /** 已经试发过几次;只是本地状态,不上报 */
  tries?: number;
}

/** 一次没成功的接口调用。status 为 0 表示根本没收到响应 */
export interface ApiFailure {
  method: string;
  path: string;
  status: number;
  requestId: string;
  /** 给用户看的那句原因 */
  message: string;
}

export interface ClientLogExtra {
  /** 分类,用来筛:render / resource / promise / console / api / boundary / next-server */
  tag?: string;
  stack?: string;
  detail?: string;
  /** 和这次报错相关的请求编号(没有对应接口调用时,页面会自己生成一个给用户报) */
  requestId?: string;
}

const STORE_KEY = "flow.client-logs";
const SESSION_KEY = "flow.client-session";
/** 攒一会儿再发,免得连续几条报错各发一次 */
const FLUSH_DELAY = 3000;
const BATCH = 20;
/** 留在本地的上限:再多就丢最早的,磁盘不会被日志撑满 */
const MAX_QUEUE = 60;
const MAX_TRIES = 8;
/** 每分钟最多收多少条:页面陷入报错循环时不能把后端刷爆 */
const PER_MINUTE = 40;
/** 同一句话在这个时间内重复出现,合并成一条并计数 */
const DEDUPE_WINDOW = 1500;

let queue: ClientLogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;
let started = false;
/** 发送失败后的退避:越失败等得越久,最长一分钟 */
let delay = FLUSH_DELAY;
let minuteStart = 0;
let minuteCount = 0;
let dropped = 0;
const recent = new Map<string, { at: number; entry: ClientLogEntry }>();
/** console.error 已经报过的错误对象:随后 window.onerror 报的是同一个,不再重复 */
const seenFromConsole = new WeakSet<object>();
let tokenProvider: () => string | null = () => null;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 请求编号:16 位十六进制,和后端自己生成的同一个样子 */
export function newRequestId(): string {
  try {
    return randomHex(8);
  } catch {
    return Math.random().toString(16).slice(2, 10).padEnd(16, "0");
  }
}

/** 每个标签页一个编号:同一次访问里的日志能归到一起 */
function sessionId(): string {
  try {
    let v = sessionStorage.getItem(SESSION_KEY);
    if (!v) {
      v = randomHex(6);
      sessionStorage.setItem(SESSION_KEY, v);
    }
    return v;
  } catch {
    return "";
  }
}

function clip(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 当前页面的地址(含查询串,里面只有 tab、工作项编号这类筛选条件) */
function pageUrl(): string {
  try {
    return clip(location.pathname + location.search, 500);
  } catch {
    return "";
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) queue = (JSON.parse(raw) as ClientLogEntry[]).filter((e) => e && typeof e.message === "string").slice(0, MAX_QUEUE);
  } catch {
    /* 读不出来就当没有 */
  }
}

function persist() {
  try {
    if (queue.length) localStorage.setItem(STORE_KEY, JSON.stringify(queue));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* 隐私模式等存不进去:这一批发不出去就丢了,不影响页面 */
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush(false);
  }, delay);
}

function putBack(batch: ClientLogEntry[]) {
  const retry = batch.filter((e) => (e.tries ?? 0) < MAX_TRIES);
  const lost = batch.length - retry.length;
  queue = [...retry, ...queue].slice(0, MAX_QUEUE);
  if (lost > 0) {
    // 试了多次后端都不要,或一直发不出去:只留一句说明,不继续占着位置
    queue.unshift({ level: "warn", message: `有 ${lost} 条日志多次上报未成功，已放弃`, tag: "logger", page: pageUrl(), ua: "", session: sessionId(), ts: Date.now() });
    queue = queue.slice(0, MAX_QUEUE);
  }
  persist();
}

/** 把攒下的日志发一批。keepalive 用在页面即将关闭的时候 */
async function flush(keepalive: boolean) {
  if (sending || queue.length === 0) return;
  const batch: ClientLogEntry[] = [];
  let size = 0;
  while (batch.length < BATCH && queue.length > 0) {
    const next = queue[0];
    const cost = next.message.length + (next.stack?.length ?? 0);
    // 带 keepalive 的请求总体积有上限,一批不超过约 40KB
    if (batch.length > 0 && size + cost > 40_000) break;
    batch.push(queue.shift()!);
    size += cost;
  }
  batch.forEach((e) => {
    e.tries = (e.tries ?? 0) + 1;
  });
  persist();
  sending = true;
  try {
    const token = tokenProvider();
    const res = await fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ source: "browser", entries: batch }),
      keepalive,
      cache: "no-store",
    });
    if (res.status === 400 || res.status === 413) {
      // 这批内容本身不合法,重发也不会成功:直接丢掉,不占着位置
      delay = FLUSH_DELAY;
      return;
    }
    if (!res.ok) {
      putBack(batch);
      delay = Math.min(delay * 2, 60_000);
      return;
    }
    delay = FLUSH_DELAY;
  } catch {
    putBack(batch);
    delay = Math.min(delay * 2, 60_000);
  } finally {
    sending = false;
    if (queue.length > 0) schedule();
  }
}

function base() {
  return {
    page: pageUrl(),
    ua: clip(navigator.userAgent, 300),
    session: sessionId(),
    ts: Date.now(),
  };
}

function push(e: ClientLogEntry) {
  if (!started) return;
  try {
    const now = Date.now();
    if (now - minuteStart > 60_000) {
      const lost = dropped;
      minuteStart = now;
      minuteCount = 0;
      dropped = 0;
      if (lost > 0) {
        queue.unshift({ level: "warn", message: `上一分钟日志超过 ${PER_MINUTE} 条，另有 ${lost} 条没有上报`, tag: "logger", ...base(), ts: now });
      }
    }
    const key = `${e.level}|${e.tag ?? ""}|${e.message.slice(0, 160)}`;
    const last = recent.get(key);
    if (last && now - last.at < DEDUPE_WINDOW && queue.includes(last.entry)) {
      last.entry.count = (last.entry.count ?? 1) + 1;
      last.at = now;
      persist();
      return;
    }
    if (minuteCount >= PER_MINUTE) {
      dropped++;
      persist();
      return;
    }
    minuteCount++;
    recent.set(key, { at: now, entry: e });
    if (recent.size > 200) recent.delete(recent.keys().next().value as string);
    while (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(e);
    persist();
    schedule();
  } catch {
    /* 记日志不能影响页面 */
  }
}

/**
 * 调用处的堆栈,跳过日志模块自己的帧。直接从应用代码调 logClient 时跳 2 帧(captureStack、logClient);
 * 从 console.error 的桥接函数里取时多跳一帧(bridgeConsole 和 console.error 的包装)。
 */
function captureStack(skip = 2): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  return clip(stack.split("\n").slice(skip).join("\n"), 4000);
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/** 手动记一条。error 级别没给堆栈时会自动取调用处的堆栈。返回这条记录,便于之后给它补充信息 */
export function logClient(level: ClientLogLevel, message: string, extra: ClientLogExtra = {}): ClientLogEntry | undefined {
  const entry: ClientLogEntry = {
    level,
    message: clip(message, 1000),
    stack: extra.stack ? clip(extra.stack, 4000) : level === "error" ? captureStack() : undefined,
    tag: extra.tag,
    detail: extra.detail ? clip(extra.detail, 500) : undefined,
    request: extra.requestId ? { method: "", path: "", status: 0, requestId: extra.requestId, error: "" } : undefined,
    ...base(),
  };
  push(entry);
  return entry;
}

/** 已经经由 console.error 报过的错误对象 → 它那条记录 */
const entryOfError = new WeakMap<object, ClientLogEntry>();

/**
 * 同一个错误已经被 console.error 那条路记过了(React 渲染出错就是先走 console.error,再到错误边界):
 * 不再记一条,只把分类、页面请求编号补到已有的那条上。返回 false 表示那条已经发走了或者本来就没有,
 * 调用方需要自己再记一条。
 */
export function attachToReportedError(err: unknown, patch: { tag?: string; requestId?: string; detail?: string }): boolean {
  try {
    if (!(err instanceof Object)) return false;
    const entry = entryOfError.get(err);
    if (!entry || !queue.includes(entry)) return false;
    if (patch.tag) entry.tag = patch.tag;
    if (patch.requestId) entry.request = { method: "", path: "", status: 0, requestId: patch.requestId, error: entry.message };
    if (patch.detail) entry.detail = clip(patch.detail, 500);
    entry.page = pageUrl();
    persist();
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次后端不可能自己记下的失败:请求没发出去,或者回来的不是后端的东西(网关、隧道的错误页)。
 * 只报这两类——后端自己处理过的失败(4xx、5xx 的 JSON 响应)它那边已经带着同一个编号记下了,
 * 再报一遍只是重复。
 */
export function reportApiFailure(f: ApiFailure) {
  push({
    level: "error",
    message: `接口调用失败: ${f.method} ${f.path} → ${f.status ? `HTTP ${f.status}` : "没有收到响应"}`,
    detail: f.message,
    tag: "api",
    request: { method: f.method, path: clip(f.path, 500), status: f.status, requestId: f.requestId, error: clip(f.message, 500) },
    ...base(),
  });
}

function onWindowError(ev: ErrorEvent) {
  try {
    // 资源(脚本、样式)加载失败也会冒到这里:target 是那个元素。发版后旧页面去取已经不存在的代码块就是这一类
    const target = ev.target as (EventTarget & { tagName?: string; src?: string; href?: string }) | null;
    if (target && target !== window && target.tagName) {
      const url = target.src || target.href || "";
      logClient("error", `资源加载失败: ${target.tagName.toLowerCase()} ${url ? clip(url, 200) : "(未知地址)"}`, { tag: "resource" });
      return;
    }
    const err = ev.error as unknown;
    if (err instanceof Error && seenFromConsole.has(err)) return;
    // 浏览器给的 message 自带 "Uncaught Error:" 前缀,去掉免得和这里的前缀重复
    logClient("error", `未捕获的异常: ${ev.message.replace(/^Uncaught\s+/, "")}`, {
      tag: "error",
      stack: err instanceof Error ? err.stack : undefined,
      detail: `${ev.filename || ""}:${ev.lineno ?? ""}:${ev.colno ?? ""}`,
    });
  } catch {
    /* 静默 */
  }
}

function onRejection(ev: PromiseRejectionEvent) {
  try {
    const reason: unknown = ev.reason;
    logClient("error", `未处理的 Promise 拒绝: ${reason instanceof Error ? reason.message : String(reason)}`, {
      tag: "promise",
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  } catch {
    /* 静默 */
  }
}

/**
 * 接住 console.error:React 的渲染错误、水合不一致这类问题在正式环境里只走这里,
 * 用户看不见、也不会报,却是白屏和样式错乱的常见来源。
 */
function bridgeConsole(args: unknown[]) {
  try {
    const err = args.find((a): a is Error => a instanceof Error);
    if (err) seenFromConsole.add(err);
    const entry = logClient("error", `console.error: ${clip(args.map(fmtArg).join(" "), 1000)}`, {
      tag: "console",
      // 有错误对象就用它的堆栈;只有文字时取调用 console.error 的地方
      stack: err?.stack ?? captureStack(3),
    });
    // 记下"这个错误对应哪一条":随后错误边界报同一个错误时只补充,不重复记
    if (err && entry) entryOfError.set(err, entry);
  } catch {
    /* 静默 */
  }
}

function onVisibility() {
  try {
    // 切到后台或锁屏前把现有的发出去;回到前台时网络可能已经恢复,再试一次
    if (document.visibilityState === "hidden") void flush(true);
    else if (queue.length > 0) schedule();
  } catch {
    /* 静默 */
  }
}

/** 初始化一次:装上全局的报错监听,并把上次没发出去的接着发 */
export function initClientLogger(opts: { getToken?: () => string | null } = {}) {
  if (started || typeof window === "undefined") return;
  started = true;
  if (opts.getToken) tokenProvider = opts.getToken;
  load();
  minuteStart = Date.now();
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("pagehide", () => void flush(true));
  document.addEventListener("visibilitychange", onVisibility);
  const original = console.error;
  console.error = (...args: unknown[]) => {
    original.apply(console, args);
    bridgeConsole(args);
  };
  if (queue.length > 0) schedule();
}

/** 当前还压着多少条没发出去(测试用) */
export function pendingClientLogs(): number {
  return queue.length;
}
