"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/tag-input";
import { PageHead, StateLine } from "@/components/shell/app-shell";
import { authFetch } from "@/lib/auth";
import { MODE_LABEL } from "@/lib/labels";
import { ADMIN_SECTION_META } from "@/lib/shell-nav";
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

/**
 * 后台 · 阶段模板:流程项目从立项到运营经过哪些阶段、出口关卡由谁按什么规则评审、必交付物与默认任务。
 * 模板只影响此后新建的项目;已立项的项目沿用立项时的模板快照,不随这里的改动变化。
 * 每个阶段先以摘要卡示人(关卡 / 评审 / 交付物),点开才编辑。
 */
export function StageTemplates() {
  const [saved, setSaved] = useState<StageTemplate[] | null>(null);
  const [draft, setDraft] = useState<StageTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [askRemove, setAskRemove] = useState<number | null>(null);
  // 正在编辑第几个阶段(一次只展开一个;新加的阶段直接展开)
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const normalize = (list: StageTemplate[]) =>
    (list ?? []).map((t, i) => ({ ...t, seq: i + 1, required: t.required ?? [], tasks: t.tasks ?? [] }));

  const load = useCallback(async () => {
    try {
      const list = normalize(await authFetch<StageTemplate[]>(API, { cache: "no-store" }));
      setSaved(list);
      setDraft(list);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      toast.error("读取失败", { description: "无法获取阶段模板" });
      setSaved((prev) => prev ?? []);
    }
  }, []);

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

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    setDraft((prev) => {
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next.map((t, k) => ({ ...t, seq: k + 1 }));
    });
    // 展开的那一个跟着走
    setOpenIdx((cur) => (cur === i ? j : cur === j ? i : cur));
  };

  const remove = (i: number) => {
    setDraft((prev) => prev.filter((_, k) => k !== i).map((t, k) => ({ ...t, seq: k + 1 })));
    setAskRemove(null);
    setOpenIdx(null);
  };

  const addStage = () => {
    setDraft((prev) => [...prev, { ...emptyStage(), seq: prev.length + 1 }]);
    setOpenIdx(draft.length);
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
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      toast.error("保存失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setAskReset(false);
    try {
      setDraft(normalize(await authFetch<StageTemplate[]>(`${API}?builtin=1`, { cache: "no-store" })));
      setOpenIdx(null);
      toast.message("已载入内置模板", { description: "确认无误后点「保存模板」生效" });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      toast.error("读取失败", { description: "无法获取内置模板" });
    }
  };

  const removing = askRemove != null ? draft[askRemove] : null;
  const stateText = !saved ? "" : blank > 0 ? "有阶段还没填名称" : dirty ? "有未保存的修改" : "已是最新";

  return (
    <section>
      <PageHead title={ADMIN_SECTION_META.stages.title} subtitle={ADMIN_SECTION_META.stages.lede}>
        {dirty && <span className="badge badge-amber">{stateText}</span>}
        <button type="button" onClick={addStage} className="btn btn-glass">
          <Plus className="h-4 w-4" aria-hidden="true" /> 添加阶段
        </button>
        <button type="button" onClick={() => setAskReset(true)} className="btn btn-glass">
          <RotateCcw className="h-4 w-4" aria-hidden="true" /> 载入内置模板
        </button>
        <button type="button" onClick={() => void save()} disabled={!dirty || busy || blank > 0 || draft.length === 0} className="btn btn-primary disabled:opacity-50">
          <Save className="h-4 w-4" aria-hidden="true" /> 保存模板
        </button>
      </PageHead>

      {saved === null ? (
        <StateLine>加载中…</StateLine>
      ) : (
        <ol className="glass-card space-y-0 px-4 py-4 sm:px-6">
          {draft.map((t, i) => {
            const gated = t.gate.trim() !== "";
            const meaning = meaningOf(t.key);
            const open = openIdx === i;
            return (
              <li key={t.key || `new-${i}`} className="flex gap-3 sm:gap-3.5">
                {/* 时间轨:珠 + 连线 */}
                <div className="stage-rail-col pt-1" aria-hidden="true">
                  <span className="rail-node" style={{ width: 30, height: 30, fontSize: 12 }}>
                    {i + 1}
                  </span>
                  {i < draft.length - 1 && <span className="rail-line" />}
                </div>

                <div className="min-w-0 flex-1 pb-3">
                  <div className={cn("stage-summary", open && "bg-white/70")}>
                    {/* 摘要态:整行是开关 */}
                    <button
                      type="button"
                      onClick={() => setOpenIdx(open ? null : i)}
                      aria-expanded={open}
                      className="flex w-full flex-wrap items-center gap-2 px-4 py-3.5 text-left"
                    >
                      {t.name.trim() ? (
                        <span className="text-[16px] font-semibold text-neutral-900">{t.name}</span>
                      ) : (
                        <span className="text-[16px] font-semibold text-[color:var(--red-deep)]">未命名阶段</span>
                      )}
                      {t.key && <span className="font-data text-xs text-[color:var(--ink-3)]">{t.key}</span>}
                      {meaning && <span className={cn("badge !h-[20px] text-[11px]", t.key === "design" ? "badge-indigo" : "badge-green")}>{meaning}</span>}
                      {i === 0 && <span className="badge badge-plain !h-[20px] text-[11px]">项目起点</span>}
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[color:var(--ink-3)]">
                        <span className="mr-1 hidden text-xs sm:inline">{open ? "收起" : "编辑"}</span>
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    </button>

                    {open ? (
                      /* 编辑态 */
                      <div className="border-t border-[color:var(--sep)] px-4 py-4">
                        <Field label="阶段名称" required>
                          <Input
                            value={t.name}
                            placeholder="阶段名称，如：需求确认"
                            aria-label={`第 ${i + 1} 个阶段的名称`}
                            className={cn("!h-10 !text-[15px] font-semibold", !t.name.trim() && "!ring-2 !ring-[color:var(--red)]")}
                            onChange={(e) => patch(i, { name: e.target.value })}
                          />
                        </Field>

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
                              <option value="handler">BH（业务经办）</option>
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

                        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[color:var(--sep)] pt-3">
                          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="btn btn-glass !h-9 !px-3.5 text-[13px] disabled:opacity-40" aria-label="上移" title="上移">
                            <ArrowUp className="h-4 w-4" aria-hidden="true" /> 上移
                          </button>
                          <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1} className="btn btn-glass !h-9 !px-3.5 text-[13px] disabled:opacity-40" aria-label="下移" title="下移">
                            <ArrowDown className="h-4 w-4" aria-hidden="true" /> 下移
                          </button>
                          <button
                            type="button"
                            onClick={() => setAskRemove(i)}
                            disabled={draft.length <= 1}
                            className="btn btn-glass ml-auto !h-9 !px-3.5 text-[13px] text-[color:var(--red-deep)] disabled:opacity-40"
                            aria-label={`移除阶段 ${t.name || i + 1}`}
                            title={draft.length <= 1 ? "至少保留一个阶段" : "移除这个阶段"}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" /> 移除
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 摘要态 */
                      <>
                        <div className="stage-facts px-4">
                          <span>
                            <span className="lbl">出口关卡</span>
                            <b>{gated ? t.gate : "没有评审关卡"}</b>
                          </span>
                          {gated && (
                            <span>
                              <span className="lbl">评审方式</span>
                              <b>{MODE_LABEL[t.mode] ?? "—"}</b>
                            </span>
                          )}
                          {gated && (
                            <span>
                              <span className="lbl">评审人</span>
                              <b>{t.reviewerRole === "cto" ? "CTO" : t.reviewerRole === "handler" ? "BH" : "—"}</b>
                            </span>
                          )}
                        </div>
                        <div className="stage-chips px-4 pb-3.5">
                          <span className="stage-chip stage-chip-label">必交付物</span>
                          {t.required.length ? t.required.map((r) => <span key={r} className="stage-chip">{r}</span>) : <span className="text-xs text-[color:var(--ink-3)]">无</span>}
                          <span className="w-2" aria-hidden="true" />
                          <span className="stage-chip stage-chip-label">默认任务</span>
                          {t.tasks.length ? (
                            t.tasks.map((task) => (
                              <span key={task} className="stage-chip is-task">
                                <Plus aria-hidden="true" />
                                {task}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-[color:var(--ink-3)]">无</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}

          {draft.length === 0 && (
            <li className="py-6 text-center text-sm text-[color:var(--ink-3)]">
              模板是空的。
              <button type="button" onClick={addStage} className="ml-1 font-semibold text-[color:var(--tint)]">
                添加第一个阶段
              </button>
            </li>
          )}
        </ol>
      )}

      {/* 有未保存的修改时停在视口底部:改到第几个阶段都能直接保存或放弃 */}
      {saved && dirty && (
        <div className="lg-clear sticky bottom-3 z-10 mt-3 flex flex-wrap items-center gap-2.5 px-4 py-3">
          <span className={cn("text-[13px] font-medium", blank > 0 || dirty ? "text-[color:var(--amber-deep)]" : "text-[color:var(--ink-3)]")}>{stateText}</span>
          <button type="button" onClick={() => setDraft(saved ?? [])} className="btn btn-glass ml-auto !h-10">
            放弃修改
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || blank > 0 || draft.length === 0} className="btn btn-primary !h-10 disabled:opacity-50">
            <Save className="h-4 w-4" aria-hidden="true" /> 保存模板
          </button>
        </div>
      )}

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
