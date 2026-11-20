"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, User, Users } from "lucide-react";
import { authFetch } from "@/lib/auth";

interface RegisteredUser {
  id: string;
  username: string;
  role: "admin" | "member";
  createdAt: string;
}

/** 后台 · 用户：查看注册用户与角色（首个注册用户自动成为管理员） */
export function UsersManager({ onLogout }: { onLogout: () => void }) {
  const [users, setUsers] = useState<RegisteredUser[]>([]);

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
          首个注册用户自动成为管理员；其后注册为普通用户
        </p>
      </div>

      {users.length === 0 ? (
        <p className="rounded-md border border-dashed border-white/10 px-3 py-2.5 text-xs text-neutral-500">
          暂无注册用户（当前使用环境变量引导账号）
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {users.map((u) => (
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
              <span className="min-w-0 flex-1 truncate text-sm text-white">{u.username}</span>
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
