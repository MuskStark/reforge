"use client";
import React from "react";
import { cn } from "@/lib/utils";

/**
 * iOS 开关(UISwitch 规格 51×31,选中 systemGreen)。
 * 保留旧 Checkbox API(checked / onCheckedChange / children),
 * 点击整块区域可切换 —— 用于「本步骤为会签」等布尔开关。
 */
export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  React.HTMLAttributes<HTMLButtonElement> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }
>(
  (
    { className, checked = false, onCheckedChange, children, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn("group flex w-full items-center gap-2 rounded-xl p-1 text-left", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-[#34c759]" : "bg-[rgba(120,120,128,0.16)]",
        )}
        style={{
          boxShadow: checked
            ? "inset 0 0 0 0.5px rgba(0,0,0,0.04), inset 0 1px 2px rgba(0,66,24,0.18)"
            : "inset 0 0 0 0.5px rgba(0,0,0,0.08), inset 0 1px 3px rgba(23,42,80,0.1)",
        }}
      >
        <span
          className={cn(
            "absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white",
            "transition-[left] duration-200 [transition-timing-function:cubic-bezier(0.33,1,0.68,1)]",
            checked ? "left-[22px]" : "left-[2px]",
          )}
          style={{
            boxShadow:
              "0 2px 5px -1px rgba(23,42,80,0.3), 0 1px 2px rgba(23,42,80,0.12)",
          }}
        />
      </span>
      {children != null && (
        <span className="min-w-0 flex-1 text-sm transition-colors duration-200">
          {children}
        </span>
      )}
    </button>
  ),
);

Checkbox.displayName = "Checkbox";
