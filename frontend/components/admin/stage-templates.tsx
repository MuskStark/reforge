"use client";

/**
 * 后台 · 阶段模板:流程项目从立项到运营经过哪些阶段、出口关卡由谁按什么规则评审、必交付物与默认任务。
 * 模板只影响此后新建的项目;已立项的项目沿用立项时的模板快照,不随这里的改动变化。
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/tag-input";
import { authFetch } from "@/lib/auth";
import { MODE_LABEL } from "@/lib/labels";
import type { StageTemplate } from "@/lib/types";
import { cn } from "@/lib/utils";

const API = "/api/admin/stage-templates";

/** 两个带语义的阶段标识:标识不可改,所以这条规则跟着阶段走 */
function meaningOf(key: string): string | null {
  if (key === "design") return "通过时留存 To-Be 基线";
  if (key === "accept") return "通过时留存已发布版本，且通过后才能标记项目完成";
  return null;
}

const emptyStage = (): StageTemplate => ({
  seq: 0,
  key: "",
  name: "",
  gate: "",
  reviewerRole: "",
  mode: "",
  required: [],
  tasks: [],
});

export function StageTemplates({ onLogout }: { onLogout: () => void }) {
  const [saved, setSaved] = useState<StageTemplate[] | null>(null);
  const [draft, setDraft] = useState<StageTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [askRemove, setAskRemove] = useState<number | null>(null);

  const normalize = (list: StageTemplate[]) =>
    (list ?? []).map((t, i) => ({ ...t, seq: i + 1, required: t.required ?? [], tasks: t.tasks ?? [] }));

  const load = useCallback(async () => {
    try {
      const list = normalize(await authFetch<StageTemplate[]>(API, { cache: "no-store" }));
      setSaved(list);
      setDraft(list);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("读取失败", { description: "无法获取阶段模板" });
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const blank = draft.filter((t) => !t.name.trim()).length;

  const patch = (i: number, p: Partial<StageTemplate>) => setDraft((prev) => prev.map((t, k) => (k === i ? { ...t, ...p } : t)));

  // 没有关卡就谈不上评审:关卡清空时评审规则一并清掉,填上时给个常用的默认值
  const setGate = (i: number, gate: string) => {
    const cur = draft[i];
    if (!cur) return;
    patch(i, gate.trim() === "" ? { gate, reviewerRole: "", mode: "" } : { gate, reviewerRole: cur.reviewerRole || "cto", mode: cur.mode || "all" });
  };

  const move = (i: number, dir: -1 | 1) =>
    setDraft((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((t, k) => ({ ...t, seq: k + 1 }));
    });

  const remove = (i: number) => {
    setDraft((prev) => prev.filter((_, k) => k !== i).map((t, k) => ({ ...t, seq: k + 1 })));
    setAskRemove(null);
  };

  const save = async () => {
    if (blank > 0) {
      toast.error("有阶段还没填名称");
      return;
    }
    setBusy(true);
    try {
      // 序号由后端按顺序重新编排
      const list = normalize(
        await authFetch<StageTemplate[]>(API, {
          method: "PUT",
          body: JSON.stringify({
            templates: draft.map(({ seq: _s, ...rest }) => rest),
          }),
        }),
      );
      setSaved(list);
      setDraft(list);
      toast.success("模板已保存", { description: `共 ${list.length} 个阶段，只影响此后新建的项目` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("保存失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setAskReset(false);
    try {
      setDraft(normalize(await authFetch<StageTemplate[]>(`${API}?builtin=1`, { cache: "no-store" })));
      toast.message("已载入内置模板", { description: "确认无误后点「保存模板」生效" });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("读取失败", { description: "无法获取内置模板" });
    }
  };

  const removing = askRemove != null ? draft[askRemove] : null;

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-[22px] font-bold tracking-[-0.02em]">
          阶段模板
          <span className="badge badge-plain">{draft.length} 个阶段</span>
        </h2>
        <p className="text-xs text-[color:var(--ink-2)]">项目立项时按这个模板生成阶段、评审规则与工作项</p>
      </div>

      <div className="mb-3 rounded-2xl bg-[color:var(--indigo-soft)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--indigo-deep)] shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.22)]">
        <b>改动只影响此后新建的项目。</b>已立项的项目沿用立项时的模板，不会被这里的变化打乱进度。
        {saved == null && " 正在读取当前模板…"}
      </div>

      {saved && (
        <ol className="grid gap-3">
          {draft.map((t, i) => {
            const gated = t.gate.trim() !== "";
            const meaning = meaningOf(t.key);
            return (
              <li
                key={t.key || `new-${i}`}
                className="rounded-[22px] bg-white/50 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-data grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[color:var(--tint-soft)] text-[13px] font-semibold text-[color:var(--tint)]">
                    {i + 1}
                  </span>
                  <Input
                    value={t.name}
                    placeholder="阶段名称，如：需求确认"
                    aria-label={`第 ${i + 1} 个阶段的名称`}
                    className={cn("!h-10 w-full max-w-[280px] !text-[15px] font-semibold", !t.name.trim() && "!ring-2 !ring-[color:var(--red)]")}
                    onChange={(e) => patch(i, { name: e.target.value })}
                  />
                  {meaning && <span className={cn("badge", t.key === "design" ? "badge-indigo" : "badge-green")}>{meaning}</span>}
                  {i === 0 && <span className="badge badge-plain">项目起点</span>}
                  <div className="ml-auto flex items-center gap-0.5">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="icon-btn !h-9 !w-9 disabled:opacity-30" aria-label="上移" title="上移">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1} className="icon-btn !h-9 !w-9 disabled:opacity-30" aria-label="下移" title="下移">
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setAskRemove(i)}
                      disabled={draft.length <= 1}
                      className="icon-btn icon-danger !h-9 !w-9 disabled:opacity-30"
                      aria-label={`移除阶段 ${t.name || i + 1}`}
                      title={draft.length <= 1 ? "至少保留一个阶段" : "移除这个阶段"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_170px_190px]">
                  <Field label="出口关卡" hint="留空 = 没有评审关卡">
                    <Input value={t.gate} placeholder="如：G2 需求基线" onChange={(e) => setGate(i, e.target.value)} />
                  </Field>
                  <Field label="评审人">
                    <select className="field !h-10 disabled:opacity-50" value={t.reviewerRole} disabled={!gated} onChange={(e) => patch(i, { reviewerRole: e.target.value as StageTemplate["reviewerRole"] })}>
                      <option value="" disabled>
                        无关卡
                      </option>
                      <option value="cto">CTO</option>
                      <option value="handler">经办</option>
                    </select>
                  </Field>
                  <Field label="表决方式">
                    <select className="field !h-10 disabled:opacity-50" value={t.mode} disabled={!gated} onChange={(e) => patch(i, { mode: e.target.value as StageTemplate["mode"] })}>
                      <option value="" disabled>
                        无关卡
                      </option>
                      <option value="all">{MODE_LABEL.all} · 全部通过才算过</option>
                      <option value="any">{MODE_LABEL.any} · 首位表决人决定</option>
                    </select>
                  </Field>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <TagInput label="必交付物（未完成不能提交评审）" placeholder="输入后回车添加" tags={t.required} onChange={(tags) => patch(i, { required: tags })} />
                  <TagInput label="默认任务（立项时自动生成）" placeholder="输入后回车添加" tags={t.tasks} onChange={(tags) => patch(i, { tasks: tags })} />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* 操作条:停在视口底部,改到第几个阶段都能直接保存 */}
      <div className="lg-clear sticky bottom-3 z-10 mt-3 flex flex-wrap items-center gap-2.5 px-4 py-3">
        <button type="button" onClick={() => setDraft((prev) => [...prev, { ...emptyStage(), seq: prev.length + 1 }])} className="btn btn-glass !h-10">
          <Plus className="h-4 w-4" /> 添加阶段
        </button>
        <button type="button" onClick={() => setAskReset(true)} className="btn btn-glass !h-10">
          <RotateCcw className="h-4 w-4" /> 恢复内置模板
        </button>
        <span className={cn("ml-auto text-xs", dirty ? "font-medium text-[color:var(--amber-deep)]" : "text-[color:var(--ink-3)]")}>
          {!saved ? "" : dirty ? (blank > 0 ? "有阶段还没填名称" : "有未保存的修改") : "已是最新"}
        </span>
        {dirty && (
          <button type="button" onClick={() => setDraft(saved ?? [])} className="btn btn-glass !h-10">
            放弃修改
          </button>
        )}
        <button type="button" onClick={() => void save()} disabled={!dirty || busy || blank > 0 || draft.length === 0} className="btn btn-primary !h-10 disabled:opacity-50">
          <Save className="h-4 w-4" /> 保存模板
        </button>
      </div>

      {askReset && (
        <Dialog onClose={() => setAskReset(false)} labelledBy="tpl-reset-title">
          <DialogHeader id="tpl-reset-title" title="载入内置模板？" subtitle="七个阶段的内置模板会替换上面的内容，点「保存模板」后才生效。已立项的项目不受影响。" onClose={() => setAskReset(false)} />
          <DialogActions>
            <button type="button" onClick={() => setAskReset(false)} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => void reset()} className="btn btn-primary">
              载入
            </button>
          </DialogActions>
        </Dialog>
      )}

      {removing && (
        <Dialog onClose={() => setAskRemove(null)} labelledBy="tpl-remove-title">
          <DialogHeader
            id="tpl-remove-title"
            title={`移除阶段「${removing.name || `第 ${removing.seq} 个`}」？`}
            subtitle="保存后，新建的项目将不再有这个阶段。已立项的项目不受影响。"
            onClose={() => setAskRemove(null)}
          />
          <DialogActions>
            <button type="button" onClick={() => setAskRemove(null)} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => remove(removing.seq - 1)} className="btn btn-glass text-[color:var(--red-deep)]">
              移除
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
