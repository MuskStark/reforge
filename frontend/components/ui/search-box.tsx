"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** 工具条里的搜索框:放大镜在左,高度比表单里的输入框矮一档 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  /** 读屏用的名字,默认同占位文字 */
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative block w-full sm:max-w-[320px]", className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" aria-hidden="true" />
      <Input type="text" value={value} onChange={onChange} placeholder={placeholder} aria-label={label ?? placeholder} autoComplete="off" className="toolbar-field !pl-10" />
    </span>
  );
}
