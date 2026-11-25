"use client";

/** 管理端会话存取（sessionStorage：关闭浏览器即登出） */
const TOKEN_KEY = "flow.admin.token";
const USER_KEY = "flow.admin.user";
/** 会话因过期 / 失效而断开时留下的标记,见 takeLoginReason */
const LOGIN_REASON_KEY = "flow.admin.login-reason";

import { newRequestId, reportApiFailure } from "@/lib/client-logger";
import type { JobRole } from "@/lib/types";

export interface SessionUser {
  /** users.id;环境变量引导的管理员为空字符串 */
  id: string;
  username: string;
  /** 系统角色:只决定能否进管理后台 */
  role: "admin" | "member";
  displayName: string;
  department: string;
  /** 全局岗位;引导管理员为空字符串 */
  jobRole: JobRole | "";
  /** 为 true 表示管理员设定的初始密码还没换:改完之前只能改密码,其他接口都会被拒绝 */
  mustChangePassword?: boolean;
}

/** 改完资料或密码后更新本地缓存的用户(与 /api/auth/me 的返回同构) */
export function setSessionUser(user: SessionUser) {
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(LOGIN_REASON_KEY);
}

/**
 * 会话为什么断的:登录页据此提示一句。
 * 只在"原本已登录、又不是在登录 / 注册途中"时记录——密码输错也是 401,那不算会话过期。
 */
const AUTH_PATH = /\/api\/auth\/(login|register)(\?|$)/;

function noteSessionEnded(hadSession: boolean, path: string) {
  if (!hadSession || AUTH_PATH.test(path)) return;
  try {
    sessionStorage.setItem(LOGIN_REASON_KEY, "expired");
  } catch {
    /* 隐私模式等存不进去:少一句提示而已 */
  }
}

/** 登录页读走断开原因(读过即清,只提示一次) */
export function takeLoginReason(): "expired" | null {
  if (typeof window === "undefined") return null;
  const v = sessionStorage.getItem(LOGIN_REASON_KEY);
  sessionStorage.removeItem(LOGIN_REASON_KEY);
  return v === "expired" ? "expired" : null;
}

/** 这些接口的写操作会改变「我的待办」:成功后通知外壳重算侧栏的数字 */
const TODO_PATH = /^\/api\/(admin\/)?(projects|items|reviews|processes)(\/|\?|$)/;

/** 请求没到服务器,或者到的不是后端的 JSON(多半是网关 / Cloudflare 的错误页):把原因说清楚 */
export class RequestError extends Error {
  code: "NETWORK" | "BAD_RESPONSE";
  status?: number;
  requestId?: string;

