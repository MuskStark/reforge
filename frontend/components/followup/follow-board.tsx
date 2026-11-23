"use client";

/**
 * @deprecated 已被取代(2026-11-24):跟进看板由「流程项目」接管,
 * 见 components/projects/ 与 docs/process-management-architecture.md。
 * 所依赖的旧跟进接口(analyze / assign / status / stage / events)已下线,本组件不再被任何页面挂载,确认后可删除。
 */

/**
 * 跟进看板(设计稿 F1):五列泳道 + 统计 + 我的/全部 + 分析/指派弹窗。
 * 权限:查看=登录;分析/指派=管理员;卡片点击进入详情视图。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { adminFetch } from "@/lib/auth";
import type { FlowProcess, FollowStatus } from "@/lib/types";
import { STAGE_NAMES } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 距截止日天数(负=逾期) */
function dueDays(due?: string): number | null {
  if (!due) return null;
  const d = new Date(due + "T23:59:59");
  const diff = Math.ceil((d.getTime() - Date.now()) / 86_400_000);
  return diff;
}

const COLUMNS: { key: FollowStatus; label: string; dot: string }[] = [
  { key: "analyzing", label: "需求分析", dot: "var(--indigo)" },
  { key: "unassigned", label: "待指派", dot: "var(--ink-3)" },
  { key: "following", label: "跟进中", dot: "var(--tint)" },
  { key: "review", label: "待验收", dot: "var(--amber)" },
  { key: "done", label: "已完成", dot: "var(--green)" },
];

interface UserLite {
  id: string;
  username: string;
  role: string;
}

