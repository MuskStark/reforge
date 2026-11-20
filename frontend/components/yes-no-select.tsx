"use client";

import { cn } from "@/lib/utils";

/**
 * 必选「是 / 否」单选组：用于必填布尔项（如"是否支持移动端"）。
 * value 为 null 表示尚未选择（未选时高亮提示边框）。
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
        "rounded-lg border px-2.5 py-1.5 transition-colors",
        unset
          ? "border-red-400/50 bg-red-400/[0.06]"
          : "border-white/10 bg-black/30",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-300">
          {label}
          {required && <span className="ml-0.5 text-red-400">*</span>}
        </span>
        <div className="flex overflow-hidden rounded-md border border-white/15">
          {[
            { v: true, t: "是" },
            { v: false, t: "否" },
          ].map(({ v, t }) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange(v)}
              className={cn(
                "px-3 text-xs font-medium transition-colors",
                compact ? "py-0.5" : "py-1",
                value === v
                  ? "bg-cyan-500/30 text-white ring-1 ring-cyan-400/50 ring-inset"
                  : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200",
              )}
            >
              {t}
            </button>
          ))}
        </div>
        {unset && (
          <span className="text-[10px] text-red-300">必选</span>
        )}
        {hint && !unset && (
          <span className="text-[10px] text-neutral-500">{hint}</span>
        )}
      </div>
    </div>
  );
}
