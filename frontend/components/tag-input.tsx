"use client";

import { useState } from "react";
import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * 标签输入框：输入后回车（或点击加号）追加标签，点 × 删除。
 * 用于"涉及文件名称""涉及人员"等多值字段。
 */
export function TagInput({
  label,
  placeholder,
  tags,
  onChange,
  className,
}: {
  label?: string;
  placeholder?: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const t = draft.trim();
    if (!t) return;
    if (!tags.includes(t)) onChange([...tags, t]);
    setDraft("");
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <Label className="text-neutral-300">{label}</Label>}
      <div className="flex gap-2">
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
        <button
          type="button"
          onClick={commit}
          aria-label="添加"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-400 shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] transition hover:text-white hover:shadow-[0_0_1px_2px_rgba(255,255,255,0.3)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="group inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 py-0.5 pl-2.5 pr-1.5 text-xs text-neutral-200"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(tags.filter((t) => t !== tag))}
                aria-label={`删除 ${tag}`}
                className="rounded-full p-0.5 text-neutral-500 transition hover:bg-white/10 hover:text-white"
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
