"use client";

/**
 * 需求承接各面板共用的小件:统一的失败提示、通用的「执行—提示—刷新」、承接方案的写接口。
 * 只放与界面无关的薄封装;业务规则在 lib/intake.ts,服务端校验在 backend/intake_*.go。
 */

import { useState } from "react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth";

/** 把接口的失败变成一条提示;会话失效由外壳处理,不在这里重复弹 */
export const fail = (e: unknown, label: string) => toast.error(label, { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });

/** 通用的「执行—提示—刷新」:执行期间 busy;成功后提示并重新读取,返回 true */
export function useAction(onSaved: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      await onSaved();
      return true;
    } catch (e) {
      fail(e, label);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** 承接方案的写接口:只传要改的部分(流程是否完整 / 总述 / 推进线 / 节点) */
export const putSolution = (projectId: string, body: Record<string, unknown>) =>
  authFetch(`/api/projects/${projectId}/intake/solution`, { method: "PUT", body: JSON.stringify(body) });
