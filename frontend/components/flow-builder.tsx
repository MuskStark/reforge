"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Plus, RotateCcw, Save, User, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { MultiStepLoader } from "@/components/ui/multi-step-loader";
import { GLASS_SHADOW, useGlassInteraction } from "@/lib/glass";
import { cn } from "@/lib/utils";
import { stepIssues } from "@/lib/step-checks";
import { StepCard } from "@/components/step-card";
import type { FlowProcess, FlowStep } from "@/lib/types";
import { emptyProcess, emptyStep, normalizeParty } from "@/lib/types";

/**
 * 流程收集主表单：流程基本信息 + 自定义增删/排序步骤，
 * 每步可配置会签与线上/线下属性，提交到 Go 后端。
 */
export function FlowBuilder({
  value,
  onChange,
  onSubmitted,
  onPreviewChart,
}: {
  value: ReturnType<typeof emptyProcess>;
  onChange: (v: ReturnType<typeof emptyProcess>) => void;
  onSubmitted: () => void;
  onPreviewChart: () => void;
}) {
  const { name, description, applicant, steps } = value;
  const [submitting, setSubmitting] = useState(false);
  const glassInteraction = useGlassInteraction();

  const patchStep = (id: string, patch: Partial<FlowStep>) =>
    onChange({ ...value, steps: steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  const addStep = () => onChange({ ...value, steps: [...steps, emptyStep()] });

  const removeStep = (id: string) =>
    onChange({
      ...value,
      steps: steps
        .filter((s) => s.id !== id)
        // 清理依赖被删步骤的前置条件
        .map((s) => (s.waitFor?.stepId === id ? { ...s, waitFor: null } : s)),
    });

  const moveStep = (id: string, dir: -1 | 1) => {
    const i = steps.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    // 移动后清理非法依赖（依赖步骤不再位于当前步骤之前）
    const cleaned = next.map((s, idx) => {
      if (!s.waitFor?.stepId) return s;
      const d = next.findIndex((x) => x.id === s.waitFor!.stepId);
      if (d < 0 || d >= idx || !next[d].countersign) return { ...s, waitFor: null };
      return s;
    });
    onChange({ ...value, steps: cleaned });
  };

  /** 前端先行校验，与后端规则一致，避免无效提交 */
  const validate = (): string | null => {
    if (!name.trim()) return "请填写流程名称";
    const validHandler = (h: { department: string; staff: string[] }) =>
      h.department.trim() || h.staff.some((x) => x.trim());
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const n = i + 1;
      if (!s.name.trim()) return `第 ${n} 步的步骤名称不能为空`;
      const prev = i > 0 ? steps[i - 1] : undefined;
      const prevOnlineSys =
        prev && !prev.countersign && prev.mode === "online"
          ? prev.online.systemName.trim()
          : "";
      if (s.countersign) {
        // 会签步骤：属性下沉到子步骤，主级不再校验系统/经办
        if (!s.parties.some(validHandler))
          return `第 ${n} 步开启了会签，请至少添加一个会签部门及人员`;
        for (let j = 0; j < s.parties.length; j++) {
          const party = s.parties[j];
          const who = party.department.trim() || `会签方${j + 1}`;
          const subs = (party.subSteps ?? []).map((x) => ({ ...x }));
          for (let k = 0; k < subs.length; k++) {
            const sub = subs[k];
            if (!sub.name.trim()) continue;
            if (sub.mode === "online") {
              if (!sub.online.systemName.trim())
                return `第 ${n} 步「${who}」的子步骤「${sub.name}」为线上处理，请填写系统名称`;
              if (sub.online.mobileSupported == null)
                return `第 ${n} 步「${who}」的子步骤「${sub.name}」为线上处理，请选择是否支持移动端`;
              if (k > 0) {
                const p = subs[k - 1];
                const pSys = p.mode === "online" ? p.online.systemName.trim() : "";
                if (
                  pSys &&
                  pSys !== sub.online.systemName.trim() &&
                  sub.online.dataInteroperable == null
                )
                  return `第 ${n} 步「${who}」的子步骤「${p.name} → ${sub.name}」系统不同，请选择两系统是否数据互通`;
              }
            } else if (!sub.offline.handlers.some(validHandler)) {
              return `第 ${n} 步「${who}」的子步骤「${sub.name}」为线下处理，请至少填写一个经办部门及人员`;
            }
          }
        }
      } else {
        if (s.mode === "online") {
          if (!s.online.systemName.trim())
            return `第 ${n} 步为线上处理，请填写系统名称`;
          if (s.online.mobileSupported == null)
            return `第 ${n} 步为线上处理，请选择是否支持移动端`;
          if (
            prevOnlineSys &&
            prevOnlineSys !== s.online.systemName.trim() &&
            s.online.dataInteroperable == null
          )
            return `第 ${n} 步与上一步均为线上且系统不同（${prevOnlineSys} → ${s.online.systemName.trim()}），请选择两系统是否数据互通`;
        }
        if (s.mode === "offline" && !s.offline.handlers.some(validHandler))
          return `第 ${n} 步为线下处理，请至少填写一个经办部门及人员`;
      }
      if (s.waitFor?.stepId) {
        const d = steps.findIndex((x) => x.id === s.waitFor!.stepId);
        if (d < 0 || d >= i)
          return `第 ${n} 步的前置会签依赖只能指向其之前的会签步骤`;
        if (!steps[d].countersign)
          return `第 ${n} 步的前置依赖「${steps[d].name || "未命名"}」不是会签步骤`;
        if (
          s.waitFor.partyId &&
          !steps[d].parties.some((p) => p.id === s.waitFor!.partyId)
        )
          return `第 ${n} 步的前置会签依赖指向的会签方不存在`;
      }
    }
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      toast.error("提交失败", { description: err });
      return;
    }
    try {
      setSubmitting(true);
      const res = await fetch("/api/processes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          applicant,
          steps: steps.map((s, i) => {
            // 提交前规整：会签方兜底 + 悬空的前置依赖清理
            let waitFor = s.waitFor ?? null;
            if (waitFor?.stepId) {
              const d = steps.findIndex((x) => x.id === waitFor!.stepId);
              if (d < 0 || d >= i || !steps[d].countersign) waitFor = null;
              else if (waitFor.partyId && !steps[d].parties.some((p) => p.id === waitFor!.partyId))
                waitFor = { stepId: waitFor.stepId, partyId: "" };
            }
            return { ...s, parties: s.parties.map(normalizeParty), waitFor };
          }),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error("提交失败", { description: data?.error ?? "服务异常，请稍后重试" });
        return;
      }
      toast.success("流程已提交", {
        description: `「${data.name}」共 ${data.steps.length} 个步骤，已保存至后端`,
      });
      onSubmitted();
      onChange(emptyProcess());
    } catch {
      toast.error("网络异常", { description: "无法连接后端服务，请确认 Go 服务已启动" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* 流程基本信息 */}
      <section className="glass-card p-5">
        <h2 className="mb-4 text-base font-semibold text-white">流程基本信息</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-neutral-300" htmlFor="flow-name">
              流程名称 <span className="text-red-400">*</span>
            </Label>
            <Input
              id="flow-name"
              value={name}
              placeholder="如：采购申请审批流程"
              onChange={(e) => onChange({ ...value, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-neutral-300" htmlFor="flow-applicant">
              申报人（选填）
            </Label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <Input
                id="flow-applicant"
                className="pl-9"
                value={applicant}
                placeholder="填写申报人姓名"
                onChange={(e) => onChange({ ...value, applicant: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-neutral-300" htmlFor="flow-desc">
              流程说明（选填）
            </Label>
            <Textarea
              id="flow-desc"
              value={description}
              placeholder="简要说明流程的目的、适用范围等"
              onChange={(e) => onChange({ ...value, description: e.target.value })}
            />
          </div>
        </div>
      </section>

      {/* 步骤区：左侧流程轨道（青蓝节点 = 普通步骤，琥珀菱形 = 会签） */}
      <section className="space-y-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base font-semibold text-white">
            流程步骤
            <span className="ml-2 text-xs font-normal text-[color:var(--flow-muted)]">
              沿轨道依次增加下一步 · 菱形节点为会签
            </span>
          </h2>
          <span className="font-data shrink-0 text-xs text-cyan-300/70">
            STEP {String(steps.length).padStart(2, "0")}
          </span>
        </div>

        {/* 步骤锚点导航条：复杂流程（多方会签）快速定位 */}
        {steps.length > 1 && (
          <nav
            aria-label="步骤导航"
            className="sticky top-2 z-30 -mx-1 flex items-center gap-1.5 overflow-x-auto rounded-xl border border-white/10 bg-[color:var(--flow-panel)]/90 px-2 py-1.5 backdrop-blur"
          >
            {steps.map((s, i) => {
              const issues = stepIssues(s);
              const ready = issues.length === 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  title={`${i + 1}. ${s.name || "未命名"}${ready ? "（就绪）" : "（待完善：" + issues[0] + "）"}`}
                  onClick={() =>
                    document
                      .getElementById(`step-${s.id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={cn(
                    "font-data flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border px-1.5 text-xs transition",
                    ready
                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300 hover:border-emerald-300"
                      : "border-red-400/50 bg-red-400/10 text-red-300 hover:border-red-300",
                  )}
                >
                  {i + 1}
                </button>
              );
            })}
            <span className="mx-1 h-4 w-px shrink-0 bg-white/15" aria-hidden="true" />
            <span className="font-data shrink-0 text-[10px] text-neutral-500">
              {steps.filter((s) => stepIssues(s).length === 0).length}/{steps.length} 就绪
            </span>
          </nav>
        )}

        <ol className="space-y-0">
          <AnimatePresence initial={false}>
            {steps.map((step, i) => (
              <li key={step.id} id={`step-${step.id}`} className="flex scroll-mt-24 gap-3 pb-5 sm:gap-4">
                {/* 轨道节点列（pt 对准卡片首行垂直中线） */}
                <div className="flex w-8 shrink-0 flex-col items-center pt-5 sm:pt-6" aria-hidden="true">
                  <span
                    className={
                      "rail-node font-data text-xs font-semibold" +
                      (step.countersign ? " rail-node--countersign" : "")
                    }
                  >
                    <span>{i + 1}</span>
                  </span>
                  <span className="rail-line" />
                </div>
                {/* 步骤卡片 */}
                <div className="min-w-0 flex-1">
                  <StepCard
                    step={step}
                    steps={steps}
                    index={i}
                    total={steps.length}
                    onChange={(patch) => patchStep(step.id, patch)}
                    onRemove={() => removeStep(step.id)}
                    onMove={(dir) => moveStep(step.id, dir)}
                  />
                </div>
              </li>
            ))}
          </AnimatePresence>

          {/* 轨道末端：添加下一步 */}
          <li className="flex gap-3 sm:gap-4">
            <div className="flex w-8 shrink-0 flex-col items-center" aria-hidden="true">
              <span className="rail-node font-data border-dashed text-base text-cyan-300/80">+</span>
            </div>
            <div className="flex flex-1 items-center">
              <motion.button {...glassInteraction} onClick={addStep} className="rounded-full">
                <LiquidGlass
                  tint={0.12}
                  scale={24}
                  bevelDepth={10}
                  aberration={2}
                  className={GLASS_SHADOW}
                  contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium"
                >
                  <Plus className="h-4 w-4" /> 添加下一步
                </LiquidGlass>
              </motion.button>
            </div>
          </li>
        </ol>
      </section>

      {/* 提交区 */}
      <section className="flex flex-wrap items-center justify-end gap-3">
        {/* 重置：玻璃次级 */}
        <motion.button {...glassInteraction} onClick={() => onChange(emptyProcess())} className="rounded-full">
          <LiquidGlass
            tint={0.12}
            scale={24}
            bevelDepth={10}
            aberration={2}
            className={GLASS_SHADOW}
            contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm"
          >
            <RotateCcw className="h-3.5 w-3.5" /> 重置
          </LiquidGlass>
        </motion.button>
        {/* 一键生成流程图：玻璃强调（官方 Book a demo 款式） */}
        <motion.button {...glassInteraction} onClick={onPreviewChart} className="rounded-full">
          <LiquidGlass
            tint={0.2}
            scale={24}
            bevelDepth={10}
            aberration={2}
            className={GLASS_SHADOW}
            contentClassName="flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium [text-shadow:0_1px_2px_rgb(0_0_0/0.25)]"
          >
            <Waypoints className="h-4 w-4" /> 一键生成流程图
          </LiquidGlass>
        </motion.button>
        {/* 提交流程：白色实底主按钮（官方 Start for free 款式） */}
        <motion.button
          {...glassInteraction}
          onClick={() => void submit()}
          className="flex items-center gap-2 rounded-full bg-white px-7 py-2.5 text-sm font-semibold text-neutral-900 shadow-lg"
        >
          <Save className="h-4 w-4" /> 提交流程
        </motion.button>
      </section>

      {/* 提交过程 loading：官方 MultiStepLoader */}
      <MultiStepLoader
        loading={submitting}
        loop={false}
        duration={900}
        loadingStates={[
          { text: "校验流程数据" },
          { text: "保存步骤与会签配置" },
          { text: "写入 PostgreSQL" },
        ]}
      />
    </div>
  );
}

export type { FlowProcess };
