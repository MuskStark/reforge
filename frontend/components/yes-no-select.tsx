"use client";

import { cn } from "@/lib/utils";

/**
 * 必选「是 / 否」单选组(iOS 迷你分段控件):
 * 用于必填布尔项(如"是否支持移动端")。
 * value 为 null 表示尚未选择(未选时红色描边提示)。
 */
export function YesNoSelect({
  label,
  value,
  onChange,
  required = true,
  hint,
  compact = false,
  className,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  required?: boolean;
  hint?: string;
  compact?: boolean;
  className?: string;
}) {
  const unset = required && value === null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-xl px-2.5 transition-colors",
        compact ? "py-1" : "py-1.5",
        unset
          ? "bg-[color:var(--red-soft)] shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.35)]"
          : "bg-white/45 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.035)]",
        className,
      )}
    >
      <span className="text-xs font-medium text-neutral-700">
        {label}
        {required && <span className="ml-0.5 text-[color:var(--red)]">*</span>}
      </span>
      <div
        className={cn(
          "seg seg-mini",
          unset &&
            "!bg-[rgba(255,255,255,0.75)] shadow-[inset_0_0_0_1.5px_rgba(255,59,48,0.45)]",
        )}
      >
        {[
          { v: true, t: "是" },
          { v: false, t: "否" },
        ].map(({ v, t }) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(v)}
            className={value === v ? "on" : undefined}
          >
            {t}
          </button>
        ))}
      </div>
      {unset && <span className="text-[10px] text-[color:var(--red-deep)]">必选</span>}
      {hint && !unset && (
        <span className="text-[10px] text-[color:var(--ink-3)]">{hint}</span>
      )}
    </div>
  );
}
