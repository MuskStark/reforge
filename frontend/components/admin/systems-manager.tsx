"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Plus, Server, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { SearchBox } from "@/components/ui/search-box";
import { PageHead, StateLine } from "@/components/shell/app-shell";
import { adminFetch } from "@/lib/auth";
import { invalidateSystemCache } from "@/components/system-select";
import { ADMIN_SECTION_META } from "@/lib/shell-nav";
import type { SystemOption } from "@/lib/types";

/** 后台 · 线上系统库:增删供前台表单下拉选择的线上系统。新增走页头的按钮,不再在列表顶上常驻一个输入框 */
export function SystemsManager() {
  const [systems, setSystems] = useState<SystemOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  // 新增表单的 id:底部的「添加」按钮在表单外面,靠它关联,输入框里按回车也能提交
  const formId = useId();

  const load = useCallback(async () => {
    try {
      setSystems(await adminFetch<SystemOption[]>("/api/systems"));
    } catch {
      // 会话失效由外壳处理;读不到就当空库,下面的空状态会提示
      setSystems((prev) => prev ?? []);
    }
  }, []);

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
      setSystems((prev) => (prev?.some((s) => s.id === created.id) ? prev : [...(prev ?? []), created]));
      toast.success("已添加", { description: `「${created.name}」已加入系统库` });
      setCreating(false);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      toast.error("添加失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (s: SystemOption) => {
    try {
      await adminFetch(`/api/admin/systems/${s.id}`, { method: "DELETE" });
      invalidateSystemCache();
      setSystems((prev) => (prev ?? []).filter((x) => x.id !== s.id));
      toast.success("已删除", { description: `「${s.name}」已移出系统库` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      // 显示真实原因(网络 / 网关 / 后端的说明),不留一句笼统的「请稍后重试」
      toast.error("删除失败", { description: e instanceof Error && e.message ? e.message : "请稍后重试" });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim();
    return (systems ?? []).filter((s) => !q || s.name.includes(q));
  }, [systems, query]);

  return (
    <section>
      <PageHead title={ADMIN_SECTION_META.systems.title} subtitle={ADMIN_SECTION_META.systems.lede}>
        <button
          type="button"
          onClick={() => {
            setDraft("");
            setCreating(true);
          }}
          className="btn btn-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> 新增系统
        </button>
      </PageHead>

      {systems === null ? (
        <StateLine>加载中…</StateLine>
      ) : systems.length === 0 ? (
        <section className="glass-card px-5 py-14 text-center">
          <Server className="mx-auto h-7 w-7 text-[color:var(--ink-3)]" aria-hidden="true" />
          <p className="mt-2 text-[15px] font-semibold text-neutral-900">系统库是空的</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--ink-2)]">前台填写「线上处理系统」时只能手动输入。点右上角的「新增系统」加几个常用的。</p>
        </section>
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            <SearchBox value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索系统名称" />
            <span className="ml-auto text-[13px] text-[color:var(--ink-2)]">
              {query.trim() ? `找到 ${filtered.length} 个，共 ${systems.length} 个系统` : `共 ${systems.length} 个系统`}
            </span>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3">
            {filtered.map((s) => (
              <div key={s.id} className="sys-card">
                <span className="sys-ic" aria-hidden="true">
                  <Server />
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold" title={s.name}>
                  {s.name}
                </span>
                <button type="button" onClick={() => void remove(s)} aria-label={`删除 ${s.name}`} title="删除" className="icon-btn icon-danger">
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          {filtered.length === 0 && <StateLine>没有符合搜索条件的系统</StateLine>}
        </>
      )}

      {creating && (
        <Dialog onClose={() => setCreating(false)} labelledBy="system-new-title">
          <DialogHeader id="system-new-title" title="新增系统" subtitle="添加后立即出现在前台「线上处理系统」的下拉里。" onClose={() => setCreating(false)} />
          <form
            id={formId}
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Field label="系统名称" required>
              <Input value={draft} placeholder="如：OA 办公系统" autoComplete="off" autoFocus onChange={(e) => setDraft(e.target.value)} />
            </Field>
          </form>
          <DialogActions>
            <button type="button" onClick={() => setCreating(false)} className="btn btn-glass">
              取消
            </button>
            <button type="submit" form={formId} disabled={adding || !draft.trim()} className="btn btn-primary disabled:opacity-50">
              {adding ? "添加中…" : "添加"}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
