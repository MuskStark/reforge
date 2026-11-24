"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { SystemOption } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 线上系统库（模块级缓存：一次拉取全页共用，60s 过期） */
let cache: { list: SystemOption[]; at: number } | null = null;

async function loadSystems(): Promise<SystemOption[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  try {
    const res = await fetch("/api/systems", { cache: "no-store" });
    if (!res.ok) throw new Error();
    const list = (await res.json()) as SystemOption[];
    cache = { list, at: Date.now() };
    return list;
  } catch {
    return [];
  }
}

export function invalidateSystemCache() {
  cache = null;
}

/**
 * 线上系统选择器：管理员维护系统库后，填写方只需下拉选择；
 * 系统库为空或加载失败时回退为手动输入。
 * required = 没有单独标签时(会签子步骤)在占位文字里标出"必填";
 * invalid = 点过提交后仍为空,红圈提示。
 */
export function SystemSelect({
  value,
  onChange,
  id,
  placeholder = "选择线上系统",
  compact = false,
  required = false,
  invalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
  compact?: boolean;
  required?: boolean;
  invalid?: boolean;
}) {
  const [options, setOptions] = useState<SystemOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSystems().then((list) => {
      if (!cancelled) setOptions(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const note = required && !value.trim() ? "（必填）" : "";

  // 加载中或系统库为空 → 手动输入兜底
  if (!options || options.length === 0) {
    return (
      <Input
        id={id}
        value={value}
        aria-invalid={invalid}
        placeholder={
          (options === null ? "加载系统列表中…" : compact ? "手动输入系统名称" : "如：OA 办公系统 / ERP / 财务共享平台") + note
        }
        onChange={(e) => onChange(e.target.value)}
        className={cn(compact ? "h-9 text-sm" : undefined, invalid && "field-invalid")}
      />
    );
  }

  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        className={cn("field pr-9", compact && "h-9 text-sm", invalid && "field-invalid")}
      >
        <option value="">{placeholder + note}</option>
        {options.map((o) => (
          <option key={o.id} value={o.name}>
            {o.name}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[color:var(--ink-3)]",
          compact ? "h-3.5 w-3.5" : "h-4 w-4",
        )}
      />
    </div>
  );
}
