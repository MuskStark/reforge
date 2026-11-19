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
        <Label className="text-neutral-300">{title}</Label>
        <button
          type="button"
          aria-label="添加经办记录"
          onClick={() => onChange([...handlers, { department: "", staff: [] }])}
          className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" /> 添加
        </button>
      </div>

      {handlers.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-2.5 text-xs text-neutral-500">
          暂未添加，点击右上角"添加"增加一条记录
        </p>
      )}

      <div className="space-y-3">
        {handlers.map((h, i) => (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-white/10 bg-black/40 p-3"
          >
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 shrink-0 text-neutral-500" />
              <Input
                value={h.department}
                placeholder={departmentPlaceholder}
                onChange={(e) => update(i, { department: e.target.value })}
                className="h-9"
              />
              <button
                type="button"
                onClick={() => onChange(handlers.filter((_, idx) => idx !== i))}
                aria-label="删除此条"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-500/10 hover:text-red-400 sm:h-9 sm:w-9"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-start gap-2 sm:pl-6">
              <User className="mt-2.5 h-4 w-4 shrink-0 text-neutral-500" />
              <TagInput
                placeholder="输入人员姓名后回车，可添加多个"
                tags={h.staff}
                onChange={(staff) => update(i, { staff })}
                className="flex-1"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
