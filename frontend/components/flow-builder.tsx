"use client";

import { AnimatePresence } from "motion/react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Plus, RotateCcw, Save, User, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MultiStepLoader } from "@/components/ui/multi-step-loader";
import { FormIssuesDialog, type FormIssueGroup } from "@/components/form-issues-dialog";
import { cn } from "@/lib/utils";
import { stepIssues, stepIssueList } from "@/lib/step-checks";
import { issueAnchorId, focusAnchor } from "@/lib/form-focus";
import { StepCard } from "@/components/step-card";
import type { FlowProcess, FlowStep } from "@/lib/types";
import { emptyProcess, emptyStep, normalizeParty } from "@/lib/types";
import { adminFetch, clearSession, getToken } from "@/lib/auth";
import { newRequestId, reportApiFailure } from "@/lib/client-logger";

/** 流程名称输入框的锚点 id */
const BASE_ANCHOR = "flow-name";

/** 请求根本没发出去(断网、后端没启动),区别于后端返回的业务错误 */
class NetworkError extends Error {}

/** 提交时发现会话过期:已在提交处提示并送去登录页,不要再说成"提交被拒绝" */
class SessionExpiredError extends Error {}

/**
 * 汇总整张表单还差的全部必填项(与后端校验规则一致),按填写顺序分组。
 * 提交时一次全部列出,而不是修一个才看到下一个。
 */
function collectFormIssues(name: string, steps: FlowStep[]): FormIssueGroup[] {
  const groups: FormIssueGroup[] = [];
  if (!name.trim()) {
    groups.push({
      title: "流程基本信息",
      anchorId: BASE_ANCHOR,
      items: [{ text: "未填写流程名称", anchorId: BASE_ANCHOR }],
    });
  }
  steps.forEach((s, i) => {
    const items: FormIssueGroup["items"] = stepIssueList(s, steps[i - 1]).map((it) => ({
      text: it.text,
      anchorId: issueAnchorId(s.id, it.field),
    }));
    // 前置会签条件指向的步骤已失效(移动、删除步骤时会自动清理,这里是防线)
    const d = s.waitFor?.stepId ? steps.findIndex((x) => x.id === s.waitFor!.stepId) : -1;
    if (s.waitFor?.stepId && (d < 0 || d >= i || !steps[d].countersign)) {
      items.push({ text: "前置会签条件指向的步骤已失效，请重新选择或取消", anchorId: null });
    }
    if (items.length) {
      groups.push({
        title: `第 ${i + 1} 步${s.name.trim() ? ` · ${s.name.trim()}` : "（未命名）"}`,
        anchorId: items[0].anchorId,
        items,
      });
    }
  });
  return groups;
}

/**
 * 流程收集主表单（液态玻璃）：流程基本信息 + 自定义增删/排序步骤，
 * 每步可配置会签与线上/线下属性，提交到 Go 后端。
 * 桌面端提交区为内联玻璃条；移动端为底部悬浮玻璃 Dock。
 *
 * 必填引导:每个步骤卡片顶部常驻"还差 N 项必填";提交时若有缺失,弹清单一次列出全部,
 * 点哪项跳到哪项,同时把仍为空的必填控件标红。
 */
