"use client";

import { useState } from "react";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSignature,
  ListOrdered,
  Plus,
  Trash2,
  User,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { SystemSelect } from "@/components/system-select";
import { YesNoSelect } from "@/components/yes-no-select";
import {
  emptyParty,
  emptySubStep,
  normalizeSubStep,
  type CountersignParty,
  type SubStep,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** 会签方折叠状态：复杂流程（多方×多子流程）默认收起，保持界面紧凑可导航 */
type CollapseState = Record<string, boolean>;

/** 会签方编辑器：每个会签方 = 部门 + 涉及人员 + 分支内部多个子流程。
 * 各会签方并行办理，其内部子步骤按顺序执行；
 * 每个子步骤与主步骤一样完整采集线上/线下属性。
 * 支持按方折叠收纳（复杂多方流程的界面优化）。 */
export function PartyEditor({
  parties,
  onChange,
}: {
  parties: CountersignParty[];
  onChange: (parties: CountersignParty[]) => void;
}) {
  const [collapsed, setCollapsed] = useState<CollapseState>({});
  const [allCollapsed, setAllCollapsed] = useState(false);

  const update = (i: number, patch: Partial<CountersignParty>) =>
    onChange(parties.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const updateSub = (i: number, subId: string, patch: Partial<SubStep>) =>
    update(i, {
      subSteps: (parties[i].subSteps ?? []).map((s) =>
        s.id === subId ? { ...normalizeSubStep(s), ...patch } : s,
      ),
    });

  const addParty = () => {
    const p = { ...emptyParty() };
    onChange([...parties, p]);
    setCollapsed((prev) => ({ ...prev, [p.id]: false })); // 新增的方自动展开
    setAllCollapsed(false);
  };

  const toggleAll = () => {
    const next = !allCollapsed;
    setAllCollapsed(next);
    setCollapsed(
      Object.fromEntries(parties.map((p) => [p.id, next])) as CollapseState,
    );
  };

  /** 复制子流程行（内容原样复制，便于结构相近的部门快速填写） */
  const copySub = (i: number, k: number) => {
    const src = normalizeSubStep(parties[i].subSteps[k]);
    const copy: SubStep = {
      ...src,
      id: emptySubStep().id,
      name: `${src.name}（副本）`,
    };
    const subs = [...(parties[i].subSteps ?? [])];
    subs.splice(k + 1, 0, copy);
    update(i, { subSteps: subs });
  };

  /** 会签方是否已填写内容（决定折叠行摘要展示） */
  const filledCount = (party: CountersignParty) => {
    const subs = (party.subSteps ?? []).filter((s) => normalizeSubStep(s).name.trim());
    const staffN = party.staff.filter((s) => s.trim()).length;
    return { subs: subs.length, staff: staffN, any: !!party.department.trim() || staffN > 0 || subs.length > 0 };
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex items-center gap-1.5 text-neutral-300">
          <FileSignature className="h-3.5 w-3.5 text-amber-300/80" /> 会签部门及人员（并行办理，内部可含多步）
        </Label>
        <div className="flex items-center gap-2">
          {parties.length > 1 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-neutral-400 transition hover:text-white"
            >
              {allCollapsed ? "全部展开" : "全部收起"}
            </button>
          )}
          <button
            type="button"
            onClick={addParty}
            className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white"
          >
            <Plus className="h-3.5 w-3.5" /> 添加会签方
          </button>
        </div>
      </div>

      {parties.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-2.5 text-xs text-neutral-500">
          暂未添加，点击右上角"添加会签方"增加会签分支
        </p>
      )}

      <div className="space-y-2.5">
        {parties.map((party, i) => {
          const isCollapsed = !!collapsed[party.id];
          const stat = filledCount(party);
          return (
            <div
              key={party.id}
              className="rounded-lg border border-amber-400/20 bg-amber-400/5"
            >
              {/* 折叠行：点击头部切换展开/收起 */}
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [party.id]: !isCollapsed }))}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-amber-300/70" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-amber-300/70" />
                )}
                <Building2 className="h-4 w-4 shrink-0 text-amber-300/80" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-amber-100">
                  {party.department.trim() || `会签方${i + 1}`}
                </span>
                {/* 收起态摘要 */}
                {isCollapsed && (
                  <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-400">
                    {stat.staff > 0 && (
                      <span className="rounded-full bg-white/10 px-1.5 py-0.5">
                        {stat.staff} 人
                      </span>
                    )}
                    <span className="rounded-full bg-white/10 px-1.5 py-0.5">
                      {stat.subs > 0 ? `${stat.subs} 个子流程` : "单步会签"}
                    </span>
                  </span>
                )}
              </button>

              {/* 展开态：完整编辑表单 */}
              {!isCollapsed && (
                <div className="space-y-2.5 border-t border-amber-400/10 px-3 pb-3 pt-3">
                  {/* 部门 + 删除 */}
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 shrink-0 text-neutral-500" />
                    <Input
                      value={party.department}
                      placeholder="会签部门，如：财务部"
                      onChange={(e) => update(i, { department: e.target.value })}
                      className="h-9"
                    />
                    <button
                      type="button"
                      onClick={() => onChange(parties.filter((_, idx) => idx !== i))}
                      aria-label="删除此会签方"
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-500/10 hover:text-red-400 sm:h-9 sm:w-9"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* 人员 */}
                  <div className="flex items-start gap-2 sm:pl-6">
                    <User className="mt-2.5 h-4 w-4 shrink-0 text-neutral-500" />
                    <TagInput
                      placeholder="输入人员姓名后回车，可添加多个"
                      tags={party.staff}
                      onChange={(staff) => update(i, { staff })}
                      className="flex-1"
                    />
                  </div>

                  {/* 内部子流程（每个子步骤完整采集线上/线下属性） */}
                  <div className="space-y-2 sm:pl-6">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400">
                        <ListOrdered className="h-3.5 w-3.5 text-neutral-500" />
                        内部子流程（依次执行，每步标注线上 / 线下）
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          update(i, { subSteps: [...(party.subSteps ?? []), emptySubStep()] })
                        }
                        className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white"
                      >
                        <Plus className="h-3 w-3" /> 添加内部步骤
                      </button>
                    </div>

                    {(party.subSteps ?? []).map((raw, j) => {
                      const sub = normalizeSubStep(raw);
                      return (
                        <div
                          key={sub.id}
                          className="space-y-2 rounded-lg border border-white/10 bg-neutral-950/70 p-2.5"
                        >
                          {/* 子步骤名称 + 复制/删除 */}
                          <div className="flex items-center gap-1.5">
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-[10px] font-semibold text-amber-300">
                              {j + 1}
                            </span>
                            <Input
                              value={sub.name}
                              placeholder={`内部步骤名称，如：${j === 0 ? "初审" : "复核签署"}`}
                              onChange={(e) => updateSub(i, sub.id, { name: e.target.value })}
                              className="h-8 flex-1 text-xs"
                            />
                            {/* 复制子流程行（结构相近时快速填写） */}
                            <button
                              type="button"
                              onClick={() => copySub(i, j)}
                              aria-label="复制此子流程"
                              title="复制此子流程（内容原样复制，插入其后）"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-600 transition hover:bg-white/5 hover:text-white"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                update(i, { subSteps: party.subSteps.filter((_, idx) => idx !== j) })
                              }
                              aria-label="删除内部步骤"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-600 transition hover:bg-red-500/10 hover:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* 子步骤线上/线下切换（紧凑版） */}
                          <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/40 p-1 sm:w-64">
                            {(
                              [
                                { value: "online", label: "线上系统" },
                                { value: "offline", label: "线下办理" },
                              ] as const
                            ).map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                onClick={() => updateSub(i, sub.id, { mode: value })}
                                className={cn(
                                  "rounded-md px-2 py-1 text-xs transition-all",
                                  sub.mode === value
                                    ? "bg-gradient-to-b from-cyan-500/30 to-cyan-500/10 text-white ring-1 ring-cyan-400/40"
                                    : "text-neutral-400 hover:bg-white/5",
                                )}
                              >
                                {label}
                              </button>
                            ))}
                          </div>

                          {/* 子步骤属性 */}
                          {sub.mode === "online" ? (
                            <div className="flex flex-wrap items-end gap-2">
                              <div className="min-w-[180px] flex-1 space-y-1">
                                <SystemSelect
                                  compact
                                  value={sub.online.systemName}
                                  placeholder="选择线上系统"
                                  onChange={(v) =>
                                    updateSub(i, sub.id, {
                                      online: { ...sub.online, systemName: v },
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <YesNoSelect
                                  compact
                                  label="支持移动端"
                                  value={sub.online.mobileSupported}
                                  onChange={(v) =>
                                    updateSub(i, sub.id, {
                                      online: { ...sub.online, mobileSupported: v },
                                    })
                                  }
                                />
                                {(() => {
                                  // 分支内相邻线上-线上且系统不同：需填写数据互通
                                  const subs = (parties[i].subSteps ?? []).map(normalizeSubStep);
                                  const idx = subs.findIndex((x) => x.id === sub.id);
                                  if (idx <= 0) return null;
                                  const prev = subs[idx - 1];
                                  if (prev.mode !== "online") return null;
                                  const pSys = prev.online.systemName.trim();
                                  const cSys = sub.online.systemName.trim();
                                  if (!pSys || pSys === cSys) return null;
                                  return (
                                    <YesNoSelect
                                      compact
                                      label={`「${pSys} → ${cSys}」数据互通`}
                                      value={sub.online.dataInteroperable ?? null}
                                      onChange={(v) =>
                                        updateSub(i, sub.id, {
                                          online: { ...sub.online, dataInteroperable: v },
                                        })
                                      }
                                      hint="两系统是否自动共享数据"
                                    />
                                  );
                                })()}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2 rounded-lg border border-white/5 bg-black/30 p-2">
                              <TagInput
                                placeholder="涉及文件名称，回车添加，如：评审意见表"
                                tags={sub.offline.documents}
                                onChange={(documents) =>
                                  updateSub(i, sub.id, { offline: { ...sub.offline, documents } })
                                }
                              />
                              <HandlerList
                                title="经办部门及人员"
                                handlers={sub.offline.handlers}
                                onChange={(handlers) =>
                                  updateSub(i, sub.id, { offline: { ...sub.offline, handlers } })
                                }
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {(party.subSteps ?? []).length === 0 && (
                      <p className="text-xs text-neutral-600">
                        未填写内部步骤时，该会签方按单步签署处理
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
