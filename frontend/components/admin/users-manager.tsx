"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Pencil, Plus, ShieldCheck, User, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { DataTable, type DataColumn, type DataRow } from "@/components/ui/data-table";
import { SearchBox } from "@/components/ui/search-box";
import { PageHead, StateLine } from "@/components/shell/app-shell";
import { authFetch, getUser } from "@/lib/auth";
import { JOB_ROLE_FULL, JOB_ROLE_LABEL, JOB_ROLE_OPTIONS } from "@/lib/labels";
import { ADMIN_SECTION_META } from "@/lib/shell-nav";
import type { JobRole } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RegisteredUser {
  id: string;
  username: string;
  role: "admin" | "member";
  displayName: string;
  department: string;
  jobRole: JobRole;
  /** 管理员设定的初始密码还没换:用户首次登录后必须先改密码 */
  mustChangePassword: boolean;
  createdAt: string;
}

const COLUMNS: DataColumn[] = [
  { key: "member", header: "成员", wide: true },
  { key: "job", header: "岗位" },
  { key: "role", header: "系统角色" },
  { key: "status", header: "状态" },
  { key: "created", header: "创建时间" },
  { key: "actions", header: "操作" },
];
const ACTIONS = 5;

const emptyDraft = () => ({ username: "", password: "", role: "member" as "member" | "admin", displayName: "", department: "", jobRole: "handler" as JobRole });

/** 岗位徽章:CTO 紫红、PM 蓝、BH 绿、TH 琥珀、PMO 灰 */
function jobBadge(job: JobRole): string {
  return cn(
    "badge !h-[22px] text-[11px]",
    job === "cto" && "badge-warn",
    job === "pm" && "badge-blue",
    job === "handler" && "badge-green",
    job === "dev" && "badge-amber",
    job === "viewer" && "badge-plain",
  );
}

/**
 * 后台 · 用户与岗位:管理员创建账号并设置显示名 / 部门 / 岗位。
 * 岗位决定这个人在流程项目里能做什么:CTO 评审,PM 推进,BH 确认与试运行。名称一律用英文缩写。
 * 创建账号走页头按钮弹出的表单,列表页只管看和找。
 */
