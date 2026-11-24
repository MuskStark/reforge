"use client";

import { useState } from "react";
import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * 标签输入框：输入后回车（或点击加号）追加标签，点 × 删除。
 * 用于"涉及文件名称""涉及人员"等多值字段。
 * optional = 标签后注明"选填"(必填项另有星号标记,避免把选填项误当成必填)。
 */
export function TagInput({
  label,
  placeholder,
  tags,
  onChange,
  className,
  optional = false,
}: {
  label?: string;
  placeholder?: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  className?: string;
  optional?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const t = draft.trim();
    if (!t) return;
    if (!tags.includes(t)) onChange([...tags, t]);
    setDraft("");
  };

  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <Label>
          {label}
          {optional && <span className="font-normal text-[color:var(--ink-3)]">选填</span>}
        </Label>
      )}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Backspace" && !draft && tags.length) {
                onChange(tags.slice(0, -1));
              }
            }}
          />
        </div>
        <button
          type="button"
          onClick={commit}
          aria-label="添加"
          className="icon-btn !h-11 !w-11 shrink-0 text-[color:var(--ink-2)] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)] bg-white/60 hover:bg-white/85"
        >
          <Plus className="h-4.5 w-4.5" />
        </button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
              <button
                type="button"
                onClick={() => onChange(tags.filter((t) => t !== tag))}
                aria-label={`删除 ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
