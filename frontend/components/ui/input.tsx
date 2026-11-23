"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

/** iOS 规格输入框:44pt 圆角白玻璃,聚焦蓝色光圈(样式见 globals.css .field) */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn("field", className)}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
