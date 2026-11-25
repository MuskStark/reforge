"use client";

import { useEffect } from "react";
import { initClientLogger, logClient } from "@/lib/client-logger";
import { getToken } from "@/lib/auth";

/**
 * 根布局自己出错时的最后一道防线(此时 app/error.tsx 和正常的布局都已不在,必须自己渲染 html/body)。
 * 同样把错误报进日志系统——这是最严重的一类故障:整站都打不开。
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    initClientLogger({ getToken });
    logClient("error", `根布局渲染出错(整站不可用): ${error.message}`, {
      tag: "global-error",
      stack: error.stack,
      detail: error.digest ? `digest ${error.digest}` : undefined,
    });
  }, [error]);

  return (
    <html lang="zh-CN">
      <body className="font-sans">
        <main className="grid min-h-[100dvh] place-items-center px-6 py-16">
          <section className="glass-card w-full max-w-[440px] p-7 text-center sm:p-8" role="alert">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-neutral-900">系统暂时打不开</h1>
            <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--ink-2)]">
              错误已经记录下来。请刷新页面；一直不行的话请联系管理员。
            </p>
            <button type="button" onClick={() => reset()} className="btn btn-primary mt-5">
              重试
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
