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
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { RequiredEmpty } from "@/components/required-empty";
import { SystemSelect } from "@/components/system-select";
import { YesNoSelect } from "@/components/yes-no-select";
import { subInteropPrev } from "@/lib/step-checks";
import { subAnchorId } from "@/lib/form-focus";
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

/** 一条经办记录是否已填(部门或人员至少一项) */
const validHandler = (h: { department: string; staff: string[] }) =>
  h.department.trim() || h.staff.some((x) => x.trim());

/** 会签方编辑器（琥珀玻璃分区）：每个会签方 = 部门 + 涉及人员 + 分支内部多个子流程。
 * 各会签方并行办理，其内部子步骤按顺序执行；
 * 每个子步骤与主步骤一样完整采集线上/线下属性。
 * 支持按方折叠收纳（复杂多方流程的界面优化）。
 * attempted = 已经点过提交:仍缺失的必填控件标红。 */
export function PartyEditor({
  parties,
  onChange,
  id,
  attempted = false,
}: {
  parties: CountersignParty[];
  onChange: (parties: CountersignParty[]) => void;
  id?: string;
  attempted?: boolean;
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
    <div id={id} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="inline-flex flex-wrap items-center gap-x-1.5 text-[color:var(--amber-deep)]">
          <FileSignature className="h-3.5 w-3.5" /> 会签部门及人员
          <span className="text-[color:var(--red)]">*</span>
          <span className="text-xs font-normal text-[color:var(--ink-3)]">必填</span>
          <span className="text-xs font-normal text-[color:var(--ink-2)]">并行办理，内部可含多步</span>
        </Label>
        <div className="flex items-center gap-1">
          {parties.length > 1 && (
            <button
              type="button"
              onClick={toggleAll}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
            >
              {allCollapsed ? "全部展开" : "全部收起"}
            </button>
          )}
          {parties.length > 0 && (
            <button
              type="button"
              onClick={addParty}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
            >
              <Plus className="h-3.5 w-3.5" /> 添加会签方
            </button>
          )}
        </div>
      </div>

      {parties.length === 0 && (
        <RequiredEmpty
          title="还没有添加会签部门及人员"
          hint="开启会签后，至少需要一方：填写会签部门或人员。各方并行办理，每一方内部可以再拆成多个子步骤。"
          actionLabel="添加会签部门及人员"
          error={attempted}
          onAdd={addParty}
        />
      )}

      <div className="space-y-2.5">
        {parties.map((party, i) => {
          const isCollapsed = !!collapsed[party.id];
          const stat = filledCount(party);
          return (
            <div
              key={party.id}
              className="rounded-2xl bg-[linear-gradient(180deg,rgba(255,246,230,0.72),rgba(255,243,224,0.5))] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.75),inset_0_0_0_0.5px_rgba(178,106,0,0.14)]"
            >
              {/* 折叠行：点击头部切换展开/收起 */}
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [party.id]: !isCollapsed }))}
                className="flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left"
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4 shrink-0 text-[color:var(--amber-deep)]" />
                ) : (
                  <ChevronDown className="h-4 w-4 shrink-0 text-[color:var(--amber-deep)]" />
                )}
                <Building2 className="h-4 w-4 shrink-0 text-[color:var(--amber)]" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--amber-deep)]">
                  {party.department.trim() || `会签方${i + 1}`}
                </span>
                {/* 收起态摘要 */}
                {isCollapsed && (
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--ink-2)]">
                    {stat.staff > 0 && (
                      <span className="rounded-full bg-white/60 px-2 py-0.5">{stat.staff} 人</span>
                    )}
                    <span className="rounded-full bg-white/60 px-2 py-0.5">
                      {stat.subs > 0 ? `${stat.subs} 个子流程` : "单步会签"}
                    </span>
                  </span>
                )}
              </button>

              {/* 展开态：完整编辑表单 */}
              {!isCollapsed && (
                <div className="space-y-2.5 border-t border-[rgba(178,106,0,0.12)] px-3.5 pb-3.5 pt-3">
                  {/* 部门 + 删除 */}
                  <div className="flex items-center gap-2">
                    <Input
                      value={party.department}
                      placeholder="会签部门，如：财务部"
                      aria-label="会签部门"
                      onChange={(e) => update(i, { department: e.target.value })}
                      className="h-9"
                    />
                    <button
                      type="button"
                      onClick={() => onChange(parties.filter((_, idx) => idx !== i))}
                      aria-label="删除此会签方"
                      className="icon-btn icon-danger !h-11 !w-11 shrink-0 sm:!h-9 sm:!w-9"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* 人员 */}
                  <div className="flex items-start gap-2 sm:pl-6">
                    <TagInput
                      placeholder="输入人员姓名后回车，可添加多个"
                      tags={party.staff}
                      onChange={(staff) => update(i, { staff })}
                      className="min-w-0 flex-1"
                    />
                  </div>

                  {/* 内部子流程（每个子步骤完整采集线上/线下属性） */}
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-[color:var(--ink-2)]">
                        <ListOrdered className="h-3.5 w-3.5 text-[color:var(--ink-3)]" />
                        内部子流程（依次执行，每步标注线上 / 线下）
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          update(i, { subSteps: [...(party.subSteps ?? []), emptySubStep()] })
                        }
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
                      >
                        <Plus className="h-3 w-3" /> 添加内部步骤
                      </button>
                    </div>

                    {(party.subSteps ?? []).map((raw, j) => {
                      const sub = normalizeSubStep(raw);
                      // 没填名称的子步骤按"不存在"处理(不参与校验),只有命名过的才提示必填
                      const named = !!sub.name.trim();
                      return (
                        <div
                          key={sub.id}
                          className="space-y-2.5 rounded-2xl bg-[rgba(255,255,255,0.66)] p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.7),inset_0_0_0_0.5px_rgba(0,0,0,0.035)]"
                        >
                          {/* 子步骤名称 + 复制/删除 */}
                          <div className="flex items-center gap-2">
                            {/* 琥珀菱形序号(与会签轨点同构) */}
                            <span
                              aria-hidden="true"
                              className="grid h-[22px] w-[22px] shrink-0 rotate-45 place-items-center rounded-[7px] bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]"
                            >
                              <span className="-rotate-45 text-[11px] font-bold">{j + 1}</span>
                            </span>
                            <Input
                              value={sub.name}
                              placeholder={`内部步骤名称，如：${j === 0 ? "初审" : "复核签署"}`}
                              onChange={(e) => updateSub(i, sub.id, { name: e.target.value })}
                              className="h-9 min-w-0 flex-1 text-sm"
                            />
                            {/* 复制子流程行（结构相近时快速填写） */}
                            <button
                              type="button"
                              onClick={() => copySub(i, j)}
                              aria-label="复制此子流程"
                              title="复制此子流程（内容原样复制，插入其后）"
                              className="icon-btn !h-9 !w-9 shrink-0"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                update(i, { subSteps: party.subSteps.filter((_, idx) => idx !== j) })
                              }
                              aria-label="删除内部步骤"
                              className="icon-btn icon-danger !h-9 !w-9 shrink-0"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>

                          {/* 子步骤线上/线下切换(iOS 迷你分段) */}
                          <div className="seg seg-mini">
                            {(
                              [
                                { value: "online", label: "线上系统" },
                                { value: "offline", label: "线下办理" },
                              ] as const
                            ).map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                // 切到"线下办理"时直接给出一条空白的经办记录:线下子步骤必须写明由谁受理
                                onClick={() =>
                                  updateSub(
                                    i,
                                    sub.id,
                                    value === "offline" && (sub.offline.handlers ?? []).length === 0
                                      ? { mode: value, offline: { ...sub.offline, handlers: [{ department: "", staff: [] }] } }
                                      : { mode: value },
                                  )
                                }
                                className={sub.mode === value ? "on" : undefined}
                              >
                                {label}
                              </button>
                            ))}
                          </div>

                          {/* 子步骤属性(没填名称的子步骤不参与校验,也就不标必填) */}
                          {sub.mode === "online" ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="min-w-[180px] flex-1">
                                <SystemSelect
                                  compact
                                  id={subAnchorId(sub.id, "system")}
                                  value={sub.online.systemName}
                                  placeholder="选择线上系统"
                                  required={named}
                                  invalid={attempted && named && !sub.online.systemName.trim()}
                                  onChange={(v) =>
                                    updateSub(i, sub.id, {
                                      online: { ...sub.online, systemName: v },
                                    })
                                  }
                                />
                              </div>
                              <div className="flex flex-col gap-1.5">
                                <div id={subAnchorId(sub.id, "mobile")}>
                                  <YesNoSelect
                                    compact
                                    required={named}
                                    label="支持移动端"
                                    value={sub.online.mobileSupported}
                                    onChange={(v) =>
                                      updateSub(i, sub.id, {
                                        online: { ...sub.online, mobileSupported: v },
                                      })
                                    }
                                  />
                                </div>
                                {(() => {
                                  // 与上一个已命名子步骤均线上且系统不同：需填写数据互通
                                  const p = subInteropPrev(parties[i].subSteps ?? [], j);
                                  if (!p) return null;
                                  return (
                                    <div id={subAnchorId(sub.id, "interop")}>
                                      <YesNoSelect
                                        compact
                                        required={named}
                                        label={`「${p.online.systemName.trim()} → ${sub.online.systemName.trim()}」数据互通`}
                                        value={sub.online.dataInteroperable ?? null}
                                        onChange={(v) =>
                                          updateSub(i, sub.id, {
                                            online: { ...sub.online, dataInteroperable: v },
                                          })
                                        }
                                        hint="两系统是否自动共享数据"
                                      />
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2.5 rounded-xl bg-[rgba(255,255,255,0.55)] p-2.5">
                              <TagInput
                                placeholder="涉及文件名称（选填），回车添加，如：评审意见表"
                                tags={sub.offline.documents ?? []}
                                onChange={(documents) =>
                                  updateSub(i, sub.id, { offline: { ...sub.offline, documents } })
                                }
                              />
                              <HandlerList
                                id={subAnchorId(sub.id, "handlers")}
                                title="经办部门及人员"
                                required={named}
                                error={attempted && named && !(sub.offline.handlers ?? []).some(validHandler)}
                                handlers={sub.offline.handlers ?? []}
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
                      <p className="text-xs text-[color:var(--ink-3)]">
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
