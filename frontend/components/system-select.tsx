"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import type { SystemOption } from "@/lib/types";

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
 */
export function SystemSelect({
  value,
  onChange,
  id,
  placeholder = "选择线上系统",
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  placeholder?: string;
  compact?: boolean;
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

  const selectCls = compact
    ? "h-8 w-full rounded-md border-none bg-black px-2 text-xs text-white shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] outline-none focus:shadow-[0_0_1px_2px_#3EC1D3]"
    : "h-10 w-full rounded-md border-none bg-black px-3 text-sm text-white shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] outline-none focus:shadow-[0_0_1px_2px_#3EC1D3]";

  // 加载中或系统库为空 → 手动输入兜底
  if (!options || options.length === 0) {
    return (
      <Input
        id={id}
        value={value}
        placeholder={options === null ? "加载系统列表中…" : compact ? "手动输入系统名称" : "如：OA 办公系统 / ERP / 财务共享平台"}
        onChange={(e) => onChange(e.target.value)}
        className={compact ? "h-8 text-xs" : undefined}
      />
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectCls}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
