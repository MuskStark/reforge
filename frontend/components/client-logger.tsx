"use client";

import { useEffect } from "react";
import { initClientLogger } from "@/lib/client-logger";
import { getToken } from "@/lib/auth";

/**
 * 在根布局里挂一次,全站(包括公开的收集表和登录页)启用浏览器日志上报。
 * 见 lib/client-logger.ts。不渲染任何东西。
 */
export function ClientLogger() {
  useEffect(() => {
    // 带上登录令牌:上报时后端就能记下是谁的浏览器
    initClientLogger({ getToken });
  }, []);
  return null;
}