export function FlowBuilder({
  value,
  onChange,
  onSubmitted,
  onPreviewChart,
  /** 编辑已有流程:保存走 PUT /api/admin/processes/{id}(项目里的 PM / BH / TH、CTO 或管理员);此时不提供重置与图预览 */
  existingId,
}: {
  value: ReturnType<typeof emptyProcess>;
  onChange: (v: ReturnType<typeof emptyProcess>) => void;
  onSubmitted: () => void;
  onPreviewChart: () => void;
  existingId?: string;
}) {
  const { name, description, applicant, steps } = value;
  const router = useRouter();
  // 编辑态:按钮写「保存修改」,也不给「重置」(会把已加载的流程清空)和「一键生成流程图」(编辑弹层里没有预览)
  const editing = Boolean(existingId);
  const [submitting, setSubmitting] = useState(false);
  /** 点过提交之后:仍缺失的必填控件标红 */
  const [attempted, setAttempted] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const issueGroups = useMemo(() => collectFormIssues(name, steps), [name, steps]);
  const missing = issueGroups.reduce((n, g) => n + g.items.length, 0);

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

  /** 从"还差什么"清单跳到某一项:先关弹窗,再滚动聚焦 */
  const jumpTo = (anchorId: string | null) => {
    setSummaryOpen(false);
    focusAnchor(anchorId);
  };

  const submit = async () => {
    if (missing > 0) {
      // 必填没填齐:不发请求,列出全部缺失项,并把对应控件标红
      setAttempted(true);
      setSummaryOpen(true);
      return;
    }
    setSubmitting(true);
    try {
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
      let data: FlowProcess;
      if (existingId) {
        data = await adminFetch<FlowProcess>(`/api/admin/processes/${existingId}?via=form`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        const requestId = newRequestId();
        // 收集表仅登录可填:提交要带上会话令牌,后端把提交人记进项目的 created_by
        const headers: Record<string, string> = { "Content-Type": "application/json", "X-Request-Id": requestId };
        const token = getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        let res: Response;
        try {
          res = await fetch("/api/processes", {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        } catch {
          // 请求没发出去(断网、后端没启动),后端自己记不到,所以报一条浏览器日志
          reportApiFailure({ method: "POST", path: "/api/processes", status: 0, requestId, message: "提交时没有连上服务器" });
          throw new NetworkError();
        }
        const d = (await res.json().catch(() => null)) as (FlowProcess & { error?: string }) | null;
        // 回来的不是后端的 JSON(网关、隧道的错误页):同样只有浏览器这边知道
        if (!d) reportApiFailure({ method: "POST", path: "/api/processes", status: res.status, requestId, message: `服务返回了 ${res.status}` });
        if (res.status === 401) {
          // 填写途中会话过期:清掉本地会话送去登录页,带着 next=/ 回来继续填这张表
          clearSession();
          toast.error("登录已过期", { description: "请重新登录后继续填写" });
          router.replace("/login?next=/");
          throw new SessionExpiredError();
        }
        // 后端校验没过、提交太频繁等:原样显示后端给的说明,不要说成网络异常
        if (!res.ok) throw new Error(d?.error ?? `服务返回了 ${res.status}，请稍后重试`);
        if (!d) throw new Error("服务返回了无法识别的内容，请稍后重试");
        data = d;
      }
      toast.success(existingId ? "流程已更新" : "流程已提交", {
        description: `「${data.name}」共 ${data.steps.length} 个步骤`,
      });
      setAttempted(false);
      onSubmitted();
      // 重置表单准备下一张;申报人保留(同一人往往连续提交,页面也会用登录账号兜底)
      if (!existingId) onChange({ ...emptyProcess(), applicant });
    } catch (e) {
      if (e instanceof NetworkError) {
        toast.error("网络异常", { description: "无法连接后端服务，请确认 Go 服务已启动" });
      } else if (!(e instanceof SessionExpiredError)) {
        toast.error(existingId ? "保存被拒绝" : "提交被拒绝", {
          description: e instanceof Error ? e.message : "请稍后重试",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const readyCount = steps.filter((s, i) => stepIssues(s, steps[i - 1]).length === 0).length;
  const nameMissing = attempted && !name.trim();

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
              <span className="font-normal text-[color:var(--ink-3)]">必填</span>
            </Label>
            <Input
              id="flow-name"
              value={name}
              aria-invalid={nameMissing}
              placeholder="如：采购申请审批流程"
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              className={nameMissing ? "field-invalid" : undefined}
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
                    attempted={attempted}
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
        <p className="flex flex-wrap items-center gap-2 px-1 text-[13px] text-[color:var(--ink-2)]">
          {missing === 0 ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-[color:var(--green)]" />
              流程名称和全部步骤的必填项都已填好，可以提交
            </>
          ) : (
            <>
              <AlertCircle className="h-4 w-4 text-[color:var(--red)]" />
              <span>
                还有 <b className="font-data text-[color:var(--red-deep)]">{missing}</b> 项必填未完成
              </span>
              <button
                type="button"
                onClick={() => setSummaryOpen(true)}
                className="rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold text-[color:var(--tint)] shadow-[inset_0_0_0_0.5px_rgba(0,113,227,0.25)] transition hover:bg-white"
              >
                查看是哪些
              </button>
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {!editing && (
            <>
              <button type="button" onClick={() => onChange(emptyProcess())} className="btn btn-glass">
                <RotateCcw className="h-4 w-4" /> 重置
              </button>
              <button type="button" onClick={onPreviewChart} className="btn btn-glass">
                <Waypoints className="h-4 w-4" /> 一键生成流程图
              </button>
            </>
          )}
          <button type="button" onClick={() => void submit()} className="btn btn-primary text-[17px]">
            <Save className="h-4 w-4" /> {editing ? "保存修改" : "提交流程"}
          </button>
        </div>
      </section>

      {/* 移动端底部操作 Dock(Clear 玻璃,44pt+ 触摸目标) */}
      <div
        className="lg-clear fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 flex items-center gap-2.5 p-2.5 sm:hidden"
        style={{ borderRadius: 26 }}
      >
        {!editing && (
          <>
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
          </>
        )}
        <button type="button" onClick={() => void submit()} className="btn btn-primary !h-12 min-w-0 flex-1 text-[16px]">
          <Save className="h-4 w-4" /> {editing ? "保存修改" : "提交流程"}
          {/* 还差的必填数:点提交会列出是哪些 */}
          {missing > 0 && (
            <span className="ml-0.5 rounded-full bg-white/25 px-1.5 font-data text-[12px] font-semibold leading-5">缺 {missing}</span>
          )}
        </button>
      </div>
      {/* Dock 遮挡避让:移动端内容底部留白 */}
      <div className="h-20 sm:hidden" aria-hidden="true" />

      {/* 提交被拦下:一次列出全部还差的必填项 */}
      {summaryOpen && missing > 0 && (
        <FormIssuesDialog groups={issueGroups} total={missing} onClose={() => setSummaryOpen(false)} onJump={jumpTo} />
      )}

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
