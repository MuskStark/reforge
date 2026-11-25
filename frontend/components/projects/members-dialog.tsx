"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ProjectCaps, ProjectView, UserDir } from "@/lib/types";
import { authFetch } from "@/lib/auth";
import { JOB_ROLE_LABEL, PROJECT_ROLE_OWNER } from "@/lib/labels";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { MemberChip, UserOptionLine } from "@/components/projects/stage-rail";
import { cn } from "@/lib/utils";

type Role = "pm" | "handler" | "dev" | "viewer";

/**
 * 项目里的四类成员。每类由谁分配与服务端一致:管理员分配全部;CTO 分配 TH(科技经办);
 * PM 分配 BH(业务经办)。flag 是服务端为当前用户下发的对应能力。
 * 名称一律用英文缩写,中文全称放在说明的开头。
 */
const ROLE_META: { role: Role; label: string; hint: string; flag: keyof ProjectCaps; empty: string }[] = [
  { role: "pm", label: "PM", hint: "项目经理：对项目交付负责，制定计划、拆解任务、推进阶段、提交评审", flag: "assign", empty: "未指派" },
  { role: "handler", label: "BH", hint: "业务经办：确认需求、执行试运行；需求基线与试运行结论由他们会签", flag: "assignHandler", empty: "尚未添加 —— 需求基线与试运行结论需要他们会签" },
  { role: "dev", label: "TH", hint: "科技经办：承接系统改造，开发、配置、联调、测试", flag: "assignDev", empty: "未添加" },
  { role: "viewer", label: "GM", hint: "总经理：只读", flag: "assignViewer", empty: "未添加" },
];

/** 能否打开成员管理:至少能分配一类成员(服务端仍然逐请求校验) */
export function canAssignMembers(can: ProjectCaps): boolean {
  return can.assign || can.assignHandler || can.assignDev || can.assignViewer;
}

/**
 * 成员管理 / 立项指派。管理员可以分配全部成员;CTO 只分配 TH,PM 只分配 BH,
 * 其余区块只读并注明由谁分配。第一位 PM 到岗时项目正式启动。
 */
