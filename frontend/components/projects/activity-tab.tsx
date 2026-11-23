"use client";

/**
 * 动态:不可变事件流(谁在什么时候做了什么)+ 项目级评论与简报。
 * 工作项上的评论在「计划」里打开该工作项查看。
 */

import { useEffect, useMemo, useState } from "react";
import { AtSign, Megaphone, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth";
import type { ProjectComment, ProjectEvent } from "@/lib/types";
import { HEALTH_LABEL, ITEM_STATUS_LABEL, ITEM_TYPE_LABEL, STATUS_LABEL, fmtDateTime } from "@/lib/labels";
import { Avatar } from "@/components/projects/stage-rail";
import type { DetailCtx } from "@/components/projects/project-detail";
import { cn } from "@/lib/utils";

type Row =
  | { kind: "event"; id: string; at: string; e: ProjectEvent }
  | { kind: "comment"; id: string; at: string; c: ProjectComment }
  | { kind: "update"; id: string; at: string; c: ProjectComment };

const s = (v: unknown): string => (v == null ? "" : String(v));
const statusName = (code: string): string => (ITEM_STATUS_LABEL as Record<string, string>)[code] ?? code;
/** 历史事件里的"状态→done"之类内部写法翻成中文 */
const humanizeChange = (c: string): string => (c.includes("→") ? c.split("→").map(statusName).join(" → ") : c);
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

/** 把一条事件翻译成一句话 */
export function eventLine(e: ProjectEvent): { title: string; body?: string; tone?: "ok" | "warn" | "info" | "amber" } {
  const d = e.detail ?? {};
  switch (e.kind) {
    case "project_created":
      return { title: d.migrated === true ? "由存量跟进数据迁入，建立流程项目" : "流程提交，自动立项", tone: "info" };
    case "project_updated":
      return { title: `更新了${(Array.isArray(d.fields) ? d.fields.map(String).join("、") : "")}`, body: s(d.note) };
    case "project_status":
      return { title: `项目状态：${STATUS_LABEL[s(d.from) as keyof typeof STATUS_LABEL] ?? s(d.from)} → ${STATUS_LABEL[s(d.to) as keyof typeof STATUS_LABEL] ?? s(d.to)}`, body: s(d.note), tone: d.to === "done" ? "ok" : d.to === "cancelled" ? "warn" : undefined };
    case "member_added":
      return { title: `${s(d.user)} 加入项目，担任${s(d.role)}`, tone: "ok" };
    case "member_removed":
      return { title: `${s(d.user)} 不再担任${s(d.role)}`, tone: "warn" };
    case "review_submitted":
      return {
        title: `提交 ${s(d.gate)}（第 ${n(d.round)} 轮）`,
        body: [s(d.summary), Array.isArray(d.reviewers) && d.reviewers.length ? `评审人：${d.reviewers.map(String).join("、")}` : ""].filter(Boolean).join("\n"),
        tone: "info",
      };
    case "review_voted":
      return { title: `${d.decision === "approve" ? "表决通过" : "表决驳回"} ${s(d.gate)}`, body: s(d.comment), tone: d.decision === "approve" ? "ok" : "warn" };
    case "review_approved":
      return { title: `${s(d.gate)} 通过`, body: s(d.stageName) ? `「${s(d.stageName)}」完成` : undefined, tone: "ok" };
    case "review_rejected":
      return { title: `${s(d.gate)} 被驳回，退回修改`, tone: "warn" };
    case "review_withdrawn":
      return { title: `撤回 ${s(d.gate)} 第 ${n(d.round)} 轮评审` };
    case "review_admin_decided":
      return { title: `管理员裁决：${d.decision === "approve" ? "通过" : "驳回"}`, body: s(d.comment), tone: "amber" };
    case "stage_rewound":
      return { title: `退回到「${s(d.to)}」（原在「${s(d.from)}」）`, body: s(d.reason), tone: "warn" };
    case "stage_skipped":
      return { title: `跳过「${s(d.stage)}」`, body: s(d.reason), tone: "amber" };
    case "item_created":
      return { title: `新建${ITEM_TYPE_LABEL[s(d.type) as keyof typeof ITEM_TYPE_LABEL] ?? "工作项"}「${s(d.title)}」`, body: s(d.stage) ? `归属：${s(d.stage)}` : undefined };
    case "item_updated":
      return { title: `更新「${s(d.title)}」`, body: Array.isArray(d.changes) ? d.changes.map((c) => humanizeChange(String(c))).join("、") : undefined };
    case "item_status":
      return {
        title: `「${s(d.title)}」${statusName(s(d.from))} → ${statusName(s(d.to))}`,
        body: s(d.reason) ? `原因：${s(d.reason)}` : undefined,
        tone: d.to === "done" ? "ok" : d.to === "blocked" ? "warn" : undefined,
      };
    case "item_split":
      return { title: `把「${s(d.title)}」按成员拆成 ${n(d.count)} 条` };
    case "item_deleted":
      return { title: `删除工作项「${s(d.title)}」`, tone: "warn" };
    case "comment_added":
      return { title: "发表评论", body: s(d.excerpt) };
    case "project_update":
      return { title: "发布简报", body: s(d.excerpt), tone: d.health === "on_track" ? "ok" : "amber" };
    case "edited_form":
    case "edited_chart":
    case "legacy_edited_form":
    case "legacy_edited_chart":
      return { title: e.kind.includes("chart") ? "在流程图上修改了流程定义" : "编辑了流程表单", body: s(d.name) ? `「${s(d.name)}」· 共 ${n(d.steps)} 个步骤` : undefined };
    // 迁入的旧跟进时间线
    case "legacy_analyzed":
      return { title: String(d.pass) === "true" ? "需求分析通过" : "记录需求分析结论", tone: String(d.pass) === "true" ? "ok" : undefined };
    case "legacy_assigned":
      return { title: `指派 ${s(d.assignee)} 跟进`, tone: "info" };
    case "legacy_status":
      return { title: `状态变更：${STATUS_LABEL[s(d.from) as keyof typeof STATUS_LABEL] ?? s(d.from)} → ${STATUS_LABEL[s(d.to) as keyof typeof STATUS_LABEL] ?? s(d.to)}`, body: s(d.note) };
    case "legacy_stage":
      return { title: `推进阶段：${s(d.from)} → ${s(d.to)}`, tone: "ok" };
    default:
      return { title: e.kind.replace(/^legacy_/, ""), body: Object.keys(d).length ? JSON.stringify(d) : undefined };
  }
}

const TONE_DOT = {
  ok: "bg-[color:var(--green)]",
  warn: "bg-[color:var(--red)]",
  info: "bg-[color:var(--indigo)]",
  amber: "bg-[color:var(--amber)]",
  plain: "bg-[rgba(120,120,128,0.4)]",
};

export function ActivityTab({ ctx }: { ctx: DetailCtx }) {
  const { project, users, comments } = ctx;
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authFetch<ProjectEvent[]>(`/api/projects/${project.id}/events`, { cache: "no-store" })
      .then(setEvents)
      .catch(() => {});
  }, [project.id, project.version]);

  const rows = useMemo<Row[]>(() => {
    const cs: Row[] = comments
      .filter((c) => !c.itemId)
      .map((c) => ({ kind: c.kind === "update" ? "update" : "comment", id: `c${c.id}`, at: c.createdAt, c }));
    const es: Row[] = events.map((e) => ({ kind: "event", id: `e${e.id}`, at: e.createdAt, e }));
    return [...cs, ...es].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [comments, events]);

  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await authFetch(`/api/projects/${project.id}/comments`, { method: "POST", body: JSON.stringify({ body: text.trim() }) });
      setText("");
      await ctx.refresh();
    } catch (e) {
      toast.error("发送失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  // @提及:选一个人,把「@显示名 」插到光标处
  const mention = (name: string) => {
    if (!name) return;
    setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${name} `);
    (document.getElementById("project-comment") as HTMLTextAreaElement | null)?.focus();
  };

  const latestUpdate = comments.find((c) => c.kind === "update");
  const updates = comments.filter((c) => c.kind === "update");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="glass-card p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-neutral-900">
          动态
          <span className="badge badge-plain ml-auto !h-[20px] font-data text-[11px]">{rows.length}</span>
        </h2>

        {project.can.comment && project.status !== "cancelled" && (
          <div className="mt-3 rounded-2xl bg-white/60 p-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
            <textarea
              id="project-comment"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="写下进展说明、会议结论或补充信息…"
              aria-label="写评论"
              className="field !h-auto min-h-[76px] w-full !bg-transparent !text-[13px] !shadow-none focus:!shadow-none"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select value="" onChange={(e) => mention(e.target.value)} aria-label="提及某人" className="field !h-8 w-auto !px-2.5 !text-[12px]">
                <option value="">@提及</option>
                {users.map((u) => (
                  <option key={u.id} value={u.displayName}>
                    @{u.displayName}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-[color:var(--ink-3)]">被提及的人会收到通知</span>
              <button type="button" disabled={busy || !text.trim()} onClick={() => void post()} className="btn btn-primary ml-auto !h-9 !px-4 text-[13px] disabled:opacity-50">
                发送
              </button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="mt-4 text-[13px] text-[color:var(--ink-3)]">暂无动态。指派、提交评审、表决、修改计划都会记录在这里。</p>
        ) : (
          <ol className="mt-4">
            {rows.map((r, i) => {
              const last = i === rows.length - 1;
              if (r.kind === "event") {
                const line = eventLine(r.e);
                return (
                  <li key={r.id} className="flex gap-3">
                    <div className="flex w-[30px] shrink-0 flex-col items-center pt-1">
                      <span className={cn("z-[1] size-[9px] rounded-full ring-4 ring-white/80", TONE_DOT[line.tone ?? "plain"])} />
                      {!last && <span className="min-h-[18px] w-0.5 flex-1 bg-gradient-to-b from-[rgba(120,120,128,0.22)] to-[rgba(120,120,128,0.08)]" />}
                    </div>
                    <div className="min-w-0 flex-1 pb-4">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <b className="text-[13.5px] font-semibold text-neutral-900">{line.title}</b>
                        <span className="text-[11px] tabular-nums text-[color:var(--ink-3)]">
                          {r.e.actorName || "系统"} · {fmtDateTime(r.at)}
                        </span>
                      </div>
                      {line.body && <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{line.body}</p>}
                    </div>
                  </li>
                );
              }
              const c = r.c;
              const isUpdate = r.kind === "update";
              return (
                <li key={r.id} className="flex gap-3">
                  <div className="flex w-[30px] shrink-0 flex-col items-center pt-0.5">
                    <Avatar name={c.authorDisplayName} size={28} />
                    {!last && <span className="min-h-[18px] w-0.5 flex-1 bg-gradient-to-b from-[rgba(120,120,128,0.22)] to-[rgba(120,120,128,0.08)]" />}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className={cn("rounded-2xl bg-white/60 px-3.5 py-2.5", isUpdate && "bg-[linear-gradient(180deg,rgba(240,240,255,0.5),rgba(255,255,255,0.5))] shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.22)]")}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {isUpdate ? <Megaphone className="h-3.5 w-3.5 text-[color:var(--indigo-deep)]" /> : <MessageSquare className="h-3.5 w-3.5 text-[color:var(--ink-3)]" />}
                        <b className="text-[13px] font-semibold text-neutral-900">{c.authorDisplayName}</b>
                        <span className="text-[11px] tabular-nums text-[color:var(--ink-3)]">
                          {isUpdate ? "发布简报" : "评论"} · {fmtDateTime(r.at)}
                        </span>
                        {isUpdate && (
                          <span className="badge badge-indigo !h-[18px] !px-2 text-[10px]">健康度见简报</span>
                        )}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-900">{c.body}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <aside className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <section className="glass-card p-5">
          <h2 className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-neutral-900">
            <AtSign className="h-4 w-4 text-[color:var(--tint)]" /> 项目成员
          </h2>
          <ul className="mt-3 grid gap-1">
            {users
              .filter((u) => project.members.some((m) => m.userId === u.id) || u.jobRole === "cto")
              .sort((a, b) => Number(b.jobRole === "cto") - Number(a.jobRole === "cto"))
              .map((u) => {
                const role = u.jobRole === "cto" ? "CTO" : project.members.filter((m) => m.userId === u.id).map((m) => (m.role === "pm" ? "项目经理" : m.role === "handler" ? "经办" : m.role === "dev" ? "开发实施" : "观察者")).join(" / ");
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      disabled={!project.can.comment}
                      onClick={() => mention(u.displayName)}
                      title={project.can.comment ? `在评论里提及 ${u.displayName}` : undefined}
                      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition enabled:hover:bg-white/60 disabled:cursor-default"
                    >
                      <Avatar name={u.displayName} size={26} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-900">{u.displayName}</span>
                      <span className="shrink-0 text-[11px] text-[color:var(--ink-3)]">{role}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>

        {latestUpdate && (
          <section className="glass-card p-5">
            <h2 className="text-[15px] font-semibold text-neutral-900">简报</h2>
            <p className="mt-1 text-xs text-[color:var(--ink-2)]">
              共 {updates.length} 期 · 当前健康度 <b>{HEALTH_LABEL[project.health]}</b>
            </p>
            <dl className="mt-3 space-y-2.5 text-[13px]">
              {(
                [
                  ["progress", "本期进展"],
                  ["next", "下期计划"],
                  ["risks", "风险与阻塞"],
                  ["help", "需要的支持"],
                ] as const
              ).map(([k, label]) =>
                latestUpdate.structured?.[k] ? (
                  <div key={k}>
                    <dt className="text-xs text-[color:var(--ink-2)]">{label}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap leading-relaxed text-neutral-900">{latestUpdate.structured[k]}</dd>
                  </div>
                ) : null,
              )}
            </dl>
            {project.can.manage && project.status === "active" && (
              <button type="button" onClick={() => ctx.setUpdateOpen(true)} className="btn btn-glass mt-3 !h-9 w-full !px-3 text-[13px]">
                写新一期简报
              </button>
            )}
          </section>
        )}

        <section className="glass-card p-5 text-xs leading-relaxed text-[color:var(--ink-2)]">
          <b className="text-[13px] text-neutral-900">这里记录什么</b>
          <p className="mt-1.5">所有关键动作都会自动留痕：成员变动、提交与表决、阶段回退或跳过、工作项变更、流程定义修改、简报。记录只追加、不可改，用作审计与交接依据。</p>
        </section>
      </aside>
    </div>
  );
}
