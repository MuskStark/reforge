"use client";

/**
 * 申请 CTO 协助:PM 发起申请(写明事项)→ 通知全部 CTO → CTO 响应加入 → 结束协助。
 * 协助区放在承接标签页右栏的团队卡片里;申请与撤回的对话框由标签页挂在根节点上——
 * 带背景模糊的卡片是 fixed 定位的包含块,对话框放在卡片里会被困住。
 */

import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { authFetch } from "@/lib/auth";
import type { CtoSupport, IntakeView } from "@/lib/types";
import { supportText } from "@/lib/intake";
import { fail, useAction } from "@/components/projects/intake-action";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Action = "request" | "withdraw" | "join" | "release";

/** 申请或撤回的对话框 */
export function SupportDialog({ action, projectId, onClose, onSaved }: { action: "request" | "withdraw"; projectId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const { busy, run } = useAction(onSaved);
  const request = action === "request";
  const go = async () => {
    const ok = await run(
      request ? "申请失败" : "撤回失败",
      () => authFetch(`/api/projects/${projectId}/intake/cto-support`, { method: "POST", body: JSON.stringify({ action, note }) }),
      request ? "已申请 CTO 协助，已通知全部 CTO" : "已撤回申请",
    );
    if (ok) onClose();
  };
  return (
    <Dialog onClose={onClose} labelledBy="support-title">
      <DialogHeader
        id="support-title"
        title={request ? "申请 CTO 协助" : "撤回 CTO 协助申请"}
        subtitle={request ? "写明需要 CTO 协助判断的事项。全部 CTO 会收到通知，响应后记入团队与动态。" : "撤回后 CTO 不能再加入；需要时可以重新申请。"}
        onClose={onClose}
      />
      {request && (
        <div className="mt-4">
          <Field label="需要协助的事项" required>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：电子会计档案的合规性、商旅平台接口能力需要技术预判" className="min-h-[76px] !text-[13px]" />
          </Field>
        </div>
      )}
      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-glass">
          取消
        </button>
        <button type="button" disabled={busy || (request && !note.trim())} onClick={() => void go()} className="btn btn-primary disabled:opacity-50">
          {request ? "发出申请" : "确认撤回"}
        </button>
      </DialogActions>
    </Dialog>
  );
}

/** 团队卡片里的「CTO 协助」区:现状 + 按状态与身份给出的操作 */
export function SupportPanel({
  v,
  projectId,
  onSaved,
  onAsk,
}: {
  v: IntakeView;
  projectId: string;
  onSaved: () => Promise<void>;
  /** 打开申请 / 撤回的对话框(由外层挂载在根节点上) */
  onAsk: (action: "request" | "withdraw") => void;
}) {
  const { busy, run } = useAction(onSaved);
  const support: CtoSupport = v.ctoSupport;
  const act = (action: Action, ok: string) => void run("操作失败", () => authFetch(`/api/projects/${projectId}/intake/cto-support`, { method: "POST", body: JSON.stringify({ action }) }), ok);

  return (
    <div className="mt-3 rounded-2xl bg-[linear-gradient(180deg,rgba(240,240,255,0.5),rgba(255,255,255,0.45))] p-3 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.25)]">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <LifeBuoy className="h-4 w-4 shrink-0 text-[color:var(--indigo-deep)]" aria-hidden="true" />
        <b className="font-semibold text-[color:var(--indigo-deep)]">CTO 协助</b>
        <span className={cn("badge ml-auto !h-[19px] text-[10.5px]", support.status === "joined" && "badge-ok", support.status === "requested" && "badge-indigo", support.status === "none" && "badge-plain")}>
          {supportText(support)}
        </span>
      </div>
      {support.status === "requested" && support.reason && <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-[color:var(--ink-2)]">事项：{support.reason}</p>}
      {support.status === "joined" && <p className="mt-1.5 text-[12px] leading-relaxed text-[color:var(--ink-2)]">{support.joinedAt ? `${support.joinedAt.slice(0, 10)} 加入` : "已加入"}，评估技术可行性时由这位 CTO 主持。</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {v.can.requestCto && support.status === "none" && (
          <button type="button" disabled={busy} onClick={() => onAsk("request")} className="btn btn-glass !h-8 !px-3 text-[12px] disabled:opacity-50">
            申请 CTO 协助
          </button>
        )}
        {v.can.requestCto && support.status === "requested" && (
          <button type="button" disabled={busy} onClick={() => onAsk("withdraw")} className="btn btn-glass !h-8 !px-3 text-[12px] disabled:opacity-50">
            撤回申请
          </button>
        )}
        {v.can.joinCto && (
          <button type="button" disabled={busy} onClick={() => act("join", "已加入协助，已通知 PM")} className="btn btn-primary !h-8 !px-3 text-[12px] disabled:opacity-50">
            加入协助
          </button>
        )}
        {support.status === "joined" && (v.can.manage || v.can.joinCto) && (
          <button type="button" disabled={busy} onClick={() => act("release", "CTO 协助已结束")} className="btn btn-glass !h-8 !px-3 text-[12px] text-[color:var(--ink-2)] disabled:opacity-50">
            结束协助
          </button>
        )}
      </div>
      {support.status === "none" && !v.can.requestCto && <p className="mt-1.5 text-[11px] leading-relaxed text-[color:var(--ink-3)]">PM 在推进中遇到需要技术判断的事项时，可以在这里申请 CTO 协助。</p>}
    </div>
  );
}
