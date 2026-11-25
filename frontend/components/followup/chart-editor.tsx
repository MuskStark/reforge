"use client";

/**
 * 流程图编辑器 A 期(设计稿 F3):画布(派生布局,自动重排)+ 右侧检查器。
 * 修改写回 steps 草稿;保存走 PUT ?via=chart。谁能保存由服务端决定:项目里的 PM / BH / TH、CTO 或管理员。
 * 布局由 steps 派生 —— 正交对齐与旁路拓扑规则永不被拖乱。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FlowGraph, type ChartSource } from "@/components/flow-graph";
import { SystemSelect } from "@/components/system-select";
import { YesNoSelect } from "@/components/yes-no-select";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { PartyEditor } from "@/components/party-editor";
import { CountersignModeBadge } from "@/components/countersign-mode-badge";
import { adminFetch } from "@/lib/auth";
import { countersignMode, needsInteropWithPrev } from "@/lib/step-checks";
import type { FlowProcess, FlowStep } from "@/lib/types";
import { emptyStep, emptyParty } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ChartEditorModal({
  process,
  onClose,
  onSaved,
}: {
  process: FlowProcess;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [steps, setSteps] = useState<FlowStep[]>(() => process.steps.map((s) => ({ ...s })));
  const [name, setName] = useState(process.name);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 撤销栈(浅拷贝快照) */
  const historyRef = useRef<FlowStep[][]>([]);
  const [canUndo, setCanUndo] = useState(false);

  const pushHistory = useCallback((cur: FlowStep[]) => {
    historyRef.current = [...historyRef.current.slice(-19), cur.map((s) => ({ ...s }))];
    setCanUndo(true);
  }, []);

  const mutate = useCallback(
    (fn: (draft: FlowStep[]) => FlowStep[]) => {
      setSteps((cur) => {
        pushHistory(cur);
        return fn(cur.map((s) => ({ ...s })));
      });
    },
    [pushHistory],
  );

  const undo = () => {
    const h = historyRef.current;
    if (!h.length) return;
    const prev = h[h.length - 1];
    historyRef.current = h.slice(0, -1);
    setCanUndo(historyRef.current.length > 0);
    setSteps(prev);
  };

  const patchStep = (id: string, patch: Partial<FlowStep>) =>
    mutate((draft) => draft.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const selected = useMemo(() => steps.find((s) => s.id === selectedId) ?? null, [steps, selectedId]);
  const selectedIdx = selected ? steps.findIndex((s) => s.id === selected.id) : -1;

  const moveStep = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    mutate((draft) => {
      [draft[idx], draft[j]] = [draft[j], draft[idx]];
      // 清理非法依赖
      return draft.map((s, k) => {
        if (!s.waitFor?.stepId) return s;
        const d = draft.findIndex((x) => x.id === s.waitFor!.stepId);
        if (d < 0 || d >= k || !draft[d].countersign) return { ...s, waitFor: null };
        return s;
      });
    });
  };

  const removeStep = (idx: number) => {
    if (steps.length <= 1) {
      toast.error("至少保留一个步骤");
      return;
    }
    const victim = steps[idx];
    mutate((draft) =>
      draft
        .filter((s) => s.id !== victim.id)
        .map((s) => (s.waitFor?.stepId === victim.id ? { ...s, waitFor: null } : s)),
    );
    setSelectedId(null);
  };

  const addStep = (countersign = false) => {
    const s = emptyStep(countersign ? "新会签步骤" : "新步骤");
    if (countersign) s.parties = [{ ...emptyParty(), department: "会签部门" }];
    mutate((draft) => [...draft, s]);
    setSelectedId(s.id);
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        name,
        description: process.description,
        applicant: process.applicant,
        steps,
      };
      await adminFetch(`/api/admin/processes/${process.id}?via=chart`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast.success("流程图已保存", { description: `${name} · 共 ${steps.length} 步` });
      onSaved();
    } catch (e) {
      toast.error("保存失败", {
        description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请检查必填项后重试",
      });
    } finally {
      setBusy(false);
    }
  };

  const source: ChartSource = useMemo(() => ({ name, steps }), [name, steps]);

  return (
    <div className="fixed inset-0 z-[90] overflow-y-auto bg-[rgba(18,26,48,0.36)] backdrop-blur-md">
      <div className="mx-auto flex min-h-screen max-w-[1440px] flex-col p-4 sm:p-6">
        {/* 工具栏 */}
        <div className="lg-clear sticky top-2 z-50 flex h-[56px] shrink-0 items-center gap-2 px-2.5">
          <button type="button" onClick={onClose} className="nav-action !px-3" aria-label="返回">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 6l-6 6 6 6" /></svg>
          </button>
          <span className="ml-1 flex items-center gap-2 text-[15px] font-semibold">
            流程图编辑
            <i className={cn("h-2 w-2 rounded-full", canUndo ? "bg-[color:var(--red)] shadow-[0_0_0_3px_rgba(255,59,48,0.15)]" : "bg-transparent")} title={canUndo ? "有未保存修改" : undefined} />
          </span>
          <span className="hidden text-xs text-[color:var(--ink-3)] md:inline">点选节点 / 会签容器编辑 · 图自动重排</span>
          <span className="flex-1" />
          <button className="btn btn-glass !h-[38px] !px-3.5 text-[13px]" onClick={() => addStep(false)}>＋ 添加步骤</button>
          <button className="btn btn-glass !h-[38px] !px-3.5 text-[13px]" style={{ color: "var(--amber-deep)" }} onClick={() => addStep(true)}>＋ 添加会签</button>
          <span className="mx-1 h-5 w-px bg-[color:var(--sep)]" />
          <button className="icon-btn !h-9 !w-9" disabled={!canUndo} onClick={undo} title="撤销" aria-label="撤销">
            <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5 3.5 9.5 8 14M3.5 9.5H15a5.5 5.5 0 0 1 0 11h-3" /></svg>
          </button>
          <button className="btn btn-primary !h-[38px] !px-4 text-[14px]" disabled={busy} onClick={() => void save()}>保存</button>
        </div>

        <div className="mt-4 grid flex-1 items-start gap-4 lg:grid-cols-[1fr_348px]">
          {/* 画布 */}
          <div className="glass-card !rounded-[26px] p-1.5 lg:sticky lg:top-[84px]">
            <FlowGraph source={source} selectedStepId={selectedId} onSelectStep={setSelectedId} />
            <p className="px-3 pb-1.5 pt-1 text-center text-[11px] text-[color:var(--ink-3)]">
              主干中轴对齐 · 会签旁路容器 · 修改后自动重排(布局规则不被破坏) · 虚线 = 线上↔线下衔接或系统数据不互通
            </p>
          </div>

          {/* 检查器 */}
          <aside
            className="rounded-[26px] p-[18px] lg:sticky lg:top-[84px]"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.5))",
              backdropFilter: "blur(28px) saturate(200%)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.98), inset 0 0 0 0.5px rgba(255,255,255,0.65), 0 28px 64px -28px rgba(23,42,80,0.28)",
            }}
          >
            {!selected ? (
              <div className="py-14 text-center">
                <p className="text-[14px] font-medium text-[color:var(--ink-2)]">未选中对象</p>
                <p className="mt-2 px-4 text-xs leading-relaxed text-[color:var(--ink-3)]">
                  点击画布中的步骤节点或琥珀色会签容器进行编辑;<br />画布空白处拖动平移,双指缩放
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2.5 border-b border-[color:var(--sep)] pb-3">
                  <span
                    className={cn(
                      "grid h-[26px] w-[26px] place-items-center text-[12px] font-bold",
                      selected.countersign
                        ? "rotate-45 rounded-[8px] bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]"
                        : "rounded-full bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
                    )}
                  >
                    <span className={selected.countersign ? "-rotate-45" : undefined}>{selectedIdx + 1}</span>
                  </span>
                  <b className="min-w-0 flex-1 truncate text-[15px]">{selected.name || "(未命名)"}</b>
                  <span className={cn("badge shrink-0", selected.countersign ? "badge-amber" : "badge-blue")} style={{ height: 22 }}>
                    {selected.countersign ? "会签容器" : "步骤"}
                  </span>
                  {/* 会签整体办理方式标识(由各方内部子步骤汇总) */}
                  {selected.countersign && (
                    <CountersignModeBadge mode={countersignMode(selected)} className="shrink-0" />
                  )}
                </div>

                <div className="mt-3.5 grid gap-3.5">
                  <div>
                    <div className="field-label">名称 <span className="text-[color:var(--red)]">*</span></div>
                    <input
                      className="field"
                      value={selected.name}
                      onChange={(e) => patchStep(selected.id, { name: e.target.value })}
                    />
                  </div>

                  {!selected.countersign && (
                    <>
                      <div>
                        <div className="field-label">处理方式</div>
                        <div className="seg">
                          <button className={selected.mode === "online" ? "on" : undefined} onClick={() => patchStep(selected.id, { mode: "online" })}>线上系统</button>
                          <button className={selected.mode === "offline" ? "on" : undefined} onClick={() => patchStep(selected.id, { mode: "offline" })}>线下办理</button>
                        </div>
                      </div>
                      {selected.mode === "online" ? (
                        <>
                          <div>
                            <div className="field-label">线上处理系统 <span className="text-[color:var(--red)]">*</span></div>
                            <SystemSelect
                              value={selected.online.systemName}
                              onChange={(v) => patchStep(selected.id, { online: { ...selected.online, systemName: v } })}
                            />
                          </div>
                          <YesNoSelect
                            label="是否支持移动端"
                            value={selected.online.mobileSupported}
                            onChange={(v) => patchStep(selected.id, { online: { ...selected.online, mobileSupported: v } })}
                            className="!bg-white/45"
                          />
                          {(() => {
                            // 与上一步均为线上且系统不同(上一步为会签时取各方末位子步骤的系统):需填写数据互通
                            const prevSystems = needsInteropWithPrev(steps, selectedIdx);
                            if (prevSystems.length === 0) return null;
                            return (
                              <YesNoSelect
                                label={`「${prevSystems.join("、")} → ${selected.online.systemName.trim()}」数据互通`}
                                value={selected.online.dataInteroperable ?? null}
                                onChange={(v) => patchStep(selected.id, { online: { ...selected.online, dataInteroperable: v } })}
                                hint="两系统是否自动共享数据"
                                className="!bg-white/45"
                              />
                            );
                          })()}
                        </>
                      ) : (
                        <>
                          <TagInput
                            label="涉及文件名称"
                            placeholder="回车添加,如:合同正本"
                            tags={selected.offline.documents}
                            onChange={(documents) => patchStep(selected.id, { offline: { ...selected.offline, documents } })}
                          />
                          <HandlerList
                            title="线下经办部门及人员"
                            handlers={selected.offline.handlers}
                            onChange={(handlers) => patchStep(selected.id, { offline: { ...selected.offline, handlers } })}
                          />
                        </>
                      )}

                      {/* 前置会签依赖 */}
                      {selectedIdx > 0 && (
                        <div className="rounded-2xl bg-[linear-gradient(180deg,rgba(240,240,255,0.55),rgba(255,255,255,0.5))] p-3 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.28)]">
                          <div className="field-label" style={{ color: "var(--indigo-deep)" }}>前置会签依赖</div>
                          <div className="relative">
                            <select
                              className="field pr-9"
                              value={selected.waitFor?.stepId ?? ""}
                              onChange={(e) => {
                                const stepId = e.target.value;
                                patchStep(selected.id, { waitFor: stepId ? { stepId, partyId: "" } : null });
                              }}
                            >
                              <option value="">不设置(上一步完成即执行)</option>
                              {steps.slice(0, selectedIdx).filter((s) => s.countersign).map((s) => (
                                <option key={s.id} value={s.id}>等待「{steps.findIndex((x) => x.id === s.id) + 1}. {s.name || "未命名"}」会签</option>
                              ))}
                            </select>
                            <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9.5l6 6 6-6" /></svg>
                          </div>
                          {selected.waitFor?.stepId && (() => {
                            const dep = steps.find((s) => s.id === selected.waitFor!.stepId);
                            if (!dep) return null;
                            return dep.parties.length > 0 ? (
                              <div className="relative mt-2">
                                <select
                                  className="field pr-9"
                                  value={selected.waitFor.partyId ?? ""}
                                  onChange={(e) => patchStep(selected.id, { waitFor: { stepId: dep.id, partyId: e.target.value } })}
                                >
                                  <option value="">整个会签全部通过</option>
                                  {dep.parties.map((pt, j) => (
                                    <option key={pt.id} value={pt.id}>仅等待「{pt.department || `会签方${j + 1}`}」分支通过</option>
                                  ))}
                                </select>
                                <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9.5l6 6 6-6" /></svg>
                              </div>
                            ) : null;
                          })()}
                        </div>
                      )}
                    </>
                  )}

                  {selected.countersign && (
                    <div className="rounded-2xl bg-[linear-gradient(180deg,rgba(255,246,231,0.6),rgba(255,243,224,0.42))] p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.7),inset_0_0_0_0.5px_rgba(178,106,0,0.14)]">
                      <PartyEditor
                        parties={selected.parties}
                        onChange={(parties) => patchStep(selected.id, { parties })}
                      />
                    </div>
                  )}

                  {/* 位置与删除 */}
                  <div className="flex gap-2 border-t border-[color:var(--sep)] pt-3.5">
                    <button className="btn btn-glass flex-1 !h-[38px] text-[13px]" disabled={selectedIdx === 0} onClick={() => moveStep(selectedIdx, -1)}>
                      ↑ 在轴上移
                    </button>
                    <button className="btn btn-glass flex-1 !h-[38px] text-[13px]" disabled={selectedIdx === steps.length - 1} onClick={() => moveStep(selectedIdx, 1)}>
                      ↓ 下移
                    </button>
                    <button
                      className="btn btn-glass !h-[38px] !px-3.5 text-[13px]"
                      style={{ color: "var(--red-deep)" }}
                      disabled={steps.length <= 1}
                      onClick={() => removeStep(selectedIdx)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
