"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, ShieldCheck, User, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { authFetch, type SessionUser } from "@/lib/auth";
import { JOB_ROLE_LABEL, JOB_ROLE_OPTIONS } from "@/lib/labels";
import type { JobRole } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RegisteredUser {
  id: string;
  username: string;
  role: "admin" | "member";
  displayName: string;
  department: string;
  jobRole: JobRole;
  createdAt: string;
}

const emptyDraft = () => ({ username: "", password: "", role: "member" as "member" | "admin", displayName: "", department: "", jobRole: "handler" as JobRole });

/** 岗位徽章:CTO 紫红、项目经理 蓝、经办 绿、开发 琥珀、观察者 灰 */
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
 * 岗位决定这个人在流程项目里能做什么:CTO 评审,项目经理推进,经办确认与试运行。
 */
export function UsersManager({
  onLogout,
  me,
}: {
  onLogout: () => void;
  me: SessionUser | null;
}) {
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<RegisteredUser | null>(null);
  const [editForm, setEditForm] = useState({ displayName: "", department: "", jobRole: "handler" as JobRole });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await authFetch<RegisteredUser[]>("/api/admin/users", { cache: "no-store" }));
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

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
      setUsers((prev) => [...prev, u]);
      setDraft(emptyDraft());
      toast.success("已创建", { description: `「${u.displayName}」· ${JOB_ROLE_LABEL[u.jobRole]}，可凭密码登录` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("创建失败", { description: e instanceof Error ? e.message : "请重试" });
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
      setUsers((prev) => prev.map((x) => (x.id === u.id ? u : x)));
      toast.success("已保存", { description: `「${u.displayName}」· ${JOB_ROLE_LABEL[u.jobRole]}` });
      setEditing(null);
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("保存失败", { description: e instanceof Error ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: RegisteredUser) => {
    try {
      await authFetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      toast.success("已删除", { description: `「${u.username}」账号已移除` });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("删除失败", { description: e instanceof Error ? e.message : "请重试" });
    }
  };

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-[22px] font-bold tracking-[-0.02em]">
          用户与岗位
          <span className="badge badge-plain">{users.length}</span>
        </h2>
        <p className="ml-auto text-xs text-[color:var(--ink-2)]">公开注册已关闭 · 账号由管理员在此创建</p>
      </div>

      {/* 创建表单 */}
      <div className="glass-card mb-3 p-5">
        <p className="mb-3 text-[13px] font-semibold text-neutral-900">创建账号</p>
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          <Input value={draft.username} placeholder="用户名（2-32 字符，用于登录）" autoComplete="off" onChange={(e) => setDraft({ ...draft, username: e.target.value })} className="!h-11" />
          <Input value={draft.displayName} placeholder="显示名 / 姓名（如：张三）" autoComplete="off" onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} className="!h-11" />
          <Input type="password" value={draft.password} placeholder="初始密码（至少 6 位）" autoComplete="new-password" onChange={(e) => setDraft({ ...draft, password: e.target.value })} className="!h-11" />
          <Input value={draft.department} placeholder="部门（选填，如：信息中心）" autoComplete="off" onChange={(e) => setDraft({ ...draft, department: e.target.value })} className="!h-11" />
          <select value={draft.jobRole} onChange={(e) => setDraft({ ...draft, jobRole: e.target.value as JobRole })} aria-label="岗位" className="field !h-11">
            {JOB_ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                岗位：{o.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as "member" | "admin" })} aria-label="系统角色" className="field !h-11 min-w-0 flex-1">
              <option value="member">普通账号</option>
              <option value="admin">系统管理员</option>
            </select>
            <button type="button" onClick={() => void add()} disabled={busy} className="btn btn-primary !h-11 shrink-0 !px-4 text-sm disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" /> 创建
            </button>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
          岗位说明：CTO 评审立项、方案、上线与验收（全局生效）；项目经理负责推进；经办确认需求、执行试运行；开发实施承接改造任务；观察者只读。
        </p>
      </div>

      {/* 用户清单 */}
      <div className="glass-card p-3 sm:p-4">
        {users.length === 0 ? (
          <p className="rounded-xl border border-dashed border-black/10 bg-white/30 px-3 py-2.5 text-xs text-[color:var(--ink-3)]">
            暂无注册用户（当前使用环境变量引导账号）
          </p>
        ) : (
          <ul className="grid gap-2.5">
            {users.map((u) => {
              const isSelf = me?.username === u.username;
              return (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl bg-white/50 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]"
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold",
                      u.role === "admin" ? "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]" : "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]",
                    )}
                  >
                    {(u.displayName || u.username).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[15px] font-medium text-neutral-900">
                      {u.displayName || u.username}
                      {isSelf && <span className="badge badge-blue !h-[19px] !px-1.5 text-[10px]">当前登录</span>}
                    </span>
                    <span className="font-data block truncate text-[11px] text-[color:var(--ink-3)]">
                      @{u.username}
                      {u.department && ` · ${u.department}`}
                    </span>
                  </span>
                  <span className={jobBadge(u.jobRole)}>{JOB_ROLE_LABEL[u.jobRole]}</span>
                  {u.role === "admin" && (
                    <span className="badge badge-amber !h-[22px] text-[11px]">
                      <ShieldCheck className="h-3 w-3" /> 管理员
                    </span>
                  )}
                  <span className="font-data hidden text-[11px] text-[color:var(--ink-3)] sm:block">
                    {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                  </span>
                  <button type="button" onClick={() => openEdit(u)} aria-label={`编辑 ${u.displayName || u.username}`} className="icon-btn !h-9 !w-9" title="编辑显示名 / 部门 / 岗位">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(u)}
                    disabled={isSelf}
                    aria-label={`删除 ${u.username}`}
                    className="icon-btn icon-danger !h-9 !w-9 disabled:opacity-30"
                    title={isSelf ? "不能删除当前登录账号" : "删除该用户"}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
