"use client";

import { motion } from "motion/react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileSignature,
  Globe,
  Hourglass,
  MapPin,
  Monitor,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { SystemSelect } from "@/components/system-select";
import { YesNoSelect } from "@/components/yes-no-select";
import { TagInput } from "@/components/tag-input";
import { HandlerList } from "@/components/handler-list";
import { PartyEditor } from "@/components/party-editor";
import { stepIssueList, needsInteropWithPrev, countersignMode, OVERALL_MODE_LABEL } from "@/lib/step-checks";
import { focusAnchor, issueAnchorId } from "@/lib/form-focus";
import { CountersignModeBadge } from "@/components/countersign-mode-badge";
import type { FlowStep, StepMode, WaitFor } from "@/lib/types";
import { emptyParty } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 一条经办记录是否已填(部门或人员至少一项) */
const validHandler = (h: { department: string; staff: string[] }) =>
  h.department.trim() || h.staff.some((x) => x.trim());

/** 提示条里最多直接列出几项缺失,其余的在各子步骤内部另有标注 */
const STRIP_LIMIT = 4;

/**
 * 单个流程步骤编辑卡片(液态玻璃):
 * 名称 / 会签开关 / 前置会签条件 / 线上（系统+移动端）/ 线下（文件+经办部门人员）/ 备注
 * 会签卡带琥珀色环与暖色底,与普通玻璃卡一眼区分。
 *
 * 必填引导:卡片顶部常驻一条"还差 N 项必填",点某一项跳到对应控件;
 * attempted(已经点过提交)之后,仍为空的必填控件加红圈。
 */
