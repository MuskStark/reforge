"use client";

import { Building2, Plus, Trash2, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/tag-input";
import { RequiredEmpty } from "@/components/required-empty";
import type { Handler } from "@/lib/types";
import { cn } from "@/lib/utils";

const isValid = (h: Handler) => h.department.trim() || h.staff.some((x) => x.trim());

/**
 * "部门 + 人员"列表编辑器：
 * 既用于线下处理的经办部门及人员，也用于会签方配置。
 * required = 这一项必填(线下办理的经办方):标题带必填标记,空列表显示醒目的添加入口,
 * 填了一行但部门和人员都是空的,会提示至少填一项。
 * error = 已经点过提交仍然缺失:提示加重。
 */
export function HandlerList({
  title,
  departmentLabel = "经办部门",
  departmentPlaceholder = "如：行政部",
  handlers,
  onChange,
  required = false,
  error = false,
  id,
}: {
  title: string;
  departmentLabel?: string;
  departmentPlaceholder?: string;
  handlers: Handler[];
  onChange: (handlers: Handler[]) => void;
  required?: boolean;
  error?: boolean;
  id?: string;
}) {
  const update = (i: number, patch: Partial<Handler>) => {
    onChange(handlers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  };
  const missing = required && !handlers.some(isValid);

  return (
    <div id={id} className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex flex-wrap items-center gap-x-1.5">
          {title}
          {required && <span className="text-[color:var(--red)]">*</span>}
          {required && <span className="text-xs font-normal text-[color:var(--ink-3)]">必填</span>}
        </Label>
        {(!required || handlers.length > 0) && (
          <button
            type="button"
            aria-label="添加经办记录"
            onClick={() => onChange([...handlers, { department: "", staff: [] }])}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
          >
            <Plus className="h-3.5 w-3.5" /> {handlers.length > 0 ? "再添加一条" : "添加"}
          </button>
        )}
      </div>

      {handlers.length === 0 &&
        (required ? (
          <RequiredEmpty
            title={`还没有添加${title}`}
            hint="线下办理的步骤，必须写明由哪个部门、哪些人来受理。部门或人员至少填一项，可以添加多条。"
            actionLabel={`添加${title}`}
            error={error}
            onAdd={() => onChange([{ department: "", staff: [] }])}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-black/10 bg-white/30 px-3 py-2.5 text-xs text-[color:var(--ink-3)]">
            暂未添加，点击右上角"添加"增加一条记录
          </p>
        ))}

      <div className="space-y-2.5">
        {handlers.map((h, i) => {
          const blank = required && !isValid(h);
          const bad = blank && error;
          return (
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
                  aria-invalid={bad}
                  onChange={(e) => update(i, { department: e.target.value })}
                  className={cn("h-9", bad && "field-invalid")}
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
              {blank && (
                <p className={cn("text-xs", bad ? "font-medium text-[color:var(--red-deep)]" : "text-[color:var(--ink-2)]")}>
                  {bad ? "还没有填：部门或人员至少填一项" : "部门或人员至少填一项"}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