export function FollowBoard({
  me,
  onOpenDetail,
}: {
  me: { username: string; role: string } | null;
  onOpenDetail: (p: FlowProcess) => void;
}) {
  const [list, setList] = useState<FlowProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeMine, setScopeMine] = useState(false);
  const [analyzeOf, setAnalyzeOf] = useState<FlowProcess | null>(null);
  const [assignOf, setAssignOf] = useState<FlowProcess | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);

  const load = useCallback(async () => {
    try {
      setList(await adminFetch<FlowProcess[]>("/api/admin/processes", { cache: "no-store" }));
    } catch {
      toast.error("读取失败", { description: "无法获取跟进列表" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (me?.role !== "admin") return;
    void adminFetch<UserLite[]>("/api/admin/users", { cache: "no-store" }).then(setUsers).catch(() => {});
  }, [me?.role]);

  const filtered = useMemo(
    () =>
      scopeMine && me
        ? list.filter((p) => p.assigneeName === me.username || p.followStatus === "analyzing" && me.role === "admin")
        : list,
    [list, scopeMine, me],
  );

  const stats = useMemo(() => {
    const c = (s: FollowStatus) => list.filter((p) => (p.followStatus ?? "analyzing") === s).length;
    const overdue = list.filter((p) => {
      const st = p.followStatus;
      if (st !== "following" && st !== "review") return false;
      const d = dueDays(p.dueDate);
      return d != null && d < 0;
    }).length;
    return { analyzing: c("analyzing"), unassigned: c("unassigned"), following: c("following"), review: c("review"), overdue };
  }, [list]);

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="text-[22px] font-bold tracking-[-0.02em]">跟进看板</h2>
        <div className="seg" style={{ width: "auto" }}>
          <button className={scopeMine ? undefined : "on"} onClick={() => setScopeMine(false)}>全部</button>
          <button className={scopeMine ? "on" : undefined} onClick={() => setScopeMine(true)}>我的跟进</button>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <StatChip label="待分析" v={stats.analyzing} color="var(--indigo-deep)" />
          <StatChip label="待指派" v={stats.unassigned} />
          <StatChip label="跟进中" v={stats.following} color="var(--tint-deep)" />
          <StatChip label="待验收" v={stats.review} color="var(--amber-deep)" />
          <StatChip label="逾期" v={stats.overdue} color="var(--red-deep)" />
        </div>
      </div>

      {!loading && list.length === 0 && (
        <p className="glass-card px-5 py-10 text-center text-sm text-[color:var(--ink-3)]">暂无已收集流程</p>
      )}

      <div className="board-lanes">
        <div className="lane-grid">
          {COLUMNS.map((col) => {
            const cards = filtered.filter((p) => (p.followStatus ?? "analyzing") === col.key);
            return (
              <div key={col.key} className="glass-card p-3">
                <div className="flex items-center gap-2 px-1 pb-2.5 text-[13px] font-semibold text-[color:var(--ink-2)]">
                  <span className="h-2 w-2 rounded-full" style={{ background: col.dot }} />
                  {col.label}
                  <span className="ml-auto rounded-full bg-[rgba(120,120,128,0.16)] px-2 py-0.5 text-[11px] font-semibold text-[#48484d]">
                    {cards.length}
                  </span>
                </div>
                {cards.map((p) => (
                  <BoardCard
                    key={p.id}
                    p={p}
                    me={me}
                    onOpen={() => onOpenDetail(p)}
                    onAnalyze={me?.role === "admin" ? () => setAnalyzeOf(p) : undefined}
                    onAssign={me?.role === "admin" ? () => setAssignOf(p) : undefined}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {analyzeOf && (
        <AnalyzeModal
          p={analyzeOf}
          onClose={() => setAnalyzeOf(null)}
          onDone={() => {
            setAnalyzeOf(null);
            void load();
          }}
        />
      )}
      {assignOf && (
        <AssignModal
          p={assignOf}
          users={users.filter((u) => u.role === "member" || u.role === "admin")}
          onClose={() => setAssignOf(null)}
          onDone={() => {
            setAssignOf(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function StatChip({ label, v, color }: { label: string; v: number; color?: string }) {
  return (
    <span className="lg-chip inline-flex items-baseline gap-1.5 px-3 py-1.5 text-[13px] text-[color:var(--ink-2)]">
      {label} <b className="text-[15px] font-semibold" style={{ color: color ?? "var(--ink)" }}>{v}</b>
    </span>
  );
}

function BoardCard({
  p,
  me,
  onOpen,
  onAnalyze,
  onAssign,
}: {
  p: FlowProcess;
  me: { username: string; role: string } | null;
  onOpen: () => void;
  onAnalyze?: () => void;
  onAssign?: () => void;
}) {
  const st = p.followStatus ?? "analyzing";
  const dd = dueDays(p.dueDate);
  const countersignN = p.steps.filter((s) => s.countersign).length;
  const stage = p.stage ?? 0;
  const inFollowing = st === "following" || st === "review";
  // 泳道内的待办动作(管理员):独占卡片底部整行,不与人员/状态同行
  const action =
    st === "analyzing" && onAnalyze
      ? { label: "需求分析", style: "btn-glass", run: onAnalyze }
      : st === "unassigned" && onAssign
        ? { label: "指派", style: "btn-primary", run: onAssign }
        : null;

  return (
    <article
      className="glass-card mb-2.5 cursor-pointer rounded-[20px] p-3.5 transition hover:brightness-[1.02]"
      onClick={onOpen}
    >
      <p className="break-words text-[15px] font-semibold leading-snug text-neutral-900">{p.name}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <span className="badge badge-plain" style={{ height: 20 }}>{p.steps.length} 步</span>
        {countersignN > 0 && (
          <span className="badge badge-amber" style={{ height: 20 }}><span className="dot" />会签 {countersignN}</span>
        )}
        {p.analysis && st !== "analyzing" && (
          <span className="badge badge-indigo" style={{ height: 20 }}>{p.analysis.priority === "高" ? "高优" : p.analysis.priority} · 已分析</span>
        )}
      </div>

      {inFollowing && (
        <div className="mt-2.5">
          <div className="flex gap-1">
            {STAGE_NAMES.slice(1).map((_, i) => (
              <i
                key={i}
                className={cn("h-[5px] flex-1 rounded-full", i < stage ? "bg-gradient-to-r from-[#2b95ff] to-[#0071e3]" : "bg-[rgba(120,120,128,0.16)]")}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-medium text-[color:var(--ink-3)]">
            <b className="text-[color:var(--tint-deep)]">{STAGE_NAMES[Math.min(stage, 5)]}</b>
            <span>{stage}/5{st === "review" ? " · 已提交验收" : ""}</span>
          </div>
        </div>
      )}

      {/* 按钮本身已说明状态(待分析 / 待指派),有按钮时不再重复占位头像与状态文案 */}
      {!action && (
        <div className="mt-2.5 flex min-w-0 items-center gap-2">
          {p.assigneeName ? (
            <span
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-[11px] font-semibold"
              style={{ background: "linear-gradient(180deg,#b8ccff,#9db4ff)", color: "#21407a" }}
            >
              {p.assigneeName.slice(0, 1)}
            </span>
          ) : (
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-[rgba(120,120,128,0.14)] text-[12px] text-[color:var(--ink-2)]">?</span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-[color:var(--ink-2)]" title={p.assigneeName || undefined}>
            {st === "analyzing" ? (me?.role === "admin" ? "待分析" : "需求分析中") : p.assigneeName ?? "未指派"}
          </span>
          {st === "done" ? (
            <span className="badge badge-ok shrink-0" style={{ height: 22 }}>已完成</span>
          ) : dd != null && dd < 0 ? (
            <span className="badge badge-warn shrink-0" style={{ height: 22 }}>逾期 {-dd} 天</span>
          ) : dd != null ? (
            <span
              className="badge shrink-0"
              style={{ height: 22, background: dd <= 3 ? "var(--amber-soft)" : undefined, color: dd <= 3 ? "var(--amber-deep)" : undefined }}
            >
              {dd} 天
            </span>
          ) : null}
        </div>
      )}

      {action && (
        <button
          type="button"
          className={cn("btn mt-2.5 !h-8 w-full text-[13px]", action.style)}
          onClick={(e) => { e.stopPropagation(); action.run(); }}
        >
          {action.label}
        </button>
      )}
    </article>
  );
}

/** 需求分析弹窗(必经门) */
function AnalyzeModal({ p, onClose, onDone }: { p: FlowProcess; onClose: () => void; onDone: () => void }) {
  const [conclusion, setConclusion] = useState("");
  const [value, setValue] = useState("中");
  const [complexity, setComplexity] = useState("中");
  const [priority, setPriority] = useState("中");
  const [busy, setBusy] = useState(false);

  const submit = async (pass: boolean) => {
    setBusy(true);
    try {
      await adminFetch(`/api/admin/processes/${p.id}/analyze`, {
        method: "POST",
        body: JSON.stringify({ conclusion, value, complexity, priority, pass }),
      });
      toast.success(pass ? "分析通过" : "已记录分析结论", { description: p.name });
      onDone();
    } catch (e) {
      toast.error("保存失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[rgba(18,26,48,0.32)] p-6 backdrop-blur-md">
      <div
        className="w-full max-w-[480px] rounded-[30px] p-6"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.68))",
          backdropFilter: "blur(36px) saturate(180%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.98), 0 40px 90px -30px rgba(12,22,48,0.45)",
        }}
      >
        <h3 className="text-[19px] font-bold tracking-[-0.02em]">需求分析</h3>
        <p className="mt-1 text-[13px] text-[color:var(--ink-2)]">{p.name} · 通过后方可指派跟进</p>

        <div className="mt-4 space-y-3">
          <div>
            <div className="field-label">分析结论 <span className="font-normal text-[color:var(--ink-3)]">选填</span></div>
            <textarea className="field" rows={3} value={conclusion} onChange={(e) => setConclusion(e.target.value)} placeholder="改造价值、复杂度判断、实施建议…" />
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            {([
              ["改造价值", value, setValue],
              ["复杂度", complexity, setComplexity],
              ["优先级", priority, setPriority],
            ] as const).map(([label, v, set]) => (
              <div key={label}>
                <div className="field-label">{label}</div>
                <div className="seg">
                  {["高", "中", "低"].map((o) => (
                    <button key={o} type="button" className={v === o ? "on" : undefined} onClick={() => set(o)}>{o}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 flex gap-2.5">
          <button className="btn btn-glass flex-1" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn btn-glass flex-1" disabled={busy} onClick={() => void submit(false)}>仅记录,暂不通过</button>
          <button className="btn btn-primary flex-[1.4]" disabled={busy} onClick={() => void submit(true)}>分析通过 → 待指派</button>
        </div>
      </div>
    </div>
  );
}

/** 指派弹窗 */
function AssignModal({ p, users, onClose, onDone }: { p: FlowProcess; users: UserLite[]; onClose: () => void; onDone: () => void }) {
  const [uid, setUid] = useState("");
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!uid || !due) {
      toast.error("请选择跟进人并设置目标完成日");
      return;
    }
    setBusy(true);
    try {
      await adminFetch(`/api/admin/processes/${p.id}/assign`, {
        method: "POST",
        body: JSON.stringify({ assigneeId: uid, dueDate: due, note }),
      });
      toast.success("已指派", { description: `${p.name} → ${users.find((u) => u.id === uid)?.username}` });
      onDone();
    } catch (e) {
      toast.error("指派失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[rgba(18,26,48,0.32)] p-6 backdrop-blur-md">
      <div
        className="w-full max-w-[480px] rounded-[30px] p-6"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.68))",
          backdropFilter: "blur(36px) saturate(180%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.98), 0 40px 90px -30px rgba(12,22,48,0.45)",
        }}
      >
        <h3 className="text-[19px] font-bold tracking-[-0.02em]">指派跟进人</h3>
        <p className="mt-1 text-[13px] text-[color:var(--ink-2)]">{p.name} · 指派后该成员获得编辑权限(表单与流程图)</p>

        <div className="mt-4">
          <div className="field-label">跟进人 <span className="text-[color:var(--red)]">*</span></div>
          <div className="mt-1.5 grid gap-1">
            {users.length === 0 && (
              <p className="rounded-xl border border-dashed border-black/10 bg-white/40 px-3 py-2.5 text-xs text-[color:var(--ink-3)]">
                暂无可指派用户,请先在「用户管理」创建账号
              </p>
            )}
            {users.map((u) => (
              <label
                key={u.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-[14px] px-3 py-2 transition",
                  uid === u.id
                    ? "bg-white/90 shadow-[inset_0_0_0_1.5px_var(--tint),0_3px_10px_-5px_rgba(0,113,227,0.4)]"
                    : "hover:bg-white/60",
                )}
              >
                <input type="radio" className="sr-only" checked={uid === u.id} onChange={() => setUid(u.id)} />
                <span
                  className="grid h-8 w-8 place-items-center rounded-full text-[12px] font-semibold"
                  style={{ background: "linear-gradient(180deg,#b8ccff,#9db4ff)", color: "#21407a" }}
                >
                  {u.username.slice(0, 1)}
                </span>
                <span className="flex-1">
                  <b className="block text-[14px]">{u.username}</b>
                  <span className="text-[11px] text-[color:var(--ink-3)]">{u.role === "admin" ? "管理员" : "成员"}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="field-label">目标完成日 <span className="text-[color:var(--red)]">*</span></div>
          <input type="date" className="field" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="mt-3">
          <div className="field-label">指派备注 <span className="font-normal text-[color:var(--ink-3)]">选填,写入时间线</span></div>
          <textarea className="field" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="改造要点、配合事项…" />
        </div>

        <div className="mt-5 flex gap-2.5">
          <button className="btn btn-glass flex-1" onClick={onClose}>取消</button>
          <button className="btn btn-primary flex-2" disabled={busy} onClick={() => void submit()}>指派并开始跟进</button>
        </div>
      </div>
    </div>
  );
}
