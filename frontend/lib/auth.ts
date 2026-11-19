"use client";

/** 管理端会话令牌存取（sessionStorage：关闭浏览器即登出） */
const TOKEN_KEY = "flow.admin.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** 携带 Bearer 令牌的 fetch；401 时清除本地令牌并抛错供调用方处理 */
export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("UNAUTHORIZED");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? "请求失败");
  }
  return data as T;
}
