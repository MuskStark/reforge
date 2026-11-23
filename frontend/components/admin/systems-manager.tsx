"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Monitor, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { adminFetch } from "@/lib/auth";
import { invalidateSystemCache } from "@/components/system-select";
import type { SystemOption } from "@/lib/types";

/** 后台 · 线上系统库管理：增删供前台表单下拉选择的线上系统 */
export function SystemsManager({ onLogout }: { onLogout: () => void }) {
  const [systems, setSystems] = useState<SystemOption[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setSystems(await adminFetch<SystemOption[]>("/api/systems"));
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const name = draft.trim();
    if (!name) {
      toast.error("请输入系统名称");
      return;
    }
    setAdding(true);
    try {
      const created = await adminFetch<SystemOption>("/api/admin/systems", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      invalidateSystemCache();
      setSystems((prev) =>
        prev.some((s) => s.id === created.id) ? prev : [...prev, created],
      );
      setDraft("");
      toast.success("已添加", { description: `「${created.name}」已加入系统库` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("添加失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: SystemOption) => {
    try {
      await adminFetch(`/api/admin/systems/${s.id}`, { method: "DELETE" });
      invalidateSystemCache();
      setSystems((prev) => prev.filter((x) => x.id !== s.id));
      toast.success("已删除", { description: `「${s.name}」已移出系统库` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("删除失败", { description: "请稍后重试" });
    }
  };

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-[22px] font-bold tracking-[-0.02em]">
          线上系统库
          <span className="badge badge-plain">{systems.length}</span>
        </h2>
        <p className="ml-auto text-xs text-[color:var(--ink-2)]">
          维护可选的线上系统，前台填写时只需下拉选择
        </p>
      </div>
      <div className="glass-card p-5">

      {/* 添加行 */}
      <div className="mb-3 flex gap-2">
        <Input
          value={draft}
          placeholder="输入线上系统名称，如：OA 办公系统"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          className="!h-11"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={adding}
          className="btn btn-primary !h-11 shrink-0 !px-4 text-sm disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> 添加系统
        </button>
      </div>

      {/* 系统清单 */}
      {systems.length === 0 ? (
        <p className="rounded-xl border border-dashed border-black/10 bg-white/30 px-3 py-2.5 text-xs text-[color:var(--ink-3)]">
          系统库为空——前台填写时将退回手动输入
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {systems.map((s) => (
            <span
              key={s.id}
              className="tag-chip"
            >
              <Monitor className="h-3 w-3 text-[color:var(--ink-3)]" />
              {s.name}
              <button
                type="button"
                onClick={() => void remove(s)}
                aria-label={`删除 ${s.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      </div>
    </section>
  );
}
