"use client";

import { Building2, FileSignature, Plus, Trash2, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { SystemSelect } from "@/components/system-select";
import {
  emptyParty,
  emptySubStep,
  normalizeSubStep,
  type CountersignParty,
  type SubStep,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 会签方编辑器：每个会签方 = 部门 + 涉及人员 + 分支内部多个子步骤。
 * 各会签方并行办理，其内部子步骤按顺序执行；
 * 每个子步骤与主步骤一样完整采集线上/线下属性。
 */
export function PartyEditor({
  parties,
  onChange,
}: {
  parties: CountersignParty[];
  onChange: (parties: CountersignParty[]) => void;
}) {
  const update = (i: number, patch: Partial<CountersignParty>) =>
    onChange(parties.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const updateSub = (i: number, subId: string, patch: Partial<SubStep>) =>
    update(i, {
      subSteps: (parties[i].subSteps ?? []).map((s) =>
        s.id === subId ? { ...normalizeSubStep(s), ...patch } : s,
      ),
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="inline-flex items-center gap-1.5 text-neutral-300">
          <FileSignature className="h-3.5 w-3.5 text-amber-300/80" /> 会签部门及人员（并行办理，内部可含多步）
        </Label>
        <button
          type="button"
          onClick={() => onChange([...parties, { ...emptyParty() }])}
          className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" /> 添加会签方
        </button>
      </div>

      {parties.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-2.5 text-xs text-neutral-500">
          暂未添加，点击右上角"添加会签方"增加会签分支
        </p>
      )}

      <div className="space-y-3">
        {parties.map((party, i) => (
          <div key={party.id} className="space-y-2.5 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
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
            <div className="space-y-2 pl-1 sm:pl-6">
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-400">
                  内部子流程（依次执行，每步标注线上 / 线下）
                </span>
                <button
                  type="button"
                  onClick={() => update(i, { subSteps: [...(party.subSteps ?? []), emptySubStep()] })}
                  className="inline-flex items-center gap-1 text-xs text-neutral-400 transition hover:text-white"
                >
                  <Plus className="h-3 w-3" /> 添加内部步骤
                </button>
              </div>

              {(party.subSteps ?? []).map((raw, j) => {
                const sub = normalizeSubStep(raw);
                return (
                  <div key={sub.id} className="space-y-2 rounded-lg border border-white/10 bg-neutral-950/70 p-2.5">
                    {/* 子步骤名称 + 删除 */}
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
                        <div className="rounded-lg border border-white/10 px-2 py-0.5">
                          <Checkbox
                            checked={sub.online.mobileSupported}
                            onCheckedChange={(v) =>
                              updateSub(i, sub.id, { online: { ...sub.online, mobileSupported: v } })
                            }
                          >
                            <span className="text-xs">支持移动端</span>
                          </Checkbox>
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
                <p className="text-xs text-neutral-600">未填写内部步骤时，该会签方按单步签署处理</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
