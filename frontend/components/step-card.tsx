"use client";

import { motion } from "framer-motion";
import {
  ArrowDown,
  ArrowUp,
  FileSignature,
  Globe,
  MapPin,
  Monitor,
  Smartphone,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip-card";
import { Spotlight } from "@/components/ui/spotlight";
import { SystemSelect } from "@/components/system-select";
import { YesNoSelect } from "@/components/yes-no-select";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { PartyEditor } from "@/components/party-editor";
import { Hourglass } from "lucide-react";
import { stepIssues } from "@/lib/step-checks";
import type { FlowStep, StepMode, WaitFor } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 单个流程步骤编辑卡片：
 * 名称 / 会签开关 / 前置会签条件 / 线上（系统+移动端）/ 线下（文件+经办部门人员）/ 备注
 */
export function StepCard({
  step,
  steps,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  step: FlowStep;
  steps: FlowStep[];
  index: number;
  total: number;
  onChange: (patch: Partial<FlowStep>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const mode: StepMode = step.mode;

  // 可作为前置依赖的候选：当前步骤之前的会签步骤
  const waitCandidates = steps.slice(0, index).filter((s) => s.countersign);
  const waitFor: WaitFor | null = step.waitFor ?? null;
  const depStep = waitFor ? waitCandidates.find((s) => s.id === waitFor.stepId) : undefined;
  const depParties = depStep?.parties ?? [];

  // 相邻线上-线上且系统不同：需填写数据互通（前序为会签时暂不要求，多系统语义待协作期扩展）
  const prevStep = index > 0 ? steps[index - 1] : undefined;
  const prevSys =
    prevStep && !prevStep.countersign && prevStep.mode === "online"
      ? prevStep.online.systemName.trim()
      : "";
  const needsInterop =
    !step.countersign &&
    step.mode === "online" &&
    !!prevSys &&
    prevSys !== step.online.systemName.trim();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className={cn(
        "glass-card relative p-4 sm:p-5",
        step.countersign
          ? "!border-amber-400/30 shadow-[0_0_28px_-12px_rgba(251,191,36,0.4)]"
          : "shadow-[0_0_24px_-12px_rgba(34,211,238,0.3)]",
      )}
    >
      {/* 官方 Spotlight：卡片 hover 聚光（会签=琥珀，普通=青蓝） */}
      <Spotlight
        className="-top-40 left-0 md:-top-20 md:left-60"
        fill={step.countersign ? "#FBBF24" : "#22D3EE"}
      />

      {/* 头部：名称 + 会签徽标 + 排序/删除（序号在左侧轨道节点上） */}
      <div className="flex items-center gap-2 sm:gap-3">
        <Input
          value={step.name}
          placeholder={`步骤名称，如：${index === 0 ? "提交申请" : "部门审批"}`}
          onChange={(e) => onChange({ name: e.target.value })}
          className="flex-1"
        />
        {step.countersign && (
          <span className="hidden shrink-0 rounded-full bg-amber-400/15 px-2.5 py-1 text-xs text-amber-300 sm:inline-flex">
            会签节点
          </span>
        )}
        {/* 完整度徽章：实时提示必填缺失项 */}
        {(() => {
          const issues = stepIssues(step);
          const ready = issues.length === 0;
          return (
            <span
              title={ready ? "本步骤必填信息已齐全" : issues.join("；")}
              className={cn(
                "hidden shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] sm:inline-flex",
                ready
                  ? "bg-emerald-400/15 text-emerald-300"
                  : "bg-red-400/15 text-red-300",
              )}
            >
              {ready ? "✓ 就绪" : `待完善 ${issues.length}`}
            </span>
          );
        })()}
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content="上移一步" containerClassName="hidden sm:block">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              aria-label="上移"
              className="flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 transition hover:bg-white/5 hover:text-white disabled:opacity-25 disabled:hover:bg-transparent sm:h-8 sm:w-8"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip content="下移一步" containerClassName="hidden sm:block">
            <button
              type="button"
              disabled={index === total - 1}
              onClick={() => onMove(1)}
              aria-label="下移"
              className="flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 transition hover:bg-white/5 hover:text-white disabled:opacity-25 disabled:hover:bg-transparent sm:h-8 sm:w-8"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip content="删除此步骤" containerClassName="hidden sm:block">
            <button
              type="button"
              disabled={total === 1}
              onClick={onRemove}
              aria-label="删除步骤"
              className="flex h-11 w-11 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-25 disabled:hover:bg-transparent sm:h-8 sm:w-8"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        {/* 会签开关 */}
        <div
          className={cn(
            "flex items-center justify-between rounded-lg border px-3 py-2 transition-colors",
            step.countersign
              ? "border-amber-400/40 bg-amber-400/5"
              : "border-white/10 bg-black/40",
          )}
        >
          <Checkbox
            checked={step.countersign}
            onCheckedChange={(v) => onChange({ countersign: v })}
            className="w-auto"
          >
            <span className="inline-flex items-center gap-1.5">
              <FileSignature className={cn("h-4 w-4", step.countersign ? "text-amber-300" : "text-neutral-500")} />
              本步骤为会签（多方并行签署）
            </span>
          </Checkbox>
          <span className="text-xs text-neutral-500">
            {step.countersign
              ? "处理方式由各会签方的内部子步骤标注"
              : "默认单人/单部门顺序审批"}
          </span>
        </div>

        {/* 会签卡片：处理方式下沉到每个内部子步骤，主级不再显示 */}
        {step.countersign ? (
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
            <PartyEditor
              parties={step.parties}
              onChange={(parties) => onChange({ parties })}
            />
          </div>
        ) : (
          <>
            {/* 线上 / 线下 分段切换 */}
            <div>
              <Label className="mb-1.5 block text-neutral-300">处理方式</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-black/40 p-1">
                {(
                  [
                    { value: "online", label: "线上系统", icon: Globe },
                    { value: "offline", label: "线下办理", icon: MapPin },
                  ] as const
                ).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onChange({ mode: value })}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all",
                      mode === value
                        ? "bg-gradient-to-b from-cyan-500/30 to-cyan-500/10 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] ring-1 ring-cyan-400/40"
                        : "text-neutral-400 hover:bg-white/5 hover:text-neutral-200",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 按处理方式渲染属性区 */}
            {mode === "online" ? (
              <div className="grid gap-3 rounded-lg border border-white/10 bg-black/40 p-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor={`sys-${step.id}`} className="text-neutral-300">
                    <span className="inline-flex items-center gap-1.5">
                      <Monitor className="h-3.5 w-3.5 text-neutral-500" /> 线上处理系统名称
                    </span>
                  </Label>
                  <SystemSelect
                    id={`sys-${step.id}`}
                    value={step.online.systemName}
                    onChange={(v) =>
                      onChange({ online: { ...step.online, systemName: v } })
                    }
                  />
                </div>
                <div className="flex flex-col gap-2 sm:items-end">
                  <YesNoSelect
                    compact
                    label="是否支持移动端"
                    value={step.online.mobileSupported}
                    onChange={(v) =>
                      onChange({ online: { ...step.online, mobileSupported: v } })
                    }
                  />
                  {needsInterop && (
                    <YesNoSelect
                      compact
                      label={`「${prevSys} → ${step.online.systemName.trim()}」数据互通`}
                      value={step.online.dataInteroperable ?? null}
                      onChange={(v) =>
                        onChange({ online: { ...step.online, dataInteroperable: v } })
                      }
                      hint="两系统是否自动共享数据"
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-white/10 bg-black/40 p-3">
                <TagInput
                  label="涉及文件名称"
                  placeholder="输入文件名称后回车，如：合同正本 / 用印申请单"
                  tags={step.offline.documents}
                  onChange={(documents) => onChange({ offline: { ...step.offline, documents } })}
                />
                <HandlerList
                  title="线下经办部门及涉及人员"
                  handlers={step.offline.handlers}
                  onChange={(handlers) => onChange({ offline: { ...step.offline, handlers } })}
                />
              </div>
            )}
          </>
        )}

        {/* 前置会签条件：需某一会签流程通过后方可继续执行 */}
        {index > 0 && (
          <div
            className={cn(
              "space-y-2 rounded-lg border px-3 py-2.5 transition-colors",
              waitFor ? "border-sky-400/30 bg-sky-400/5" : "border-white/10 bg-black/40",
            )}
          >
            <div className="flex items-center gap-1.5 text-sm text-neutral-300">
              <Hourglass className={cn("h-4 w-4", waitFor ? "text-sky-300" : "text-neutral-500")} />
              前置会签条件
              <span className="text-xs font-normal text-neutral-500">
                （选填：本步骤需等待指定会签流程通过后执行）
              </span>
            </div>
            {waitCandidates.length === 0 ? (
              <p className="text-xs text-neutral-500">
                之前暂无会签步骤；将某一步骤开启会签后，可在此设置对它的依赖
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  value={waitFor?.stepId ?? ""}
                  onChange={(e) => {
                    const stepId = e.target.value;
                    onChange({ waitFor: stepId ? { stepId, partyId: "" } : null });
                  }}
                  className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] outline-none focus:shadow-[0_0_1px_2px_#3EC1D3]"
                >
                  <option value="">不设置（上一步完成即执行）</option>
                  {waitCandidates.map((s) => {
                    const no = steps.findIndex((x) => x.id === s.id) + 1;
                    return (
                      <option key={s.id} value={s.id}>
                        等待「{no}. {s.name || "未命名"}」会签
                      </option>
                    );
                  })}
                </select>
                {waitFor && depParties.length > 0 && (
                  <select
                    value={waitFor.partyId ?? ""}
                    onChange={(e) => onChange({ waitFor: { ...waitFor, partyId: e.target.value } })}
                    className="h-10 w-full rounded-md border border-white/10 bg-black px-3 text-sm text-white shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] outline-none focus:shadow-[0_0_1px_2px_#3EC1D3]"
                  >
                    <option value="">整个会签全部通过</option>
                    {depParties.map((p, j) => (
                      <option key={p.id} value={p.id}>
                        仅等待「{p.department || `会签方${j + 1}`}」分支通过
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        )}

        {/* 备注 */}
        <div className="space-y-1.5">
          <Label htmlFor={`remark-${step.id}`} className="text-neutral-400 text-xs">
            备注（选填）
          </Label>
          <Textarea
            id={`remark-${step.id}`}
            value={step.remark}
            placeholder="补充说明本步骤的办理要求、时限等"
            onChange={(e) => onChange({ remark: e.target.value })}
            className="min-h-[48px]"
          />
        </div>
      </div>
    </motion.div>
  );
}
