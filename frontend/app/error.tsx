"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { attachToReportedError, initClientLogger, logClient, newRequestId } from "@/lib/client-logger";
import { getToken } from "@/lib/auth";

/**
 * 页面级的错误边界:某个路由在渲染或客户端代码里抛出错误时接住,不让整站变成一张白屏。
 * 在此之前,这类错误只有用户看得见(或者只看到 Next 默认的那句"Application error"),
 * 服务器上没有任何记录——所以这里是把它报进日志系统的地方。
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // 每次出错生成一个编号:页面上的编号和日志里那一行的 req 是同一个,用户报编号就能查
  const id = useRef<string>("");
  if (!id.current) id.current = newRequestId();

  useEffect(() => {
    // 页面首次加载就出错时,子组件的 effect 会先于根布局里的 <ClientLogger /> 执行,所以这里也初始化一次(幂等)
    initClientLogger({ getToken });
    const detail = error.digest ? `digest ${error.digest}` : undefined;
    // React 已经先在 console.error 里报过这个错误(日志模块接住了):只补分类和编号,不重复记
    if (!attachToReportedError(error, { tag: "boundary", requestId: id.current, detail })) {
      logClient("error", `页面渲染出错: ${error.message}`, { tag: "boundary", stack: error.stack, requestId: id.current, detail });
    }
  }, [error]);

  return (
    <main className="grid min-h-[100dvh] place-items-center px-6 py-16">
      <section className="glass-card w-full max-w-[440px] p-7 text-center sm:p-8" role="alert">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-neutral-900">这个页面出错了</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--ink-2)]">
          错误已经记录下来。可以先重试；还是不行的话刷新页面，或者把下面的编号告诉管理员。
        </p>
        <p className="mt-4 inline-flex items-baseline gap-1.5 rounded-full bg-white/60 px-3 py-1 text-[12px] text-[color:var(--ink-2)] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.05)]">
          编号 <span className="font-data font-semibold text-neutral-900">{id.current}</span>
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          <button type="button" onClick={() => reset()} className="btn btn-primary">
            重试
          </button>
          <Link href="/work" prefetch={false} className="btn btn-glass">
            回工作台
          </Link>
        </div>
      </section>
    </main>
  );
}
