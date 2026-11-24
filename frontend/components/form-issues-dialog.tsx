"use client";

import { ChevronRight } from "lucide-react";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";

export interface FormIssueGroup {
  /** 分组标题,如「流程基本信息」「第 2 步 · 部门审批」 */
  title: string;
  /** 该组第一项对应的锚点 id(flow-focus.ts) */
  anchorId: string | null;
  items: { text: string; anchorId: string | null }[];
}

/**
 * 提交被拦下时的"还差什么"清单:一次列出全部必填缺失项,按步骤分组。
 * 点任意一项即关闭弹窗并跳到对应的输入位置。
 */
export function FormIssuesDialog({
  groups,
  total,
  onClose,
  onJump,
}: {
  groups: FormIssueGroup[];
  total: number;
  onClose: () => void;
  onJump: (anchorId: string | null) => void;
}) {
  return (
    <Dialog onClose={onClose} labelledBy="form-issues-title" className="max-w-[560px]">
      <DialogHeader
        id="form-issues-title"
        title={`还有 ${total} 项必填信息没有填写`}
        subtitle="下面是全部还差的内容。点击任意一项，会跳到对应的输入位置。"
        onClose={onClose}
      />
      <div className="mt-5 max-h-[55vh] space-y-4 overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[13px] font-semibold text-neutral-900">{g.title}</h3>
            <ul className="space-y-1">
              {g.items.map((it) => (
                <li key={it.text}>
                  <button
                    type="button"
                    onClick={() => onJump(it.anchorId)}
                    className="group flex w-full items-center gap-2.5 rounded-2xl bg-white/60 px-3.5 py-2.5 text-left shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)] transition hover:bg-white/90"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--red)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 text-[13px] leading-snug text-neutral-800">{it.text}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--ink-3)] transition group-hover:translate-x-0.5 group-hover:text-[color:var(--tint)]" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-glass">
          我自己找
        </button>
        <button type="button" onClick={() => onJump(groups[0]?.items[0]?.anchorId ?? null)} className="btn btn-primary">
          从第一项开始填
        </button>
      </DialogActions>
    </Dialog>
  );
}