export function UsersManager() {
  const [users, setUsers] = useState<RegisteredUser[] | null>(null);
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<RegisteredUser | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", department: "", jobRole: "handler" as JobRole });
  const [busy, setBusy] = useState(false);
  // 当前登录的人:列表里标出来,而且不能删自己
  const self = useMemo(() => (typeof window === "undefined" ? null : getUser()), []);
  // 新建表单的 id:底部的提交按钮在表单外面,靠它关联
  const newFormId = useId();

  const load = useCallback(async () => {
    try {
      setUsers(await authFetch<RegisteredUser[]>("/api/admin/users", { cache: "no-store" }));
    } catch {
      // 会话失效由外壳处理
      setUsers((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (e: unknown, title: string) => {
    if (e instanceof Error && e.message === "UNAUTHORIZED") return;
    toast.error(title, { description: e instanceof Error ? e.message : "请重试" });
  };

  const add = async () => {
    if (!draft.username.trim() || !draft.password) {
      toast.error("请填写用户名和密码");
      return;
    }
    if (!draft.displayName.trim()) {
      toast.error("请填写显示名", { description: "指派任务、@提及和通知里显示的都是它" });
      return;
    }
    setBusy(true);
    try {
      const u = await authFetch<RegisteredUser>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: draft.username.trim(),
          password: draft.password,
          role: draft.role,
          displayName: draft.displayName.trim(),
          department: draft.department.trim(),
          jobRole: draft.jobRole,
        }),
      });
      setUsers((prev) => [...(prev ?? []), u]);
      toast.success("已创建", { description: `「${u.displayName}」· ${JOB_ROLE_LABEL[u.jobRole]}，首次登录后须先修改密码` });
      setDraft(emptyDraft());
      setCreating(false);
    } catch (e) {
      fail(e, "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (u: RegisteredUser) => {
    setEditing(u);
    setEditForm({ displayName: u.displayName, department: u.department, jobRole: u.jobRole });
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.displayName.trim()) {
      toast.error("显示名不能为空");
      return;
    }
    setBusy(true);
    try {
      const u = await authFetch<RegisteredUser>(`/api/admin/users/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editForm.displayName.trim(),
          department: editForm.department.trim(),
          jobRole: editForm.jobRole,
        }),
      });
      setUsers((prev) => (prev ?? []).map((x) => (x.id === u.id ? u : x)));
      toast.success("已保存", { description: `「${u.displayName}」· ${JOB_ROLE_LABEL[u.jobRole]}` });
      setEditing(null);
    } catch (e) {
      fail(e, "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: RegisteredUser) => {
    try {
      await authFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      setUsers((prev) => (prev ?? []).filter((x) => x.id !== u.id));
      toast.success("已删除", { description: `「${u.username}」账号已移除` });
    } catch (e) {
      fail(e, "删除失败");
    }
  };

  const filtering = Boolean(query.trim() || job);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter(
      (u) =>
        (!q || u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || u.department.toLowerCase().includes(q)) &&
        (!job || u.jobRole === job),
    );
  }, [users, query, job]);

  const rows: DataRow[] = filtered.map((u) => {
    const isSelf = Boolean(self) && self?.username === u.username;
    return {
      key: u.id || u.username,
      cells: [
        <span key="member" className="cell-person">
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
              u.role === "admin" ? "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]" : "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]",
            )}
            aria-hidden="true"
          >
            {(u.displayName || u.username).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="cell-with-badge">
              <span className="cell-main">{u.displayName || u.username}</span>
              {isSelf && <span className="badge badge-blue !h-[19px] !px-1.5 text-[10px]">当前登录</span>}
            </span>
            <span className="cell-sub font-data">
              @{u.username}
              {u.department && ` · ${u.department}`}
            </span>
          </span>
        </span>,
        u.jobRole ? (
          <span key="job" className={jobBadge(u.jobRole)} title={JOB_ROLE_FULL[u.jobRole]}>
            {JOB_ROLE_LABEL[u.jobRole]}
          </span>
        ) : (
          <span key="job" className="text-[color:var(--ink-3)]">
            未设置
          </span>
        ),
        u.role === "admin" ? (
          <span key="role" className="cell-with-icon is-admin">
            <ShieldCheck aria-hidden="true" /> 管理员
          </span>
        ) : (
          <span key="role" className="text-[color:var(--ink-2)]">
            普通账号
          </span>
        ),
        u.mustChangePassword ? (
          <span key="status" className="badge badge-amber !h-[20px] !px-2 text-[11px]" title="还没完成首次登录改密">
            待首次登录改密
          </span>
        ) : (
          <span key="status" className="text-[color:var(--ink-2)]">
            正常
          </span>
        ),
        <span key="created" className="cell-num">
          {new Date(u.createdAt).toLocaleDateString("zh-CN")}
        </span>,
        <span key="actions" className="row-actions">
          <button type="button" onClick={() => openEdit(u)} aria-label={`编辑 ${u.displayName || u.username}`} title="编辑显示名 / 部门 / 岗位" className="icon-btn">
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void remove(u)}
            disabled={isSelf}
            aria-label={`删除 ${u.username}`}
            className="icon-btn icon-danger disabled:opacity-30"
            title={isSelf ? "不能删除当前登录账号" : "删除该用户"}
          >
            <X className="h-4 w-4" />
          </button>
        </span>,
      ],
    };
  });

  return (
    <section>
      <PageHead title={ADMIN_SECTION_META.users.title} subtitle={ADMIN_SECTION_META.users.lede}>
        <button
          type="button"
          onClick={() => {
            setDraft(emptyDraft());
            setCreating(true);
          }}
          className="btn btn-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> 创建账号
        </button>
      </PageHead>

      {users === null ? (
        <StateLine>加载中…</StateLine>
      ) : users.length === 0 ? (
        <section className="glass-card px-5 py-14 text-center">
          <p className="text-[15px] font-semibold text-neutral-900">还没有注册用户</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--ink-2)]">当前用的是环境变量引导的账号。点右上角的「创建账号」给同事开号。</p>
        </section>
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            <SearchBox value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索姓名、账号或部门" />
            <select value={job} onChange={(e) => setJob(e.target.value)} aria-label="按岗位筛选" className="field toolbar-field !w-[150px] !px-3.5">
              <option value="">全部岗位</option>
              {JOB_ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="ml-auto text-[13px] text-[color:var(--ink-2)]">{filtering ? `找到 ${filtered.length} 人，共 ${users.length} 人` : `共 ${users.length} 人`}</span>
          </div>

          <div className="glass-card !rounded-[22px] p-1.5 sm:p-2">
            <DataTable columns={COLUMNS} rows={rows} label="用户" actionsIndex={ACTIONS} />
            {filtered.length === 0 && <p className="px-5 py-10 text-center text-sm text-[color:var(--ink-3)]">没有符合条件的用户</p>}
          </div>
        </>
      )}

      {creating && (
        <Dialog onClose={() => setCreating(false)} labelledBy="user-new-title">
          <DialogHeader id="user-new-title" title="创建账号" subtitle="公开注册已关闭，账号只能由管理员创建。" onClose={() => setCreating(false)} />
          <form
            id={newFormId}
            className="mt-5"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="用户名" required>
                <Input value={draft.username} placeholder="2-32 个字符，用于登录" autoComplete="off" autoFocus onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
              </Field>
              <Field label="显示名" required>
                <Input value={draft.displayName} placeholder="如：张三" autoComplete="off" maxLength={32} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
              </Field>
              <Field label="初始密码" required hint="至少 6 位">
                <Input type="password" value={draft.password} autoComplete="new-password" onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
              </Field>
              <Field label="部门">
                <Input value={draft.department} placeholder="如：信息中心" autoComplete="off" maxLength={64} onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
              </Field>
              <Field label="岗位" hint="决定这个人能在项目里做什么">
                <select className="field" value={draft.jobRole} onChange={(e) => setDraft({ ...draft, jobRole: e.target.value as JobRole })}>
                  {JOB_ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="space-y-1.5">
                <span className="block text-[13px] font-medium text-neutral-800">系统角色</span>
                <div className="seg !h-11">
                  {(
                    [
                      ["member", "普通账号"],
                      ["admin", "系统管理员"],
                    ] as const
                  ).map(([v, label]) => (
                    <button key={v} type="button" onClick={() => setDraft({ ...draft, role: v })} className={draft.role === v ? "on" : undefined} aria-pressed={draft.role === v}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[color:var(--ink-3)]">管理员可以进入系统管理。</p>
              </div>
            </div>
            <div className="mt-4 rounded-2xl bg-[color:var(--tint-soft)] px-3.5 py-2.5 text-xs leading-relaxed text-[color:var(--tint-deep)] shadow-[inset_0_0_0_0.5px_rgba(0,113,227,0.16)]">
              初始密码只在第一次登录前有效：用户首次登录后必须改成自己的密码，在那之前不能使用系统。
              <br />
              岗位说明：CTO 评审立项、方案、上线与验收（全局生效），分配项目里的 TH；PM（项目经理）负责推进，分配 BH；BH（业务经办）确认需求、执行试运行；TH（科技经办）承接改造任务；PMO（项目管理办公室）查看全部项目与数据大屏。
            </div>
          </form>
          <DialogActions>
            <button type="button" onClick={() => setCreating(false)} className="btn btn-glass">
              取消
            </button>
            <button type="submit" form={newFormId} disabled={busy} className="btn btn-primary disabled:opacity-60">
              创建账号
            </button>
          </DialogActions>
        </Dialog>
      )}

      {editing && (
        <Dialog onClose={() => setEditing(null)} labelledBy="edit-user-title">
          <DialogHeader id="edit-user-title" title={`编辑「${editing.displayName || editing.username}」`} subtitle="用户名不可改；岗位改动立即生效。" onClose={() => setEditing(null)} />
          <div className="mt-5 grid gap-4">
            <Field label="显示名" required>
              <Input value={editForm.displayName} onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })} />
            </Field>
            <Field label="部门">
              <Input value={editForm.department} onChange={(e) => setEditForm({ ...editForm, department: e.target.value })} />
            </Field>
            <Field label="岗位" hint="决定这个人在流程项目里的权限">
              <div className="list-group">
                {JOB_ROLE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setEditForm({ ...editForm, jobRole: o.value })}
                    aria-pressed={editForm.jobRole === o.value}
                    className="group-row !cursor-pointer text-left transition hover:bg-white/60"
                  >
                    <span
                      className={cn(
                        "grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                        editForm.jobRole === o.value ? "bg-[color:var(--tint)] text-white" : "bg-[rgba(120,120,128,0.14)] text-[color:var(--ink-3)]",
                      )}
                    >
                      {editForm.jobRole === o.value ? "✓" : <User className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold">{o.label}</span>
                      <span className="block text-xs text-[color:var(--ink-2)]">{o.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          </div>
          <DialogActions>
            <button type="button" onClick={() => setEditing(null)} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => void saveEdit()} disabled={busy} className="btn btn-primary disabled:opacity-60">
              保存
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
