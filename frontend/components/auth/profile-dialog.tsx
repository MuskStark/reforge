"use client";

import { useId, useState } from "react";
import { KeyRound, LogOut, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Dialog, DialogActions, Field } from "@/components/ui/dialog";
import { authFetch, setSessionUser, type SessionUser } from "@/lib/auth";
import { JOB_ROLE_LABEL } from "@/lib/labels";

const noop = () => {};

/**
 * 个人信息:改显示名 / 部门,改密码。岗位与系统角色由管理员维护,这里只展示。
 * forced = 首次登录,管理员设定的初始密码还没换:只显示改密码,而且不能关闭——
 * 改完之前服务端会拒绝其他所有接口。
 */
export function ProfileDialog({
  me,
  forced = false,
  onClose,
  onSaved,
  onLogout,
}: {
  me: SessionUser;
  /** 首次登录强制改密码 */
  forced?: boolean;
  onClose: () => void;
  /** 资料或密码改完后回调,参数是服务端返回的最新用户 */
  onSaved: (user: SessionUser) => void;
  /** 强制改密时可以先退出登录 */
  onLogout?: () => void;
}) {
  // 环境变量引导的管理员没有用户行:资料和密码都在服务器配置里
  const managed = me.id === "";
  const [displayName, setDisplayName] = useState(me.displayName);
  const [department, setDepartment] = useState(me.department);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"profile" | "password" | null>(null);

  const saveProfile = async () => {
    if (!displayName.trim()) {
      toast.error("显示名不能为空");
      return;
    }
    setBusy("profile");
    try {
      const user = await authFetch<SessionUser>("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: displayName.trim(), department: department.trim() }),
      });
      setSessionUser(user);
      onSaved(user);
      toast.success("个人信息已保存");
    } catch (e) {
      toast.error("保存失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(null);
    }
  };

  const changePassword = async () => {
    if (!oldPassword) {
      toast.error("请输入原密码");
      return;
    }
    if (newPassword.length < 6 || newPassword.length > 64) {
      toast.error("新密码长度需在 6-64 位之间");
      return;
    }
    if (newPassword === oldPassword) {
      toast.error("新密码不能与原密码相同");
      return;
    }
    if (newPassword !== confirm) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    setBusy("password");
    try {
      const user = await authFetch<SessionUser>("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      setSessionUser(user);
      onSaved(user);
      toast.success(forced ? "密码已更新，现在可以正常使用了" : "密码已修改");
      if (!forced) onClose();
    } catch (e) {
      toast.error("修改失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(null);
    }
  };

  const roleText = [me.role === "admin" ? "系统管理员" : "", me.jobRole ? JOB_ROLE_LABEL[me.jobRole] : ""].filter(Boolean).join(" · ") || "成员";
  // 密码表单的 id:底部的「修改密码」按钮在表单外面,靠它关联,输入框里按回车也能提交
  const formId = useId();

  return (
    <Dialog onClose={forced ? noop : onClose} labelledBy="profile-title" className="max-w-[520px]">
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] text-white"
          style={{
            background: "linear-gradient(180deg, #2b95ff, #0071e3)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 3px 8px -3px rgba(0,113,227,0.6)",
          }}
        >
          {forced ? <KeyRound className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="profile-title" className="text-[19px] font-bold tracking-[-0.02em] text-neutral-900">
            {forced ? "首次登录，请修改密码" : "个人信息"}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--ink-2)]">
            {forced
              ? "这个账号的初始密码由管理员设定。换成只有你知道的密码后，才能开始使用。"
              : "显示名与部门会用在任务指派、@提及和通知里。"}
          </p>
        </div>
        {!forced && (
          <button type="button" onClick={onClose} aria-label="关闭" className="icon-btn icon-danger !h-9 !w-9 shrink-0">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mt-5 space-y-5">
        {managed ? (
          <p className="rounded-2xl bg-[color:var(--amber-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[color:var(--amber-deep)]">
            当前账号由服务器环境变量管理，个人信息和密码需要在服务器配置中修改。
          </p>
        ) : (
          <>
            {!forced && (
              <section>
                <h3 className="mb-2.5 text-[13px] font-semibold text-neutral-900">基本信息</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="账号">
                    <Input value={me.username} readOnly className="!h-11 opacity-70" />
                  </Field>
                  <Field label="岗位">
                    <Input value={roleText} readOnly className="!h-11 opacity-70" />
                  </Field>
                  <Field label="显示名" required>
                    <Input value={displayName} maxLength={32} autoComplete="nickname" onChange={(e) => setDisplayName(e.target.value)} className="!h-11" />
                  </Field>
                  <Field label="部门">
                    <Input value={department} maxLength={64} autoComplete="organization" onChange={(e) => setDepartment(e.target.value)} className="!h-11" />
                  </Field>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void saveProfile()}
                    disabled={busy !== null || (displayName.trim() === me.displayName && department.trim() === me.department)}
                    className="btn btn-primary disabled:opacity-50"
                  >
                    保存
                  </button>
                </div>
              </section>
            )}

            <form
              id={formId}
              onSubmit={(e) => {
                e.preventDefault();
                void changePassword();
              }}
            >
              <h3 className="mb-2.5 text-[13px] font-semibold text-neutral-900">{forced ? "设置新密码" : "修改密码"}</h3>
              <div className="grid gap-3">
                <Field label="原密码" required>
                  <Input type="password" value={oldPassword} autoComplete="current-password" onChange={(e) => setOldPassword(e.target.value)} className="!h-11" />
                </Field>
                <Field label="新密码" required hint="6-64 位">
                  <Input type="password" value={newPassword} autoComplete="new-password" onChange={(e) => setNewPassword(e.target.value)} className="!h-11" />
                </Field>
                <Field label="确认新密码" required>
                  <Input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} className="!h-11" />
                </Field>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[color:var(--ink-3)]">修改后，其他设备上这个账号的登录会失效。</p>
            </form>
          </>
        )}
      </div>

      <DialogActions>
        {forced && onLogout && (
          <button type="button" onClick={onLogout} className="btn btn-glass mr-auto">
            <LogOut className="h-4 w-4" /> 退出登录
          </button>
        )}
        <button type="submit" form={formId} disabled={busy !== null || managed} className="btn btn-primary disabled:opacity-60">
          {forced ? "更新密码并继续" : "修改密码"}
        </button>
      </DialogActions>
    </Dialog>
  );
}
