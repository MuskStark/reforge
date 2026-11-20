"use client";

/**
 * Toaster 客户端包装：
 * Sonner 在根布局直接渲染时，<section> 容器会先于 <body> 挂载，
 * 在 React 19 + App Router 下触发 hydration 错误；
 * 本项目 toast 全部由用户操作触发，挂载后再渲染无副作用。
 */
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/toast";

export function AppToaster() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Toaster position="top-center" /> : null;
}
