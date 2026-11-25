"use client";

import { cloneElement, isValidElement, useEffect, useId } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 玻璃对话框:表单类弹层用它,而不是 AnimatedModal——后者带 3D 透视入场动画,
 * 表单控件放在 preserve-3d 容器里会发虚。Esc 或点击遮罩关闭。
 */
export function Dialog({
  onClose,
  labelledBy,
  className,
  children,
}: {
  onClose: () => void;
  labelledBy?: string;
  className?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex overflow-y-auto bg-[rgba(18,26,48,0.32)] p-4 backdrop-blur-md sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* m-auto:垂直居中;内容比视口高时上下留出边距,可以滚动,顶部不会被裁掉 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn("m-auto w-full rounded-[28px] p-5 sm:p-6", className ?? "max-w-[560px]")}
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.68))",
          backdropFilter: "blur(36px) saturate(180%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.98), 0 40px 90px -30px rgba(12,22,48,0.45)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  title,
  subtitle,
  onClose,
  id,
  tone = "default",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  id?: string;
  tone?: "default" | "indigo" | "amber";
}) {
  return (
    <div className="flex items-start gap-3 pr-8">
      <div className="min-w-0 flex-1">
        <h2
          id={id}
          className={cn(
            "text-[19px] font-bold tracking-[-0.02em] text-neutral-900",
            tone === "indigo" && "text-[color:var(--indigo-deep)]",
            tone === "amber" && "text-[color:var(--amber-deep)]",
          )}
        >
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--ink-2)]">{subtitle}</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="关闭" className="icon-btn icon-danger !h-9 !w-9 shrink-0">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** 对话框底部操作条 */
export function DialogActions({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2.5 border-t border-[color:var(--sep)] pt-4">{children}</div>;
}

/** 表单里的一行:标签 + 控件。标签自动关联到唯一的控件(id 自动生成,控件自带的 id 优先) */
export function Field({
  label,
  required,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  let control: React.ReactNode = children;
  if (isValidElement(children)) {
    const el = children as React.ReactElement<Record<string, unknown>>;
    control = cloneElement(el, { id: (el.props.id as string | undefined) ?? id });
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-medium text-neutral-800">
        {label}
        {required && <span className="ml-0.5 text-[color:var(--red)]">*</span>}
        {hint && <span className="ml-2 text-xs font-normal text-[color:var(--ink-3)]">{hint}</span>}
      </label>
      {control}
    </div>
  );
}
