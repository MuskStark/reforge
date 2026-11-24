"use client";

import { AlertCircle, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 必填项的空状态:明确告诉填写人"这里必须有内容",并给出醒目的添加按钮。
 * 用于还没有可标记的输入框的列表型必填项(线下经办部门及人员、会签部门及人员)。
 * error = 已经点过提交仍然缺失:描边加重。
 */
export function RequiredEmpty({
  title,
  hint,
  actionLabel,
  onAdd,
  error = false,
}: {
  title: string;
  hint: string;
  actionLabel: string;
  onAdd: () => void;
  error?: boolean;
}) {
  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-dashed bg-[color:var(--red-soft)] px-3.5 py-3",
        error
          ? "border-[rgba(255,59,48,0.68)] shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.18)]"
          : "border-[rgba(255,59,48,0.42)]",
      )}
    >
      <p className="flex items-start gap-1.5 text-[13px] font-semibold leading-snug text-[color:var(--red-deep)]">
        <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
        {title}
      </p>
      <p className="text-xs leading-relaxed text-[color:var(--ink-2)]">{hint}</p>
      <button type="button" onClick={onAdd} className="btn btn-primary self-start text-[13px]">
        <Plus className="h-4 w-4" /> {actionLabel}
      </button>
    </div>
  );
}