export function StepCard({
  step,
  steps,
  index,
  total,
  onChange,
  onRemove,
  onMove,
  attempted = false,
}: {
  step: FlowStep;
  steps: FlowStep[];
  index: number;
  total: number;
  onChange: (patch: Partial<FlowStep>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  /** 已经点过提交:仍缺失的必填控件标红 */
  attempted?: boolean;
}) {
  const mode: StepMode = step.mode;

  // 可作为前置依赖的候选：当前步骤之前的会签步骤
  const waitCandidates = steps.slice(0, index).filter((s) => s.countersign);
  const waitFor: WaitFor | null = step.waitFor ?? null;
  const depStep = waitFor ? waitCandidates.find((s) => s.id === waitFor.stepId) : undefined;
  const depParties = depStep?.parties ?? [];

  // 相邻线上-线上且系统不同：需填写数据互通（上一步为会签时取各方末位子步骤的系统）
  const prevStep = index > 0 ? steps[index - 1] : undefined;
  const prevSystems = needsInteropWithPrev(steps, index);
  const needsInterop = prevSystems.length > 0;
  // 会签整体办理方式：由各方内部子步骤汇总
  const overallMode = countersignMode(step);

  const issues = stepIssueList(step, prevStep);
  const ready = issues.length === 0;
  // 点过提交后仍为空的必填控件 → 红圈
  const bad = attempted && !ready;
  const handlers = step.offline.handlers ?? [];
  const sysId = issueAnchorId(step.id, "system");

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      className={cn(
        "glass-card relative p-4 sm:p-5",
        // 会签卡:琥珀色环 + 暖色玻璃底
        step.countersign &&
          "bg-[linear-gradient(180deg,rgba(255,246,231,0.52),rgba(255,243,224,0.36))] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),inset_0_0_0_0.5px_rgba(255,255,255,0.6),inset_0_0_0_2px_rgba(255,149,0,0.28),0_2px_6px_-2px_rgba(23,42,80,0.08),0_24px_56px_-24px_rgba(154,98,0,0.32)]",
      )}
    >
      {/* 头部：名称 + 徽章 + 排序/删除（序号在左侧轨道节点上） */}
      <div className="flex items-center gap-2 sm:gap-3">
        <Input
          id={issueAnchorId(step.id, "name")}
          value={step.name}
          placeholder={`步骤名称（必填），如：${index === 0 ? "提交申请" : "部门审批"}`}
          aria-label="步骤名称（必填）"
          aria-invalid={attempted && !step.name.trim()}
          onChange={(e) => onChange({ name: e.target.value })}
          className={cn("min-w-0 flex-1 font-medium", attempted && !step.name.trim() && "field-invalid")}
        />
        {step.countersign && (
          <>
            <span className="badge badge-amber hidden shrink-0 sm:inline-flex">
              <span className="dot" />会签节点
            </span>
            {/* 整体办理方式标识（移动端由下方会签开关副标题承接） */}
            <CountersignModeBadge
              mode={overallMode}
              className="hidden shrink-0 sm:inline-flex"
            />
          </>
        )}
        {/* 完整度徽章：实时提示必填缺失项（明细见卡片顶部的"还差 N 项必填"） */}
        <span
          title={ready ? "本步骤必填信息已齐全" : issues.map((i) => i.text).join("；")}
          className={cn(
            "badge hidden shrink-0 sm:inline-flex",
            ready ? "badge-ok" : "badge-warn",
          )}
        >
          <span className="dot" />
          {ready ? "就绪" : `待完善 ${issues.length}`}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label="上移"
            title="上移一步"
            className="icon-btn !h-11 !w-11 sm:!h-8 sm:!w-8"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            aria-label="下移"
            title="下移一步"
            className="icon-btn !h-11 !w-11 sm:!h-8 sm:!w-8"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={total === 1}
            onClick={onRemove}
            aria-label="删除步骤"
            title="删除此步骤"
            className="icon-btn icon-danger !h-11 !w-11 sm:!h-8 sm:!w-8"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 还差什么:常驻在卡片顶部,每一项可点击跳到对应控件(手机上也显示) */}
      {issues.length > 0 && (
        <div
          aria-label="本步骤还差的必填项"
          className={cn(
            "mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-2xl bg-[color:var(--red-soft)] px-3.5 py-2.5",
            bad
              ? "shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.5)]"
              : "shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.28)]",
          )}
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[color:var(--red-deep)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            还差 {issues.length} 项必填
          </span>
          {issues.slice(0, STRIP_LIMIT).map((it) => (
            <button
              key={it.text}
              type="button"
                onClick={() => focusAnchor(issueAnchorId(step.id, it.field))}
              title="点击跳到这一项"
              className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-medium text-[color:var(--red-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.3)] transition hover:bg-white active:scale-[0.97]"
            >
              {it.text}
            </button>
          ))}
          {issues.length > STRIP_LIMIT && (
            <span className="text-xs text-[color:var(--red-deep)]">另有 {issues.length - STRIP_LIMIT} 项在下方子步骤里</span>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3.5">
        {/* 会签开关(iOS 设置行 + 开关) */}
        <div
          className={cn(
            "flex items-center gap-3 rounded-2xl px-3.5 py-2.5 transition-colors",
            step.countersign
              ? "bg-[color:var(--amber-soft)] shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]"
              : "bg-white/45 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]",
          )}
        >
          <Checkbox
            checked={step.countersign}
            // 第一次打开会签时先给出一方空白的"会签部门及人员",不用再去找添加按钮
            onCheckedChange={(v) =>
              onChange(v && step.parties.length === 0 ? { countersign: v, parties: [emptyParty()] } : { countersign: v })
            }
          >
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-sm",
                  step.countersign ? "font-semibold text-[color:var(--amber-deep)]" : "text-neutral-800",
                )}
              >
                <FileSignature
                  className={cn("h-4 w-4", step.countersign ? "text-[color:var(--amber)]" : "text-[color:var(--ink-3)]")}
                />
                本步骤为会签
              </span>
              <span className="text-xs text-[color:var(--ink-2)]">
                {step.countersign
                  ? `整体${OVERALL_MODE_LABEL[overallMode]} · 由各会签方的内部子步骤汇总`
                  : "多方并行签署,内部可含多步"}
              </span>
            </span>
          </Checkbox>
        </div>

        {/* 会签卡片：处理方式下沉到每个内部子步骤，主级不再显示 */}
        {step.countersign ? (
          <div className="rounded-2xl bg-[linear-gradient(180deg,rgba(255,246,231,0.6),rgba(255,243,224,0.42))] p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.7),inset_0_0_0_0.5px_rgba(178,106,0,0.14)]">
            <PartyEditor
              id={issueAnchorId(step.id, "parties")}
              attempted={bad}
              parties={step.parties}
              onChange={(parties) => onChange({ parties })}
            />
          </div>
        ) : (
          <>
            {/* 线上 / 线下 分段切换(iOS Segmented Control) */}
            <div>
              <Label className="mb-1.5 block">处理方式</Label>
              <div className="seg">
                {(
                  [
                    { value: "online", label: "线上系统", icon: Globe },
                    { value: "offline", label: "线下办理", icon: MapPin },
                  ] as const
                ).map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    // 切到"线下办理"时直接给出一条空白的经办记录:线下步骤必须写明由谁受理
                    onClick={() =>
                      onChange(
                        value === "offline" && handlers.length === 0
                          ? { mode: value, offline: { ...step.offline, handlers: [{ department: "", staff: [] }] } }
                          : { mode: value },
                      )
                    }
                    className={mode === value ? "on" : undefined}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 按处理方式渲染属性区 */}
            {mode === "online" ? (
              <div className="grid gap-3 rounded-2xl bg-white/50 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)] sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={sysId} className="inline-flex items-center gap-1.5">
                    <Monitor className="h-3.5 w-3.5 text-[color:var(--ink-3)]" /> 线上处理系统
                    <span className="text-[color:var(--red)]">*</span>
                    <span className="text-xs font-normal text-[color:var(--ink-3)]">必填</span>
                  </Label>
                  <SystemSelect
                    id={sysId}
                    value={step.online.systemName}
                    invalid={bad && !step.online.systemName.trim()}
                    onChange={(v) =>
                      onChange({ online: { ...step.online, systemName: v } })
                    }
                  />
                </div>
                <div className="flex flex-col gap-2 sm:items-end">
                  <div id={issueAnchorId(step.id, "mobile")}>
                    <YesNoSelect
                      compact
                      label="是否支持移动端"
                      value={step.online.mobileSupported}
                      onChange={(v) =>
                        onChange({ online: { ...step.online, mobileSupported: v } })
                      }
                    />
                  </div>
                  {needsInterop && (
                    <div id={issueAnchorId(step.id, "interop")}>
                      <YesNoSelect
                        compact
                        label={`「${prevSystems.join("、")} → ${step.online.systemName.trim()}」数据互通`}
                        value={step.online.dataInteroperable ?? null}
                        onChange={(v) =>
                          onChange({ online: { ...step.online, dataInteroperable: v } })
                        }
                        hint="两系统是否自动共享数据"
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 rounded-2xl bg-white/50 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                <TagInput
                  label="涉及文件名称"
                  optional
                  placeholder="输入文件名称后回车，如：合同正本 / 用印申请单"
                  tags={step.offline.documents ?? []}
                  onChange={(documents) => onChange({ offline: { ...step.offline, documents } })}
                />
                <HandlerList
                  id={issueAnchorId(step.id, "handlers")}
                  title="经办部门及人员"
                  required
                  error={bad && !handlers.some(validHandler)}
                  handlers={handlers}
                  onChange={(h) => onChange({ offline: { ...step.offline, handlers: h } })}
                />
              </div>
            )}
          </>
        )}

        {/* 前置会签条件：需某一会签流程通过后方可继续执行 */}
        {index > 0 && (
          <div
            className={cn(
              "space-y-2 rounded-2xl px-3.5 py-3 transition-colors",
              waitFor
                ? "bg-[linear-gradient(180deg,rgba(240,240,255,0.55),rgba(255,255,255,0.5))] shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.28),inset_0_0_0_0.5px_rgba(255,255,255,0.6)]"
                : "bg-white/45 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]",
            )}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-neutral-800">
              <Hourglass
                className={cn("h-4 w-4", waitFor ? "text-[color:var(--indigo)]" : "text-[color:var(--ink-3)]")}
              />
              前置会签条件
              <span className="text-xs font-normal text-[color:var(--ink-2)]">
                （选填：本步骤需等待指定会签流程通过后执行）
              </span>
            </div>
            {waitCandidates.length === 0 ? (
              <p className="text-xs text-[color:var(--ink-3)]">
                之前暂无会签步骤；将某一步骤开启会签后，可在此设置对它的依赖
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="relative">
                  <select
                    value={waitFor?.stepId ?? ""}
                    onChange={(e) => {
                      const stepId = e.target.value;
                      onChange({ waitFor: stepId ? { stepId, partyId: "" } : null });
                    }}
                    aria-label="选择前置会签步骤"
                    className="field pr-9"
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
                  <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" />
                </div>
                {waitFor && depParties.length > 0 && (
                  <div className="relative">
                    <select
                      value={waitFor.partyId ?? ""}
                      onChange={(e) => onChange({ waitFor: { ...waitFor, partyId: e.target.value } })}
                      aria-label="选择会签方分支"
                      className="field pr-9"
                    >
                      <option value="">整个会签全部通过</option>
                      {depParties.map((p, j) => (
                        <option key={p.id} value={p.id}>
                          仅等待「{p.department || `会签方${j + 1}`}」分支通过
                        </option>
                      ))}
                    </select>
                    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 备注 */}
        <div className="space-y-1.5">
          <Label htmlFor={`remark-${step.id}`} className="text-[color:var(--ink-2)]">
            备注 <span className="font-normal text-[color:var(--ink-3)]">选填</span>
          </Label>
          <Textarea
            id={`remark-${step.id}`}
            value={step.remark}
            placeholder="补充说明本步骤的办理要求、时限等"
            onChange={(e) => onChange({ remark: e.target.value })}
            className="min-h-[52px] text-sm"
          />
        </div>
      </div>
    </motion.div>
  );
}
