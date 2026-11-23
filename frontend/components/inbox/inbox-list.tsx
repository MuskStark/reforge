"use client";

/** 通知中心:评审、指派、@提及、逾期、评审积压、阶段变动、简报到期。 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  AtSign,
  BellOff,
  CheckCheck,
  ClipboardCheck,
  FileSignature,
  FolderGit2,
  GitBranch,
  HeartPulse,
  MessageSquare,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";
import { authFetch } from "@/lib/auth";
import type { NotificationItem } from "@/lib/types";
import { fmtDateTime } from "@/lib/labels";
import { AppShell, PageHead, StateLine, pokeNotifications } from "@/components/shell/app-shell";
import { cn } from "@/lib/utils";

type Row = NotificationItem & { target: string; Icon: typeof BellOff; tone: string };

/** 通知类型 → 图标、颜色、点开后的落点 */
export function describe(n: NotificationItem): { Icon: typeof BellOff; tone: string; target: string } {
  const base = `/projects/${n.projectId}`;
  const inProject = (tab?: string) => (n.projectId ? (tab ? `${base}?tab=${tab}` : base) : "");
  if (n.itemId) return { Icon: ClipboardCheck, tone: "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]", target: inProject("plan") + `&item=${n.itemId}` };
  if (n.kind.startsWith("review")) return { Icon: FileSignature, tone: "bg-[color:var(--indigo-soft)] text-[color:var(--indigo-deep)]", target: inProject("review") };
  switch (n.kind) {
    case "overdue":
      return { Icon: AlertTriangle, tone: "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]", target: inProject(n.reviewId ? "review" : "plan") };
    case "mentioned":
      return { Icon: AtSign, tone: "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]", target: inProject("activity") };
    case "commented":
      return { Icon: MessageSquare, tone: "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]", target: inProject("activity") };
    case "member_added":
      return { Icon: UserPlus, tone: "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]", target: inProject() };
    case "health":
      return { Icon: HeartPulse, tone: "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]", target: inProject("overview") };
    case "stage_rewound":
    case "stage_skipped":
      return { Icon: GitBranch, tone: "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]", target: inProject("review") };
    case "project_created":
    case "project_status":
    case "update_due":
    default:
      return { Icon: FolderGit2, tone: "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]", target: inProject() };
  }
}

export function InboxList() {
  return <AppShell active="inbox">{() => <InboxBody />}</AppShell>;
}

function InboxBody() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [only, setOnly] = useState<"all" | "unread">("all");

  const load = useCallback(async () => {
    try {
      const d = await authFetch<{ list: NotificationItem[]; unread: number }>("/api/notifications", { cache: "no-store" });
      setRows((d.list ?? []).map((x) => ({ ...x, ...describe(x) })));
      setUnread(d.unread);
    } catch {
      /* 会话失效由外壳处理 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mark = async (body: { id?: string; all?: boolean }) => {
    try {
      await authFetch("/api/notifications/read", { method: "POST", body: JSON.stringify(body) });
      pokeNotifications();
      await load();
    } catch (e) {
      toast.error("操作失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    }
  };

  const shown = useMemo(() => (rows ?? []).filter((r) => only === "all" || !r.readAt), [rows, only]);

  if (!rows) return <StateLine>加载中…</StateLine>;

  return (
    <>
      <PageHead title="通知" subtitle="评审、指派、提及、逾期与阶段变动都会汇到这里。">
        {unread > 0 && (
          <button type="button" onClick={() => void mark({ all: true })} className="btn btn-glass !h-9 !px-3.5 text-[13px]">
            <CheckCheck className="h-3.5 w-3.5" /> 全部已读
          </button>
        )}
      </PageHead>

      <div className="mb-3 flex items-center gap-2">
        <div className="seg seg-mini">
          {(
            [
              ["all", "全部"],
              ["unread", "未读"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" onClick={() => setOnly(v)} className={only === v ? "on" : undefined}>
              {label}
              {v === "unread" && unread > 0 ? <span className="font-data ml-1 text-[11px]">{unread}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <section className="glass-card p-10 text-center">
          <BellOff className="mx-auto h-9 w-9 text-[color:var(--ink-3)]" />
          <h2 className="mt-3 text-[17px] font-semibold">{rows.length === 0 ? "还没有通知" : "没有未读通知"}</h2>
          <p className="mt-2 text-[13px] text-[color:var(--ink-2)]">有人指派任务、提交评审给你或 @你 时，会出现在这里。</p>
        </section>
      ) : (
        <ul className="grid gap-2">
          {shown.map((r) => {
            const isUnread = !r.readAt;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (isUnread) void mark({ id: r.id });
                    if (r.target) router.push(r.target);
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-2xl px-3.5 py-3 text-left transition hover:-translate-y-0.5",
                    isUnread ? "glass-card shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_1px_rgba(0,113,227,0.3),0_28px_64px_-28px_rgba(23,42,80,0.28)]" : "bg-white/35 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.6)]",
                  )}
                >
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full", r.tone)}>
                    <r.Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[14px] leading-snug text-neutral-900", isUnread ? "font-semibold" : "font-medium")}>{r.title}</span>
                    <span className="font-data mt-0.5 block text-[11px] tabular-nums text-[color:var(--ink-3)]">{fmtDateTime(r.createdAt)}</span>
                  </span>
                  {isUnread && <span className="mt-2 size-2 shrink-0 rounded-full bg-[color:var(--tint)]" aria-label="未读" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
