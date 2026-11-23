"use client";

import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import { Plus, RotateCcw, Save, User, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MultiStepLoader } from "@/components/ui/multi-step-loader";
import { cn } from "@/lib/utils";
import { stepIssues, interopSystems, subInteropPrev } from "@/lib/step-checks";
import { StepCard } from "@/components/step-card";
import type { FlowProcess, FlowStep } from "@/lib/types";
import { emptyProcess, emptyStep, normalizeParty } from "@/lib/types";
import { adminFetch } from "@/lib/auth";

/**
 * 流程收集主表单（液态玻璃）：流程基本信息 + 自定义增删/排序步骤，
 * 每步可配置会签与线上/线下属性，提交到 Go 后端。
 * 桌面端提交区为内联玻璃条；移动端为底部悬浮玻璃 Dock。
 */
export function FlowBuilder({
  value,
  onChange,
  onSubmitted,
  onPreviewChart,
  /** 编辑已有流程:提交走 PUT /api/admin/processes/{id}(需管理员或被指派跟进人) */
  existingId,
}: {
  value: ReturnType<typeof emptyProcess>;
  onChange: (v: ReturnType<typeof emptyProcess>) => void;
  onSubmitted: () => void;
  onPreviewChart: () => void;
  existingId?: string;
}) {
  const { name, description, applicant, steps } = value;
  const [submitting, setSubmitting] = useState(false);
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
              // 与上一个已命名子步骤均线上且系统不同：必须选择是否数据互通
              const p = subInteropPrev(subs, k);
              if (p && sub.online.dataInteroperable == null)
                return `第 ${n} 步「${who}」的子步骤「${p.name} → ${sub.name}」系统不同，请选择两系统是否数据互通`;
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
          // 相邻线上且系统不同（上一步为会签时取各方末位子步骤的系统）：必须选择是否数据互通
          const prevSystems = interopSystems(s, prev);
          if (prevSystems.length && s.online.dataInteroperable == null)
            return `第 ${n} 步与上一步${prev?.countersign ? "（会签）" : ""}均为线上且系统不同（${prevSystems.join("、")} → ${s.online.systemName.trim()}），请选择两系统是否数据互通`;
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
      // 载荷构造(新建 POST / 编辑 PUT 共用)
      const payload = {
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
      };
      const data = existingId
        ? await adminFetch<FlowProcess>(`/api/admin/processes/${existingId}?via=form`, {
            method: "PUT",
            body: JSON.stringify(payload),
          })
        : await fetch("/api/processes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).then(async (res) => {
            const d = await res.json();
            if (!res.ok) throw new Error(d?.error ?? "服务异常，请稍后重试");
            return d as FlowProcess;
          });
      toast.success(existingId ? "流程已更新" : "流程已提交", {
        description: `「${data.name}」共 ${data.steps.length} 个步骤`,
      });
      onSubmitted();
      if (!existingId) onChange(emptyProcess());
    } catch {
      toast.error("网络异常", { description: "无法连接后端服务，请确认 Go 服务已启动" });
    } finally {
      setSubmitting(false);
    }
  };

  const readyCount = steps.filter((s, i) => stepIssues(s, steps[i - 1]).length === 0).length;

  return (
    <div className="space-y-7">
      {/* 流程基本信息 */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="mb-4 flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em] text-neutral-900">
          <svg className="h-[18px] w-[18px] text-[color:var(--tint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M7 4h10a2 2 0 0 1 2 2v14l-4.5-2.5L10 20l-2.7-2L5 20V6a2 2 0 0 1 2-2z"/><path d="M9 9h6M9 12.5h4"/></svg>
          流程基本信息
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="flow-name">
              流程名称 <span className="text-[color:var(--red)]">*</span>
            </Label>
            <Input
              id="flow-name"
              value={name}
              placeholder="如：采购申请审批流程"
              onChange={(e) => onChange({ ...value, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="flow-applicant">
              申报人 <span className="font-normal text-[color:var(--ink-3)]">选填</span>
            </Label>
            <div className="relative">
              <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" />
              <Input
                id="flow-applicant"
                className="pl-10"
                value={applicant}
                placeholder="填写申报人姓名"
                onChange={(e) => onChange({ ...value, applicant: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="flow-desc">
              流程说明 <span className="font-normal text-[color:var(--ink-3)]">选填</span>
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

      {/* 步骤区：左侧流程轨道（玻璃圆珠 = 普通步骤，琥珀菱形 = 会签） */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em] text-neutral-900">
            <svg className="h-[18px] w-[18px] text-[color:var(--tint)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="5.5" cy="6" r="2.2"/><circle cx="5.5" cy="18" r="2.2"/><circle cx="18.5" cy="12" r="2.2"/><path d="M7.6 6.8 16.3 11.2M7.6 17.2 16.3 12.8"/></svg>
            流程步骤
            <span className="text-xs font-normal text-[color:var(--ink-2)]">
              沿时间轨依次添加 · 琥珀菱形为会签
            </span>
          </h2>
          <span className="font-data text-xs text-[color:var(--ink-3)]">
            {readyCount}/{steps.length} 就绪
          </span>
        </div>

        {/* 步骤锚点导航条：复杂流程（多方会签）快速定位 */}
        {steps.length > 1 && (
          <nav
            aria-label="步骤导航"
            className="lg-clear sticky top-[72px] z-30 -mx-1 flex w-max max-w-full items-center gap-1.5 overflow-x-auto px-2 py-1.5"
          >
            {steps.map((s, i) => {
              const issues = stepIssues(s, steps[i - 1]);
              const ok = issues.length === 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  title={`${i + 1}. ${s.name || "未命名"}${ok ? "（就绪）" : "（待完善：" + issues[0] + "）"}`}
                  onClick={() =>
                    document
                      .getElementById(`step-${s.id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                  className={cn(
                    "font-data flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-xs font-semibold transition",
                    ok
                      ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)] shadow-[inset_0_0_0_0.5px_rgba(52,199,89,0.35)] hover:brightness-105"
                      : "bg-[color:var(--red-soft)] text-[color:var(--red-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,59,48,0.3)] hover:brightness-105",
                  )}
                >
                  {i + 1}
                </button>
              );
            })}
            <span className="mx-1 h-4 w-px shrink-0 bg-[color:var(--sep)]" aria-hidden="true" />
            <span className="font-data shrink-0 px-1.5 text-[11px] text-[color:var(--ink-2)]">
              {readyCount}/{steps.length} 就绪
            </span>
          </nav>
        )}

        <ol className="space-y-0">
          <AnimatePresence initial={false}>
            {steps.map((step, i) => (
              <li key={step.id} id={`step-${step.id}`} className="flex scroll-mt-36 gap-2.5 pb-5 sm:gap-3">
                {/* 轨道节点列(垂直中线对准卡片首行) */}
                <div className="flex w-8 shrink-0 flex-col items-center pt-[13px] sm:w-9 sm:pt-4" aria-hidden="true">
                  <span
                    className={
                      "rail-node" + (step.countersign ? " rail-node--countersign" : "")
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
          <li className="flex gap-2.5 sm:gap-3">
            <div className="flex w-8 shrink-0 flex-col items-center sm:w-9" aria-hidden="true">
              <span className="rail-node grid place-items-center border-0 text-base !shadow-none" style={{ background: "transparent", boxShadow: "inset 0 0 0 1.5px rgba(10,132,255,0.45)" }}>
                <span className="font-normal text-[color:var(--tint)]" style={{ transform: "none" }}>+</span>
              </span>
            </div>
            <div className="flex flex-1 items-center">
              <button type="button" onClick={addStep} className="btn btn-glass">
                <Plus className="h-4 w-4" /> 添加下一步
              </button>
            </div>
          </li>
        </ol>
      </section>

      {/* 提交区(桌面:内联玻璃条;移动端隐藏,由底部 Dock 接管) */}
      <section className="glass-card mb-2 hidden flex-wrap items-center justify-between gap-3 p-4 sm:flex sm:p-5">
        <p className="flex items-center gap-2 px-1 text-[13px] text-[color:var(--ink-2)]">
          <span className={cn("h-2 w-2 rounded-full", readyCount === steps.length ? "bg-[color:var(--green)]" : "bg-[color:var(--red)]")} />
          <span className="font-data">{readyCount}/{steps.length}</span> 步骤就绪 · 提交前请完善标红的必填项
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={() => onChange(emptyProcess())} className="btn btn-glass">
            <RotateCcw className="h-4 w-4" /> 重置
          </button>
          <button type="button" onClick={onPreviewChart} className="btn btn-glass">
            <Waypoints className="h-4 w-4" /> 一键生成流程图
          </button>
          <button type="button" onClick={() => void submit()} className="btn btn-primary text-[17px]">
            <Save className="h-4 w-4" /> 提交流程
          </button>
        </div>
      </section>

      {/* 移动端底部操作 Dock(Clear 玻璃,44pt+ 触摸目标) */}
      <div
        className="lg-clear fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 flex items-center gap-2.5 p-2.5 sm:hidden"
        style={{ borderRadius: 26 }}
      >
        <button
          type="button"
          onClick={() => onChange(emptyProcess())}
          aria-label="重置"
          className="btn btn-glass !h-12 !w-12 shrink-0 !p-0"
        >
          <RotateCcw className="h-[18px] w-[18px]" />
        </button>
        <button type="button" onClick={onPreviewChart} className="btn btn-glass !h-12 shrink-0">
          <Waypoints className="h-4 w-4" /> 流程图
        </button>
        <button type="button" onClick={() => void submit()} className="btn btn-primary !h-12 min-w-0 flex-1 text-[16px]">
          <Save className="h-4 w-4" /> 提交流程
        </button>
      </div>
      {/* Dock 遮挡避让:移动端内容底部留白 */}
      <div className="h-20 sm:hidden" aria-hidden="true" />

      {/* 提交过程 loading:MultiStepLoader(亮色) */}
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
