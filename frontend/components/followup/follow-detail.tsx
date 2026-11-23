"use client";

/**
 * @deprecated 已被取代(2026-11-24):跟进详情由「流程项目」接管,
 * 见 components/projects/ 与 docs/process-management-architecture.md。
 * 所依赖的旧跟进接口(analyze / assign / status / stage / events)已下线,本组件不再被任何页面挂载,确认后可删除。
 */

/**
 * 跟进详情(设计稿 F2):需求分析结论卡 + 改造阶段步进 + 动态时间线 + 流程概要。
 * 权限:查看=登录;阶段推进/提交验收=管理员或被指派人;验收/搁置=管理员;
 * 编辑表单/编辑流程图=管理员或被指派人。
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { adminFetch } from "@/lib/auth";
import type { FollowEvent, FlowProcess } from "@/lib/types";
import { FOLLOW_STATUS_LABEL, STAGE_NAMES } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FlowChartModal, type ChartSource } from "@/components/flow-chart";
import { EditProcessModal } from "@/components/followup/edit-process-modal";
import { ChartEditorModal } from "@/components/followup/chart-editor";
import { OVERALL_MODE_LABEL, countersignMode } from "@/lib/step-checks";

const KIND_META: Record<string, { icon: string; color: string; label: (e: FollowEvent) => string }> = {
  analyzed: { icon: "M11 4.5a6.5 6.5 0 1 0 5 10.9L20 19.4", color: "var(--indigo-deep)", label: () => "需求分析" },
  assigned: { icon: "M3.5 18c1-3 3-4.5 5.5-4.5s4.5 1.5 5.5 4.5", color: "var(--amber-deep)", label: (e) => `指派 ${String(e.detail?.assignee ?? "")} 跟进` },
  status: { icon: "M9 4h6v3.5a3 3 0 0 1-6 0zM12 10.5V14M8.5 14h7", color: "var(--tint-deep)", label: () => "状态变更" },
  stage: { icon: "M12 4v14M6 12l6 6 6-6", color: "var(--tint-deep)", label: () => "阶段推进" },
  edited_form: { icon: "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z", color: "var(--ink-2)", label: () => "编辑了流程表单" },
  edited_chart: { icon: "M6 5.5h12v13H6zM3.5 12h17", color: "var(--indigo-deep)", label: () => "在流程图上修改" },
};

export function FollowDetail({
  processId,
  me,
  onBack,
  onChanged,
}: {
  processId: string;
  me: { username: string; role: string } | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [p, setP] = useState<FlowProcess | null>(null);
  const [events, setEvents] = useState<FollowEvent[]>([]);
  const [chart, setChart] = useState<ChartSource | null>(null);
  const [editForm, setEditForm] = useState(false);
  const [editChart, setEditChart] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [proc, evs] = await Promise.all([
        adminFetch<FlowProcess>(`/api/admin/processes/${processId}`, { cache: "no-store" }),
        adminFetch<FollowEvent[]>(`/api/admin/processes/${processId}/events`, { cache: "no-store" }),
      ]);
      setP(proc);
      setEvents(evs ?? []);
    } catch {
      toast.error("读取失败", { description: "无法获取跟进详情" });
    }
  }, [processId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = me?.role === "admin";
  const isAssignee = !!(me && p && p.assigneeName === me.username);
  const canEdit = isAdmin || isAssignee;
  const st = p?.followStatus ?? "analyzing";
  const stage = p?.stage ?? 0;

  const act = async (path: string, body: object, okMsg: string) => {
    setBusy(true);
    try {
      await adminFetch(`/api/admin/processes/${processId}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.success(okMsg);
      await load();
      onChanged();
    } catch (e) {
      toast.error("操作失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  if (!p) {
    return <p className="glass-card px-5 py-16 text-center text-sm text-[color:var(--ink-3)]">加载中…</p>;
  }

  const dueMs = p.dueDate ? new Date(p.dueDate + "T23:59:59").getTime() - Date.now() : null;
  const dueDaysLeft = dueMs != null ? Math.ceil(dueMs / 86_400_000) : null;

  return (
    <section>
      {/* 标题行 */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold text-[color:var(--tint)] transition hover:bg-[color:var(--tint-soft)]"
        >
          ← 跟进看板
        </button>
        <h2 className="text-[24px] font-bold tracking-[-0.02em]">{p.name}</h2>
        <span className={cn("badge", st === "following" ? "badge-blue" : st === "review" ? "badge-amber" : st === "done" ? "badge-ok" : "badge-plain")} style={{ height: 26 }}>
          <span className="dot" />{FOLLOW_STATUS_LABEL[st]}
        </span>
        {p.steps.filter((s) => s.countersign).length > 0 && (
          <span className="badge badge-amber" style={{ height: 26 }}><span className="dot" />含会签</span>
        )}
        <div className="ml-auto flex gap-2.5">
          <button className="btn btn-glass" onClick={() => setChart({ name: p.name, steps: p.steps })}>
            查看流程图
          </button>
          {canEdit && (st === "following" || st === "review" || st === "unassigned") && (
            <>
              <button className="btn btn-glass" onClick={() => setEditForm(true)}>编辑表单</button>
              <button className="btn btn-primary" onClick={() => setEditChart(true)}>编辑流程图</button>
            </>
          )}
        </div>
      </div>

      {/* 元信息 */}
      <div className="mt-3 flex flex-wrap gap-2.5">
        {p.assigneeName && (
          <span className="lg-chip inline-flex items-center gap-2 px-3.5 py-2 text-[13px] text-[color:var(--ink-2)]">
            <span className="grid h-[26px] w-[26px] place-items-center rounded-full text-[11px] font-semibold" style={{ background: "linear-gradient(180deg,#b8ccff,#9db4ff)", color: "#21407a" }}>
              {p.assigneeName.slice(0, 1)}
            </span>
            跟进人 <b className="text-neutral-900">{p.assigneeName}</b>
          </span>
        )}
        {p.dueDate && (
          <span className={cn("lg-chip inline-flex items-center gap-2 px-3.5 py-2 text-[13px]", dueDaysLeft != null && dueDaysLeft < 0 ? "text-[color:var(--red-deep)]" : "text-[color:var(--ink-2)]")}>
            目标 <b className={cn("tabular-nums", dueDaysLeft != null && dueDaysLeft < 0 ? "text-[color:var(--red-deep)]" : "text-neutral-900")}>{p.dueDate}</b>
            {dueDaysLeft != null && (dueDaysLeft < 0 ? `(逾期 ${-dueDaysLeft} 天)` : `(剩 ${dueDaysLeft} 天)`)}
          </span>
        )}
        {p.applicant && (
          <span className="lg-chip inline-flex items-center gap-2 px-3.5 py-2 text-[13px] text-[color:var(--ink-2)]">申报人 <b className="text-neutral-900">{p.applicant}</b></span>
        )}
        <span className="lg-chip inline-flex items-center px-3.5 py-2 text-[13px] tabular-nums text-[color:var(--ink-2)]">
          修改于 {new Date(p.updatedAt).toLocaleString("zh-CN")}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_360px]">
        <div className="grid gap-4">
          {/* 需求分析结论卡 */}
          {p.analysis && (
            <section
              className="glass-card p-5"
              style={{
                background: "linear-gradient(180deg, rgba(240,240,255,0.4), rgba(255,255,255,0.4))",
                boxShadow: "inset 0 0 0 0.5px rgba(88,86,214,0.22), inset 0 1px 0 rgba(255,255,255,0.95), 0 24px 56px -24px rgba(23,42,80,0.26)",
              }}
            >
              <div className="flex items-center gap-2 text-[15px] font-semibold">
                <svg className="h-[17px] w-[17px]" style={{ color: "var(--indigo)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4M11 8.5v2.5l1.8 1.2" />
                </svg>
                需求分析
                <span className="badge badge-indigo ml-auto" style={{ height: 22 }}>
                  {p.analysis.passedAt ? `已通过 · ${p.analysis.priority ?? ""}优` : "已记录 · 未通过"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Chip v={`价值 ${p.analysis.value || "—"}`} />
                <Chip v={`复杂度 ${p.analysis.complexity || "—"}`} />
                <Chip v={`分析人 ${p.analysis.analyst || "—"}`} />
                {p.analysis.passedAt && <Chip v={`通过于 ${new Date(p.analysis.passedAt).toLocaleDateString("zh-CN")}`} />}
              </div>
              {p.analysis.conclusion && (
                <p className="mt-2.5 text-[13px] leading-relaxed text-[color:var(--ink-2)]">{p.analysis.conclusion}</p>
              )}
            </section>
          )}

          {/* 改造阶段 */}
          <section className="glass-card p-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              改造阶段
              <span className="badge badge-blue ml-auto" style={{ height: 22 }}>{Math.min(stage, 5)}/5</span>
            </div>
            <div className="mt-4">
              {STAGE_NAMES.slice(1).map((name, i) => {
                const n = i + 1;
                const done = stage > n || st === "done";
                const now = stage === n && st !== "done";
                return (
                  <div key={n} className="flex gap-3.5">
                    <div className="flex w-[30px] shrink-0 flex-col items-center">
                      <span
                        className={cn(
                          "z-[1] grid h-[26px] w-[26px] place-items-center rounded-full text-xs font-bold",
                          done
                            ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)] shadow-[inset_0_0_0_1px_rgba(52,199,89,0.4)]"
                            : now
                              ? "bg-gradient-to-b from-[#2b95ff] to-[#0071e3] text-white shadow-[0_0_0_4px_rgba(0,113,227,0.18)]"
                              : "bg-[rgba(120,120,128,0.14)] text-[color:var(--ink-3)]",
                        )}
                      >
                        {done ? "✓" : n}
                      </span>
                      {n < 5 && <span className={cn("min-h-[22px] w-[2.5px] flex-1 rounded", done ? "bg-[rgba(52,199,89,0.4)]" : "bg-[rgba(120,120,128,0.18)]")} />}
                    </div>
                    <div className="min-w-0 flex-1 pb-4 pt-0.5">
                      <b className={cn("flex flex-wrap items-center gap-2 text-[14px]", done || now ? "text-neutral-900" : "text-[color:var(--ink-3)]")}>
                        {STAGE_NAMES[n]}
                        {now && canEdit && st === "following" && (
                          <button
                            className="btn btn-glass ml-auto !h-[30px] px-3 text-[12px]"
                            disabled={busy}
                            onClick={() => void act("/stage", { stage: n + 1 > 5 ? 5 : n + 1 }, `已推进至「${STAGE_NAMES[Math.min(n + 1, 5)]}」`)}
                          >
                            {n === 5 ? "完成全部阶段" : `推进至「${STAGE_NAMES[n + 1]}」`}
                          </button>
                        )}
                        {n === 5 && stage >= 5 && st === "following" && (
                          <span className="badge badge-amber" style={{ height: 20 }}>待提交验收</span>
                        )}
                      </b>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 状态操作 */}
            <div className="mt-1 flex flex-wrap gap-2.5 border-t border-[color:var(--sep)] pt-4">
              {st === "following" && canEdit && (
                <button className="btn btn-primary flex-1" disabled={busy} onClick={() => void act("/status", { status: "review" }, "已提交验收")}>
                  提交验收
                </button>
              )}
              {st === "review" && isAdmin && (
                <>
                  <button className="btn btn-glass flex-1" disabled={busy} onClick={() => void act("/status", { status: "following" }, "已退回跟进")}>退回跟进</button>
                  <button className="btn btn-primary flex-1" disabled={busy} onClick={() => void act("/status", { status: "done" }, "验收通过,流程改造完成")}>验收通过</button>
                </>
              )}
              {st !== "shelved" && isAdmin && st !== "done" && (
                <button
                  className="btn btn-glass flex-1"
                  disabled={busy}
                  onClick={() => void act("/status", { status: "shelved", note: "搁置" }, "已搁置")}
                >
                  搁置
                </button>
              )}
              {st === "shelved" && isAdmin && (
                <button className="btn btn-primary flex-1" disabled={busy} onClick={() => void act("/status", { status: "unassigned" }, "已恢复")}>恢复</button>
              )}
            </div>
          </section>

          {/* 流程概要 */}
          <section className="glass-card p-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold">流程概要</div>
            <div className="mt-3 grid gap-1">
              {p.steps.map((s, i) => (
                <div key={s.id} className="group flex items-center gap-3 rounded-2xl bg-white/50 px-3.5 py-2.5 text-[14px] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                  <span
                    className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center text-[11px] font-bold",
                      s.countersign
                        ? "rotate-45 rounded-[7px] bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]"
                        : "rounded-full bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
                    )}
                  >
                    <span className={s.countersign ? "-rotate-45" : undefined}>{i + 1}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-neutral-900">{s.name}</span>
                  <span className="shrink-0 text-xs text-[color:var(--ink-2)]">
                    {s.countersign
                      ? `${s.parties.length} 方并行 · ${OVERALL_MODE_LABEL[countersignMode(s)]}`
                      : s.mode === "online"
                        ? `线上 · ${s.online.systemName}`
                        : `线下 · ${s.offline.handlers.map((h) => h.department).filter(Boolean).join("、") || "经办待填"}`}
                  </span>
                  {s.waitFor?.stepId && (
                    <span className="badge badge-indigo shrink-0" style={{ height: 20 }}>等会签</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* 动态时间线 */}
        <section className="glass-card p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            动态
            <span className="badge badge-plain ml-auto" style={{ height: 22 }}>{events.length} 条</span>
          </div>
          {events.length === 0 && (
            <p className="mt-4 text-[13px] text-[color:var(--ink-3)]">暂无动态;分析、指派与修改都会记录在这里</p>
          )}
          <div className="mt-4">
            {events.map((e, i) => {
              const meta = KIND_META[e.kind] ?? { icon: "M12 8v4.5M12 16h.01", color: "var(--ink-2)", label: () => e.kind };
              const d = ((e.detail ?? {}) ?? {}) as Record<string, string>;
              return (
                <div key={e.id} className="flex gap-3">
                  <div className="flex w-[34px] shrink-0 flex-col items-center pt-0.5">
                    <span
                      className="z-[1] grid h-[30px] w-[30px] place-items-center rounded-full bg-white/80 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06),0_2px_6px_-3px_rgba(23,42,80,0.25)]"
                      style={{ color: meta.color }}
                    >
                      <svg className="h-[14px] w-[14px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={meta.icon} />
                      </svg>
                    </span>
                    {i < events.length - 1 && <span className="min-h-[18px] w-0.5 flex-1 bg-gradient-to-b from-[rgba(120,120,128,0.22)] to-[rgba(120,120,128,0.08)]" />}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <b className="text-[13.5px]">{meta.label(e)}</b>
                      <span className="text-[11px] tabular-nums text-[color:var(--ink-3)]">
                        {e.actorName} · {new Date(e.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                      {eventSummary(e, p)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {chart && <FlowChartModal onClose={() => setChart(null)} source={chart} />}
      {editForm && (
        <EditProcessModal
          process={p}
          onClose={() => setEditForm(false)}
          onSaved={() => {
            setEditForm(false);
            void load();
            onChanged();
          }}
        />
      )}
      {editChart && (
        <ChartEditorModal
          process={p}
          onClose={() => setEditChart(false)}
          onSaved={() => {
            setEditChart(false);
            void load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function Chip({ v }: { v: string }) {
  return <span className="lg-chip px-3 py-1.5 text-xs text-[color:var(--ink-2)]">{v}</span>;
}

function eventSummary(e: FollowEvent, p: FlowProcess): string {
  const d = ((e.detail ?? {}) ?? {}) as Record<string, string>;
  switch (e.kind) {
    case "analyzed":
      return String(d.pass) === "true"
        ? `分析通过 · 价值 ${d.value || "—"} / 复杂度 ${d.complexity || "—"} / 优先级 ${d.priority || "—"}${d.conclusion ? ` · ${d.conclusion}` : ""}`
        : `记录结论 · 价值 ${d.value || "—"} / 复杂度 ${d.complexity || "—"}(暂未通过)`;
    case "assigned":
      return `指派给 ${d.assignee ?? "?"},目标 ${d.dueDate ?? "—"}${d.note ? ` · 「${d.note}」` : ""}`;
    case "status":
      return `${FOLLOW_STATUS_LABEL[(d.from as never) ?? "analyzing"] ?? d.from} → ${FOLLOW_STATUS_LABEL[(d.to as never) ?? "analyzing"] ?? d.to}${d.note ? ` · ${d.note}` : ""}`;
    case "stage":
      return `${d.from ?? ""} → ${d.to ?? ""}`;
    case "edited_form":
    case "edited_chart":
      return `共 ${d.steps ?? "?"} 个步骤${d.name && d.name !== p.name ? ` · 名称改为「${d.name}」` : ""}`;
    default:
      return "";
  }
}
