"use client";

import { Building2, Plus, Trash2, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/tag-input";
import type { Handler } from "@/lib/types";

/**
 * "部门 + 人员"列表编辑器：
 * 既用于线下处理的经办部门及人员，也用于会签方配置。
 */
export function HandlerList({
  title,
  departmentLabel = "经办部门",
  departmentPlaceholder = "如：行政部",
  handlers,
  onChange,
}: {
  title: string;
  departmentLabel?: string;
  departmentPlaceholder?: string;
  handlers: Handler[];
  onChange: (handlers: Handler[]) => void;
}) {
  const update = (i: number, patch: Partial<Handler>) => {
    onChange(handlers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label>{title}</Label>
        <button
          type="button"
          aria-label="添加经办记录"
          onClick={() => onChange([...handlers, { department: "", staff: [] }])}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
        >
          <Plus className="h-3.5 w-3.5" /> 添加
        </button>
      </div>

      {handlers.length === 0 && (
        <p className="rounded-xl border border-dashed border-black/10 bg-white/30 px-3 py-2.5 text-xs text-[color:var(--ink-3)]">
          暂未添加，点击右上角"添加"增加一条记录
        </p>
      )}

      <div className="space-y-2.5">
        {handlers.map((h, i) => (
          <div
            key={i}
            className="space-y-2 rounded-2xl bg-white/50 p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]"
          >
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0 text-[color:var(--ink-3)]" />
              <Input
                value={h.department}
                placeholder={departmentPlaceholder}
                aria-label={departmentLabel}
                onChange={(e) => update(i, { department: e.target.value })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => onChange(handlers.filter((_, idx) => idx !== i))}
                aria-label="删除此条"
                className="icon-btn icon-danger !h-11 !w-11 shrink-0 sm:!h-9 sm:!w-9"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-start gap-2 sm:pl-6">
              <User className="mt-2.5 h-4 w-4 shrink-0 text-[color:var(--ink-3)]" />
              <TagInput
                placeholder="输入人员姓名后回车，可添加多个"
                tags={h.staff}
                onChange={(staff) => update(i, { staff })}
                className="min-w-0 flex-1"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