  constructor(message: string, code: "NETWORK" | "BAD_RESPONSE", status?: number, requestId?: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

const isRead = (method: string) => method === "GET" || method === "HEAD";

/** 提示末尾带上请求编号:用户把它报给管理员,就能在服务端日志里按编号查到这次请求的全部记录 */
function withRequestId(message: string, requestId: string): string {
  return `${message}（编号 ${requestId}）`;
}

/**
 * 请求在到达后端之前就失败了。浏览器对断网、连接被重置只给一个没有信息的 TypeError,
 * 网关与隧道出错时返回的又是 HTML 错误页——不翻译的话,界面上只剩一句「请稍后重试」,
 * 分不清是没连上、被拦截,还是服务器坏了(2026-11-25 线上删除流程失败就卡在这里)。
 * 写请求的响应丢了不等于没执行:提示用户先刷新确认,避免重复提交或误以为要重试。
 * 这类失败后端自己记不到(请求没到它那儿,或回来的不是它发的),所以同时上报一条浏览器日志,
 * 带同一个请求编号——服务端日志里"浏览器说失败了"和"后端到底收没收到"就对着同一个编号。
 */
function transportError(method: string, requestId: string, path: string, res?: Response): RequestError {
  const hint = isRead(method) ? "请检查网络后刷新重试" : "操作可能已经生效，请先刷新页面确认，再决定是否重试";
  if (!res) {
    reportApiFailure({ method, path, status: 0, requestId, message: "没有连上服务器（网络中断或超时）" });
    return new RequestError(withRequestId(`没有连上服务器（网络中断或超时）。${hint}`, requestId), "NETWORK", undefined, requestId);
  }
  const s = res.status;
  let why: string;
  if (s === 502 || s === 503 || s === 504) why = `服务器或网关暂时不可用（HTTP ${s}）`;
  else if (s >= 520 && s <= 530) why = `连接服务器的链路出错（HTTP ${s}，通常是网络或 Cloudflare 隧道波动）`;
  else if (s === 403) why = "请求在网关被拒绝（HTTP 403），没有到达应用";
  else why = `服务器返回了无法识别的内容（HTTP ${s}）`;
  reportApiFailure({ method, path, status: s, requestId, message: `${why}。${hint}` });
  return new RequestError(withRequestId(`${why}。${hint}`, requestId), "BAD_RESPONSE", s, requestId);
}

/**
 * 携带 Bearer 令牌的 fetch；401 时清除本地会话并抛错供调用方处理。
 * 每次调用带一个请求编号(X-Request-Id):后端沿用这个编号,把它写进这次请求的所有日志,并写回响应头。
 */
export async function authFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const method = (init?.method ?? "GET").toUpperCase();
  const requestId = newRequestId();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw transportError(method, requestId, path);
  }
  if (res.status === 401) {
    // 先清会话再记原因:clearSession 会把上一次的原因一并清掉
    clearSession();
    noteSessionEnded(Boolean(token), path);
    // 通知应用外壳:会话已失效,回到登录页
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw transportError(method, requestId, path, res);
    // 状态码是成功的,但响应体没读完:服务器多半已经处理了
    if (res.status === 204) return undefined as T;
    const message = `服务器的响应没有完整送达。${isRead(method) ? "请刷新重试" : "操作可能已经生效，请先刷新页面确认，再决定是否重试"}`;
    reportApiFailure({ method, path, status: res.status, requestId, message });
    throw new RequestError(withRequestId(message, requestId), "BAD_RESPONSE", res.status, requestId);
  }
  if (!res.ok) {
    const { error, code } = (data ?? {}) as { error?: string; code?: string };
    const reason = error ?? `请求失败（HTTP ${res.status}）`;
    // 服务器错误在后端日志里是 error 级,带上编号就能直接找到;业务性的 4xx(必填没填、没有权限)不带,免得提示变长
    const err = new Error(res.status >= 500 ? withRequestId(reason, requestId) : reason) as Error & { code?: string; requestId?: string };
    err.code = code;
    err.requestId = requestId;
    // 服务端要求先改密码(首次登录):通知应用外壳立刻弹出强制改密
    if (res.status === 403 && code === "PASSWORD_CHANGE_REQUIRED") {
      window.dispatchEvent(new Event("reforge:password-required"));
    }
    throw err;
  }
  if (method !== "GET" && TODO_PATH.test(path)) {
    window.dispatchEvent(new Event("reforge:todo-changed"));
  }
  return data as T;
}

// 兼容既有引用（管理端数据请求）
export const adminFetch = authFetch;

/**
 * 携带 Bearer 令牌下载文件（导出用；<a href> 带不了令牌）。
 * 返回文件名（取自 Content-Disposition，没有就退回 fallback）。
 */
export async function authFetchBlob(path: string, init: RequestInit, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  const token = getToken();
  const method = (init.method ?? "GET").toUpperCase();
  const requestId = newRequestId();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        "X-Request-Id": requestId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw transportError(method, requestId, path);
  }
  if (res.status === 401) {
    // 先清会话再记原因:clearSession 会把上一次的原因一并清掉
    clearSession();
    noteSessionEnded(Boolean(token), path);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reforge:unauthorized"));
    throw new Error("UNAUTHORIZED");
  }
  if (!res.ok) {
    // 后端给的错误原样显示(服务器错误带编号);不是 JSON(网关 / 隧道的错误页)就说明是链路问题
    let msg = "";
    try {
      msg = ((await res.json()) as { error?: string })?.error ?? "";
    } catch {
      /* 非 JSON 错误体 */
    }
    if (msg) throw new Error(res.status >= 500 ? withRequestId(msg, requestId) : msg);
    throw transportError(method, requestId, path, res);
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  let filename = fallbackName;
  try {
    if (star) filename = decodeURIComponent(star[1]);
    else if (plain) filename = plain[1];
  } catch {
    /* 文件名解码失败就用兜底名 */
  }
  return { blob: await res.blob(), filename };
}

/** 把 Blob 存成本地文件 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
