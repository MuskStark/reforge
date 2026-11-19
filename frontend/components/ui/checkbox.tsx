"use client";

import { motion } from "framer-motion";
import React from "react";
import { cn } from "@/lib/utils";

/**
 * Aceternity UI — Checkbox
 * 点击整块区域可切换，选中时白底黑色对勾
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
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md p-1 text-left",
        className,
      )}
      {...props}
    >
      <motion.span
        initial={false}
        animate={{
          backgroundColor: checked ? "rgba(255,255,255,1)" : "rgba(255,255,255,0)",
        }}
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-200",
          checked ? "border-transparent" : "border-white/30 group-hover:border-white/60",
        )}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={3.5}
          stroke="currentColor"
          className={cn(
            "h-3 w-3 text-black transition-opacity duration-200",
            checked ? "opacity-100" : "opacity-0",
          )}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m4.5 12.75 6 6 9-13.5"
          />
        </svg>
      </motion.span>
      {children != null && (
        <span className="text-sm text-neutral-300 transition-colors duration-200 group-hover:text-white">
          {children}
        </span>
      )}
    </button>
  ),
);

Checkbox.displayName = "Checkbox";