export function MembersDialog({
  project,
  users,
  onClose,
  onSaved,
}: {
  project: ProjectView;
  users: UserDir[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [pick, setPick] = useState<Record<Role, string>>({ pm: "", handler: "", dev: "", viewer: "" });
  const [busy, setBusy] = useState(false);
  // 从看板打开时传入的是列表里的项目(不带经办候选):先拉一次详情
  const [full, setFull] = useState<ProjectView | null>(null);
  useEffect(() => {
    void authFetch<ProjectView>(`/api/projects/${project.id}`, { cache: "no-store" })
      .then(setFull)
      .catch(() => {});
  }, [project.id]);
  project = full ?? project;
  const ended = project.status === "done" || project.status === "cancelled";
  const ctoNames = users.filter((u) => u.jobRole === "cto").map((u) => u.displayName);
  const hinted = new Set(project.handlerHints.filter((h) => h.matched).map((h) => h.userId));
  const unmatched = project.handlerHints.filter((h) => !h.matched).map((h) => h.raw);

  const act = async (userId: string, role: Role, action: "add" | "remove", label: string) => {
    setBusy(true);
    try {
      await authFetch(`/api/projects/${project.id}/members`, {
        method: "PUT",
        body: JSON.stringify({ userId, role, action }),
      });
      toast.success(action === "add" ? `已${role === "pm" ? "指派" : "分配"} ${label}` : `已移除 ${label}`);
      setPick((p) => ({ ...p, [role]: "" }));
      const latest = await authFetch<ProjectView>(`/api/projects/${project.id}`, { cache: "no-store" });
      setFull(latest);
      await onSaved();
    } catch (e) {
      toast.error("操作失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} labelledBy="members-title" className="max-w-[620px]">
      <DialogHeader
        id="members-title"
        title="项目成员"
        subtitle="管理员可分配全部成员；CTO 分配 TH，PM 分配 BH。第一位 PM 到岗后项目正式启动。"
        onClose={onClose}
      />

      <div className="mt-5 space-y-3">
        {!project.hasPm && !ended && (
          <p className="rounded-2xl bg-[color:var(--amber-soft)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[color:var(--amber-deep)] shadow-[inset_0_0_0_0.5px_rgba(255,149,0,0.25)]">
            尚未指派 PM。流程已自动立项，指派后进入阶段 1「{project.stages[0]?.name ?? "分析立项"}」。
          </p>
        )}

        {ROLE_META.map(({ role, label, hint, flag, empty }) => {
          const canEdit = !ended && !!project.can[flag];
          const current = project.members.filter((m) => m.role === role);
          const has = new Set(current.map((m) => m.userId));
          const candidates = users
            .filter((u) => !has.has(u.id))
            .sort((a, b) => {
              // 岗位对口的人排前面;BH 再优先显示流程里登记过的人
              const rank = (u: UserDir) => (u.jobRole === role ? 0 : 1) * 10 + (role === "handler" && hinted.has(u.id) ? 0 : 1);
              return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, "zh-CN");
            });
          return (
            <section key={role} className="rounded-2xl bg-white/55 p-3.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h3 className="text-[14px] font-semibold text-neutral-900">{label}</h3>
                <span className="text-xs text-[color:var(--ink-2)]">{hint}</span>
                {!canEdit && !ended && <span className="ml-auto text-[11px] text-[color:var(--ink-3)]">{PROJECT_ROLE_OWNER[role]}</span>}
              </div>

              {current.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {current.map((m) => (
                    <MemberChip
                      key={m.userId}
                      name={m.displayName}
                      role={role}
                      onRemove={canEdit ? () => void act(m.userId, role, "remove", m.displayName) : undefined}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-[color:var(--ink-3)]">{empty}</p>
              )}

              {canEdit && (
                <div className="mt-2.5 flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    <select
                      value={pick[role]}
                      onChange={(e) => setPick((p) => ({ ...p, [role]: e.target.value }))}
                      aria-label={`选择${label}`}
                      className="field pr-9 !h-11"
                    >
                      <option value="">{candidates.length ? `选择${role === "pm" ? "PM" : "成员"}…` : "没有可选的人"}</option>
                      {candidates.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName}
                          {u.jobRole === role ? ` · ${JOB_ROLE_LABEL[u.jobRole]}` : ""}
                          {role === "handler" && hinted.has(u.id) ? " · 流程登记" : ""}
                        </option>
                      ))}
                    </select>
                    <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M6 9.5l6 6 6-6" />
                    </svg>
                  </div>
                  <button
                    type="button"
                    disabled={!pick[role] || busy}
                    onClick={() => {
                      const u = users.find((x) => x.id === pick[role]);
                      if (u) void act(u.id, role, "add", u.displayName);
                    }}
                    className={cn("btn !h-11 shrink-0 !px-4 text-sm disabled:opacity-50", role === "pm" ? "btn-primary" : "btn-glass")}
                  >
                    {role === "pm" ? "指派" : "添加"}
                  </button>
                </div>
              )}
            </section>
          );
        })}

        <section className="rounded-2xl bg-[linear-gradient(180deg,rgba(240,240,255,0.5),rgba(255,255,255,0.45))] p-3.5 shadow-[inset_0_0_0_0.5px_rgba(88,86,214,0.25)]">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[14px] font-semibold text-[color:var(--indigo-deep)]">CTO · 技术负责人</h3>
            <span className="text-xs text-[color:var(--ink-2)]">全局岗位，可查看全部流程并评审方案，无需逐项目添加</span>
          </div>
          <p className="mt-2 text-[13px] text-[color:var(--indigo-deep)]">{ctoNames.length ? ctoNames.join("、") : "尚未设置 CTO —— 请到「用户与岗位」把对应的人的岗位设为 CTO"}</p>
        </section>

        {unmatched.length > 0 && (
          <p className="rounded-2xl bg-white/45 px-3.5 py-2.5 text-xs leading-relaxed text-[color:var(--ink-2)]">
            流程里登记过、但系统里没有对应账号的人员：{unmatched.join("、")}。在「用户与岗位」按姓名创建账号后，会自动出现在 BH 的候选里。
          </p>
        )}
      </div>

      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-primary">
          完成
        </button>
      </DialogActions>
    </Dialog>
  );
}

/** 给选择控件用的一行候选项(头像 + 名字 + 岗位) */
export function CandidateLine({ u, extra }: { u: UserDir; extra?: string }) {
  return <UserOptionLine u={u} suffix={extra} />;
}
