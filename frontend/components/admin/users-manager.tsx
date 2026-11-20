"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, ShieldCheck, User, Users, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { authFetch, type SessionUser } from "@/lib/auth";

interface RegisteredUser {
  id: string;
  username: string;
  role: "admin" | "member";
  createdAt: string;
}

/** 后台 · 用户管理：管理员创建/删除账号（公开注册在首个用户后已关闭） */
export function UsersManager({
  onLogout,
  me,
}: {
  onLogout: () => void;
  me: SessionUser | null;
}) {
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [draftUser, setDraftUser] = useState("");
  const [draftPass, setDraftPass] = useState("");
  const [draftRole, setDraftRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await authFetch<RegisteredUser[]>("/api/admin/users"));
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!draftUser.trim() || !draftPass) {
      toast.error("请填写用户名和密码");
      return;
    }
    setBusy(true);
    try {
      const u = await authFetch<RegisteredUser>("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: draftUser.trim(),
          password: draftPass,
          role: draftRole,
        }),
      });
      setUsers((prev) => [...prev, u]);
      setDraftUser("");
      setDraftPass("");
      toast.success("已创建", {
        description: `「${u.username}」${u.role === "admin" ? "（管理员）" : "（普通用户）"}可凭密码登录`,
      });
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("创建失败", { description: e instanceof Error ? e.message : "请重试" });
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
    <section className="glass-card mb-6 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-white">
          <Users className="h-4 w-4 text-cyan-300" />
          用户
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-normal text-neutral-300">
            {users.length}
          </span>
        </h2>
        <p className="text-xs text-[color:var(--flow-muted)]">
          公开注册已关闭 · 账号由管理员在此创建
        </p>
      </div>

      {/* 创建表单 */}
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          value={draftUser}
          placeholder="新用户名（2-32 字符）"
          onChange={(e) => setDraftUser(e.target.value)}
          className="h-9 min-w-[160px] flex-1"
        />
        <Input
          type="password"
          value={draftPass}
          placeholder="初始密码（至少 6 位）"
          autoComplete="new-password"
          onChange={(e) => setDraftPass(e.target.value)}
          className="h-9 min-w-[160px] flex-1"
        />
        <select
          value={draftRole}
          onChange={(e) => setDraftRole(e.target.value as "member" | "admin")}
          className="h-9 rounded-md border-none bg-black px-3 text-sm text-white shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] outline-none focus:shadow-[0_0_1px_2px_#3EC1D3]"
        >
          <option value="member">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy}
          className="flex h-9 shrink-0 items-center gap-1 rounded-md bg-white px-4 text-xs font-semibold text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> 创建用户
        </button>
      </div>

      {/* 用户清单 */}
      {users.length === 0 ? (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-2.5 text-xs text-neutral-500">
          暂无注册用户（当前使用环境变量引导账号）
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {users.map((u) => {
            const isSelf = me?.username === u.username;
            return (
              <li
                key={u.id}
                className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <span
                  className={
                    u.role === "admin"
                      ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-amber-400/50 bg-amber-400/15 text-amber-300"
                      : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/5 text-neutral-400"
                  }
                >
                  {u.role === "admin" ? (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  ) : (
                    <User className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-white">
                  {u.username}
                  {isSelf && (
                    <span className="ml-1.5 rounded-full bg-cyan-400/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
                      当前登录
                    </span>
                  )}
                </span>
                <span
                  className={
                    u.role === "admin"
                      ? "rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                      : "rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-neutral-400"
                  }
                >
                  {u.role === "admin" ? "管理员" : "普通用户"}
                </span>
                <span className="font-data hidden text-[10px] text-neutral-600 sm:block">
                  {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(u)}
                  disabled={isSelf}
                  aria-label={`删除 ${u.username}`}
                  className="rounded-full p-1 text-neutral-600 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent"
                  title={isSelf ? "不能删除当前登录账号" : "删除该用户"}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
