import type { Instrumentation } from "next";

/**
 * Next 服务端的错误出口(Next 的官方钩子):服务端组件、路由处理、渲染过程中抛出的错误都会到这里。
 * Next 自己只会把它们打到前端容器的标准输出;这里原样转发到后端日志流(POST /api/logs),
 * 排查时只看后端一处。后端不通时退回标准输出,至少还留得下一行。
 * 浏览器端的报错不走这里,见 lib/client-logger.ts。
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const e = err instanceof Error ? err : undefined;
  const message = `Next 服务端出错: ${e?.message ?? String(err)}`;
  const page = String(request.path ?? "");
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const ua = first(request.headers?.["user-agent"]);
  const incoming = first(request.headers?.["x-request-id"]);
  const entry = {
    level: "error",
    tag: "next-server",
    message,
    stack: e?.stack ?? "",
    page,
    ua: ua ?? "",
    session: "",
    ts: Date.now(),
    detail: [context.routerKind, context.routeType, context.renderSource ?? "", context.routePath].filter(Boolean).join(" · "),
    request: { method: request.method, path: page, status: 0, requestId: /^[A-Za-z0-9_-]{8,64}$/.test(incoming ?? "") ? incoming : "", error: message },
  };
  try {
    const res = await fetch((process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8080") + "/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "next-server", entries: [entry] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`后端返回 ${res.status}`);
  } catch (forwardErr) {
    console.error(JSON.stringify({ ...entry, level: "error", msg: "next 服务端出错(转发到后端日志失败)", forwardError: String(forwardErr) }));
  }
};
