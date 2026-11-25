"use client";

/**
 * PMO 的初级分析与指派:改造价值 / 复杂度 / 优先级 / 目标完成日、分析结论、流程是否完整,
 * 完成初级分析后指派一名或多名 PM(其中一名主负责)。管理员可以不做初级分析直接指派(兜底)。
 * 指派面板独立于环节:指派第一位 PM 后环节就进入「PM 推进」,但 PMO 之后仍可增补 PM、更换主负责。
 */

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { authFetch, type SessionUser } from "@/lib/auth";
import type { IntakeView, ProjectView, UserDir } from "@/lib/types";
import { JOB_ROLE_LABEL, OVERALL, PRIORITY_LABEL } from "@/lib/labels";
import { completenessText } from "@/lib/intake";
import { useAction } from "@/components/projects/intake-action";
import { MemberChip } from "@/components/projects/stage-rail";
import { Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function IntakeTriage({ v, project, me, onSaved }: { v: IntakeView; project: ProjectView; me: SessionUser; onSaved: () => Promise<void> }) {
  const triaged = !!v.triageDoneAt;
  const conclusion = String(project.analysis?.conclusion ?? "");

  return (
    <section className="glass-card p-5">
      <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
        初级分析
        <span className="badge badge-plain !h-[20px] text-[11px]">PMO</span>
        {triaged && (
          <span className="badge badge-ok ml-auto !h-[20px] text-[11px]">
            {v.triageByName} · {v.triageDoneAt ? new Date(v.triageDoneAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""} 完成
          </span>
        )}
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
        {triaged ? "初级分析在指派 PM 后锁定。之后的改造价值、复杂度由 PM 在「概览」里维护。" : "先看自动诊断与流程本身,给出价值、复杂度与流程是否完整的判断;完成初级分析后才能指派 PM。"}
      </p>
      {v.can.triage ? <TriageForm key={project.id} project={project} v={v} triaged={triaged} onSaved={onSaved} /> : <TriageReadonly project={project} v={v} conclusion={conclusion} />}
    </section>
  );
}

/**
 * 指派 PM 承接:可以从下拉里连续选多名,一次指派(还没有主负责时,排在前面的是主负责)。
 * later:已经过了指派环节,面板放在当前环节的面板之后,只用来增补 PM、更换主负责。
 */
export function IntakeAssign({ v, project, users, me, onSaved, later }: { v: IntakeView; project: ProjectView; users: UserDir[]; me: SessionUser; onSaved: () => Promise<void>; later?: boolean }) {
  const base = `/api/projects/${project.id}`;
  const [picked, setPicked] = useState<UserDir[]>([]);
  const { busy, run } = useAction(onSaved);

  // 管理员可以不做初级分析直接指派;PMO 必须先完成初级分析
  const open = project.status === "active" && v.can.assign && (!!v.triageDoneAt || me.role === "admin");
  const pms = project.members.filter((m) => m.role === "pm");
  const has = new Set(pms.map((m) => m.userId));
  const isPicked = new Set(picked.map((u) => u.id));
  const candidates = users
    .filter((u) => !has.has(u.id) && !isPicked.has(u.id))
    .sort((a, b) => Number(b.jobRole === "pm") - Number(a.jobRole === "pm") || a.displayName.localeCompare(b.displayName, "zh-CN"));

  /** 指派选中的 PM:逐个到岗,全部完成后刷新一次 */
  const assign = () => {
    const list = picked;
    setPicked([]);
    void run(
      "指派失败",
      async () => {
        let done = 0;
        try {
          for (const u of list) {
            await authFetch(`${base}/members`, { method: "PUT", body: JSON.stringify({ userId: u.id, role: "pm", action: "add" }) });
            done++;
          }
        } finally {
          // 中途失败:已经到岗的先落到现在界面上,再把失败原因交给 run 提示
          if (done < list.length) void onSaved();
        }
      },
      list.length === 1
        ? `已指派 ${list[0].displayName}${pms.length === 0 ? "（主负责）" : ""}`
        : `已指派 ${list.map((u) => u.displayName).join("、")}${pms.length === 0 ? `，${list[0].displayName} 为主负责` : ""}`,
    );
  };

  /** 移除 PM、更换主负责 */
  const member = (body: Record<string, unknown>, ok: string) =>
    run("操作失败", () => authFetch(`${base}/members`, { method: "PUT", body: JSON.stringify(body) }), ok);

  return (
    <section className="glass-card p-5">
      <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-neutral-900">
        指派 PM 承接
        <span className="badge badge-blue !h-[20px] font-data text-[11px]">已指派 {pms.length} 名</span>
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
        {later ? "可以继续增补 PM，或更换主负责。" : "指派一名或多名项目经理，其中一名为主负责、对整体推进负责。PM 到岗后自行分配 BH，必要时申请 CTO 协助。"}
      </p>

      {pms.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {pms.map((m) => (
            <MemberChip
              key={m.userId}
              name={m.displayName}
              role="pm"
              lead={project.leadPmId === m.userId}
              onMakeLead={open ? () => void member({ userId: m.userId, role: "pm", action: "add", lead: true }, `已把主负责改为 ${m.displayName}`) : undefined}
              onRemove={open ? () => void member({ userId: m.userId, role: "pm", action: "remove" }, `已移除 ${m.displayName}`) : undefined}
              disabled={busy}
            />
          ))}
        </div>
      )}
      {pms.length === 0 && <p className="mt-3 text-xs font-medium text-[color:var(--amber-deep)]">尚未指派 PM。</p>}

      {!open && !v.triageDoneAt && project.status === "active" && v.can.assign && (
        <p className="mt-3 rounded-2xl bg-[color:var(--amber-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[color:var(--amber-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
          请先完成初级分析，再指派 PM。
        </p>
      )}

      {open && (
        <div className="mt-3">
          {picked.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--ink-2)]">
              <span>待指派{pms.length === 0 ? "（排在前的是主负责）" : ""}</span>
              {picked.map((u) => (
                <span key={u.id} className="tag-chip !h-[28px] !text-[12px]">
                  {u.displayName}
                  {u.jobRole !== "pm" && <span className="ml-1 text-[11px] text-[color:var(--amber-deep)]">岗位不是 PM</span>}
                  <button type="button" aria-label={`取消选择 ${u.displayName}`} disabled={busy} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))} className="ml-1 disabled:opacity-50">
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              {/* value 恒为空:选完一个人就回到占位项,方便接着选下一位 */}
              <select
                value=""
                aria-label="选择 PM"
                disabled={busy}
                onChange={(e) => {
                  const u = users.find((x) => x.id === e.target.value);
                  if (u) setPicked((p) => [...p, u]);
                }}
                className="field pr-9 disabled:opacity-50"
              >
                <option value="">{candidates.length ? (picked.length ? "继续选择项目经理…" : "选择项目经理…") : "没有可选的人"}</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                    {u.jobRole === "pm" ? ` · ${JOB_ROLE_LABEL[u.jobRole]}` : ""}
                    {u.department ? ` · ${u.department}` : ""}
                  </option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9.5l6 6 6-6" />
              </svg>
            </div>
            <button type="button" disabled={!picked.length || busy} onClick={assign} className="btn btn-primary shrink-0 disabled:opacity-50">
              <UserPlus className="h-4 w-4" aria-hidden="true" /> 指派{picked.length > 1 ? ` ${picked.length} 名` : ""}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 初级分析的表单(还没指派 PM,可以改):「保存」随时可用;「完成初级分析」要求必填项都已填好 */
function TriageForm({ project, v, triaged, onSaved }: { project: ProjectView; v: IntakeView; triaged: boolean; onSaved: () => Promise<void> }) {
  const [value, setValue] = useState(project.value);
  const [complexity, setComplexity] = useState(project.complexity);
  const [priority, setPriority] = useState(project.priority);
  const [dueDate, setDueDate] = useState(project.dueDate);
  const [conclusion, setConclusion] = useState(String(project.analysis?.conclusion ?? ""));
  const [completeness, setCompleteness] = useState(v.completeness);
  const [completenessNote, setCompletenessNote] = useState(v.completenessNote);
  const { busy, run } = useAction(onSaved);

  const missing = [
    !OVERALL.includes(value as (typeof OVERALL)[number]) && "改造价值",
    !OVERALL.includes(complexity as (typeof OVERALL)[number]) && "复杂度",
    !completeness && "流程是否完整",
    !conclusion.trim() && "分析结论",
    completeness === "gaps" && !completenessNote.trim() && "流程的缺口说明",
  ].filter(Boolean) as string[];

  /** done:完成初级分析(服务端会再核一遍必填项) */
  const save = (done: boolean) =>
    run(
      done ? "完成初级分析失败" : "保存失败",
      () =>
        authFetch(`/api/projects/${project.id}/intake/triage`, {
          method: "PUT",
          body: JSON.stringify({ value, complexity, priority, dueDate, conclusion, completeness, completenessNote, done }),
        }),
      done ? "初级分析已完成，可以指派 PM 了" : "已保存",
    );

  const select = "field !h-9 w-auto min-w-[88px] !text-[13px]";
  return (
    <div className="mt-3.5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="改造价值">
          <select aria-label="改造价值" value={value} onChange={(e) => setValue(e.target.value)} className={select}>
            <option value="">待评估</option>
            {OVERALL.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="复杂度">
          <select aria-label="复杂度" value={complexity} onChange={(e) => setComplexity(e.target.value)} className={select}>
            <option value="">待评估</option>
            {OVERALL.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="优先级">
          <select aria-label="优先级" value={priority} onChange={(e) => setPriority(e.target.value as ProjectView["priority"])} className={select}>
            {(["high", "medium", "low"] as const).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="目标完成">
          <input type="date" aria-label="目标完成日" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={cn(select, "w-full")} />
        </Field>
      </div>

      <div className="mt-3.5 grid gap-3">
        <Field label="流程是否完整" hint="人工核对：有没有缺审批人、缺退回路径、步骤重复">
          <div className="seg seg-mini w-fit" role="group" aria-label="流程是否完整">
            {(
              [
                ["complete", "结构完整"],
                ["gaps", "有缺口"],
              ] as const
            ).map(([val, label]) => (
              <button key={val} type="button" className={cn(completeness === val && "on")} onClick={() => setCompleteness(completeness === val ? "" : val)}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        {completeness === "gaps" && (
          <Field label="缺口在哪" hint="会转给 PM 在推进时补全">
            <Textarea aria-label="流程的缺口" value={completenessNote} onChange={(e) => setCompletenessNote(e.target.value)} placeholder="如：行程预订被拒后没有写明退回到哪一步" className="min-h-[56px] !text-[13px]" />
          </Field>
        )}
        <Field label="分析结论" hint="问题集中在哪里、建议怎么承接">
          <Textarea
            aria-label="分析结论"
            value={conclusion}
            onChange={(e) => setConclusion(e.target.value)}
            placeholder="如：12 个节点里 3 个线下、3 处系统不互通、4 个不支持移动端，建议指派 2 名 PM 分线推进"
            className="min-h-[76px] !text-[13px]"
          />
        </Field>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        <button type="button" disabled={busy} onClick={() => save(false)} className="btn btn-glass !h-10 disabled:opacity-50">
          {triaged ? "保存修改" : "保存"}
        </button>
        {!triaged && (
          <button type="button" disabled={busy || missing.length > 0} onClick={() => save(true)} className="btn btn-primary !h-10 disabled:opacity-50" title="完成后才能指派 PM">
            完成初级分析
          </button>
        )}
        {missing.length > 0 && !triaged && <span className="text-xs text-[color:var(--ink-3)]">完成前还需填写：{missing.join("、")}</span>}
      </div>
    </div>
  );
}

function TriageReadonly({ project, v, conclusion }: { project: ProjectView; v: IntakeView; conclusion: string }) {
  return (
    <dl className="mt-3.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
      <dt className="text-[color:var(--ink-2)]">评估</dt>
      <dd className="text-neutral-900">
        改造价值 <b>{project.value || "待评估"}</b> · 复杂度 <b>{project.complexity || "待评估"}</b> · 优先级 <b>{PRIORITY_LABEL[project.priority]}</b>
        {project.dueDate && (
          <>
            {" "}
            · 目标 <span className="font-data">{project.dueDate}</span>
          </>
        )}
      </dd>
      <dt className="text-[color:var(--ink-2)]">流程是否完整</dt>
      <dd className="whitespace-pre-wrap text-neutral-900">{completenessText(v.completeness, v.completenessNote)}</dd>
      <dt className="text-[color:var(--ink-2)]">分析结论</dt>
      <dd className="whitespace-pre-wrap text-neutral-900">{conclusion || "—"}</dd>
    </dl>
  );
}
