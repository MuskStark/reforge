"use client";

/**
 * 工作项详情 / 新建。改动先留在表单里,点「保存」一次提交(带版本号做并发保护);
 * 评论、拆分、建立依赖是即时生效的独立动作。
 */

import { useEffect, useMemo, useState } from "react";
import { Link2, Split, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ChecklistItem, ItemStatus, ItemType, Priority, WorkItem } from "@/lib/types";
import { authFetch } from "@/lib/auth";
import { ITEM_STATUS_LABEL, ITEM_TYPE_LABEL, PRIORITY_LABEL, PROJECT_ROLE_LABEL, fmtDateTime } from "@/lib/labels";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar } from "@/components/projects/stage-rail";
import type { DetailCtx } from "@/components/projects/project-detail";
import { cn } from "@/lib/utils";

interface Form {
  type: ItemType;
  title: string;
  body: string;
  status: ItemStatus;
  blockReason: string;
  priority: Priority;
  assigneeId: string;
  stageSeq: number;
  dueDate: string;
  required: boolean;
  checklist: ChecklistItem[];
}

const fromItem = (i: WorkItem): Form => ({
  type: i.type,
  title: i.title,
  body: i.body,
  status: i.status,
  blockReason: i.blockReason,
  priority: i.priority,
  assigneeId: i.assigneeId,
  stageSeq: i.stageSeq,
  dueDate: i.dueDate,
  required: i.required,
  checklist: i.checklist ?? [],
});

const STATUS_ORDER: ItemStatus[] = ["todo", "in_progress", "blocked", "in_review", "done"];
let seq = 0;
const newCheck = (text: string): ChecklistItem => ({ id: `c${Date.now().toString(36)}${(seq++).toString(36)}`, text, done: false });

export function ItemDialog({
  ctx,
  item,
  stageSeq,
  onClose,
  onCreated,
}: {
  ctx: DetailCtx;
  item: WorkItem | null;
  stageSeq: number;
  onClose: () => void;
  /** 新建成功后切到该条目的编辑态 */
  onCreated: (id: string) => void;
}) {
  const { project, me, users, comments, items } = ctx;
  const isNew = !item;
  const editable = project.status === "active";
  // 改动权与后端口径一致:项目管理者,或仍是项目参与者的负责人 / 创建人;新建则任何参与者都可以
  const touchable = editable && (isNew ? project.can.createItem : project.can.manage || (!!item && (item.assigneeId === me.id || item.createdBy === me.id)));
  const canManage = project.can.manage && editable;
  const [form, setForm] = useState<Form>(() =>
    item ? fromItem(item) : { type: "task", title: "", body: "", status: "todo", blockReason: "", priority: "medium", assigneeId: "", stageSeq, dueDate: "", required: false, checklist: [] },
  );
  const [saving, setSaving] = useState(false);
  const [checkDraft, setCheckDraft] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [linkKind, setLinkKind] = useState<"blocks" | "relates">("blocks");
  const [splitIds, setSplitIds] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 条目本身变了(切换条目,或别人改过导致版本号变化)时同步表单;评论等不改变版本号的刷新不会冲掉未保存的输入
  useEffect(() => {
    if (item) setForm(fromItem(item));
  }, [item?.id, item?.version]);

  /** 可被指派的人:项目成员 + CTO */
  const candidates = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; note: string }>();
    project.members.forEach((m) => seen.set(m.userId, { id: m.userId, name: m.displayName, note: PROJECT_ROLE_LABEL[m.role] }));
    users
      .filter((u) => u.jobRole === "cto")
      .forEach((u) => {
        if (!seen.has(u.id)) seen.set(u.id, { id: u.id, name: u.displayName, note: "CTO" });
      });
    if (item?.assigneeId && !seen.has(item.assigneeId)) seen.set(item.assigneeId, { id: item.assigneeId, name: item.assigneeDisplayName, note: "" });
    return [...seen.values()];
  }, [project.members, users, item]);

  const fail = (e: unknown, label: string) =>
    toast.error(label, { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });

  const save = async () => {
    if (!form.title.trim()) {
      toast.error("标题不能为空");
      return;
    }
    if (form.status === "blocked" && !form.blockReason.trim()) {
      toast.error("标记为阻塞时必须填写原因");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await authFetch<WorkItem>(`/api/projects/${project.id}/items`, {
          method: "POST",
          body: JSON.stringify({
            type: form.type,
            title: form.title.trim(),
            body: form.body,
            stageSeq: form.stageSeq,
            priority: form.priority,
            assigneeId: form.assigneeId,
            dueDate: form.dueDate,
            checklist: form.checklist,
            required: canManage && form.required,
          }),
        });
        toast.success("已创建", { description: form.assigneeId ? "已通知负责人" : undefined });
        await ctx.refresh();
        onCreated(created.id);
      } else {
        const diff: Record<string, unknown> = {};
        const base = fromItem(item!);
        if (form.title.trim() !== base.title) diff.title = form.title.trim();
        if (form.body !== base.body) diff.body = form.body;
        if (form.status !== base.status) diff.status = form.status;
        if (form.blockReason !== base.blockReason) diff.blockReason = form.blockReason;
        if (form.priority !== base.priority) diff.priority = form.priority;
        if (form.dueDate !== base.dueDate) diff.dueDate = form.dueDate;
        if (JSON.stringify(form.checklist) !== JSON.stringify(base.checklist)) diff.checklist = form.checklist;
        if (canManage) {
          if (form.assigneeId !== base.assigneeId) diff.assigneeId = form.assigneeId;
          if (form.stageSeq !== base.stageSeq) diff.stageSeq = form.stageSeq;
          if (form.required !== base.required) diff.required = form.required;
        }
        if (Object.keys(diff).length === 0) {
          onClose();
          return;
        }
        await authFetch(`/api/items/${item!.id}`, { method: "PATCH", body: JSON.stringify({ ...diff, version: item!.version }) });
        toast.success("已保存");
        await ctx.refresh();
        onClose();
      }
    } catch (e) {
      fail(e, isNew ? "创建失败" : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await authFetch(`/api/items/${item!.id}`, { method: "DELETE" });
      toast.success("已删除工作项", { description: item!.title });
      await ctx.refresh();
      onClose();
    } catch (e) {
      fail(e, "删除失败");
    }
  };

  const addLink = async () => {
    if (!linkTarget) return;
    try {
      await authFetch(`/api/items/${item!.id}/links`, { method: "POST", body: JSON.stringify({ toId: linkTarget, kind: linkKind }) });
      setLinkTarget("");
      await ctx.refresh();
    } catch (e) {
      fail(e, "建立依赖失败");
    }
  };

  const removeLink = async (toId: string, kind: string) => {
    try {
      await authFetch(`/api/items/${item!.id}/links?toId=${encodeURIComponent(toId)}&kind=${kind}`, { method: "DELETE" });
      await ctx.refresh();
    } catch (e) {
      fail(e, "移除依赖失败");
    }
  };

  const split = async () => {
    if (splitIds.length === 0) {
      toast.error("请选择至少一位成员");
      return;
    }
    try {
      await authFetch(`/api/items/${item!.id}/split`, { method: "POST", body: JSON.stringify({ userIds: splitIds }) });
      toast.success(`已拆成 ${splitIds.length} 条，各自指派并通知`, { description: "原条目保留为汇总父项" });
      setSplitIds([]);
      await ctx.refresh();
      onClose();
    } catch (e) {
      fail(e, "拆分失败");
    }
  };

  const postComment = async () => {
    if (!comment.trim()) return;
    try {
      await authFetch(`/api/projects/${project.id}/comments`, { method: "POST", body: JSON.stringify({ itemId: item!.id, body: comment.trim() }) });
      setComment("");
      await ctx.refresh();
    } catch (e) {
      fail(e, "评论失败");
    }
  };

  const thread = item ? comments.filter((c) => c.itemId === item.id) : [];
  // 可建立依赖的对象:同项目、不是自己
  const linkable = items.filter((i) => item && i.id !== item.id && !(item.links ?? []).some((l) => l.toId === i.id && l.direction === "out"));
  const children = item?.children ?? [];

  return (
    <Dialog onClose={onClose} labelledBy="item-title" className="max-w-[680px]">
      <DialogHeader
        id="item-title"
        title={isNew ? "新建工作项" : "工作项详情"}
        subtitle={
          isNew
            ? `「${project.name}」· 阶段 ${stageSeq} ${project.stages[stageSeq - 1]?.name ?? ""}`
            : `${project.name} · 阶段 ${item!.stageSeq} ${project.stages[item!.stageSeq - 1]?.name ?? ""} · ${item!.createdByName ? `${item!.createdByName} 创建` : "立项时按模板生成"}`
        }
        onClose={onClose}
      />

      <div className="mt-5 grid gap-4">
        {/* 类型 + 标题 */}
        <div className="flex items-center gap-2">
          <select
            aria-label="类型"
            value={form.type}
            disabled={!touchable}
            onChange={(e) => setForm({ ...form, type: e.target.value as ItemType })}
            className="field !h-11 w-auto shrink-0 !px-3 !text-[13px]"
          >
            {(Object.keys(ITEM_TYPE_LABEL) as ItemType[]).map((t) => (
              <option key={t} value={t}>
                {ITEM_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <Input
            aria-label="标题"
            value={form.title}
            readOnly={!touchable}
            placeholder="要做什么，如：梳理接口清单"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            className="!h-11 font-semibold"
          />
        </div>

        {/* 状态 */}
        {!isNew && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-[color:var(--ink-2)]">状态</span>
            <div className="seg seg-mini">
              {STATUS_ORDER.map((s) => (
                <button key={s} type="button" disabled={!touchable} onClick={() => setForm({ ...form, status: s })} className={cn(form.status === s && "on")}>
                  {ITEM_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            {item!.status === "cancelled" && <span className="badge badge-plain">{ITEM_STATUS_LABEL.cancelled}</span>}
          </div>
        )}

        {form.status === "blocked" && (
          <Field label="阻塞原因" required hint="卡在哪里，谁来解">
            <Textarea aria-label="阻塞原因" value={form.blockReason} readOnly={!touchable} onChange={(e) => setForm({ ...form, blockReason: e.target.value })} className="min-h-[60px] !text-[13px]" />
          </Field>
        )}

        {/* 归属 */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="负责人" hint={canManage ? undefined : "由项目经理指派"}>
            <select
              aria-label="负责人"
              value={form.assigneeId}
              disabled={!canManage}
              onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
              className="field !h-11 !text-[13px]"
            >
              <option value="">未指派</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.note ? ` · ${c.note}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="所属阶段">
            <select aria-label="所属阶段" value={form.stageSeq} disabled={!canManage} onChange={(e) => setForm({ ...form, stageSeq: Number(e.target.value) })} className="field !h-11 !text-[13px]">
              {project.stages.map((s) => (
                <option key={s.seq} value={s.seq}>
                  {s.seq} · {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="截止日">
            <input type="date" aria-label="截止日" value={form.dueDate} disabled={!touchable} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="field !h-11 !text-[13px]" />
          </Field>
          <Field label="优先级">
            <select aria-label="优先级" value={form.priority} disabled={!touchable} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })} className="field !h-11 !text-[13px]">
              {(["high", "medium", "low"] as const).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {canManage && (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-2xl bg-[color:var(--amber-soft)] px-3.5 py-2.5 text-[13px] text-[color:var(--amber-deep)]">
            <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} className="size-4 accent-[color:var(--amber)]" />
            <span className="font-semibold">必交付物</span>
            <span className="text-[color:var(--ink-2)]">未完成时，项目经理不能提交本阶段的评审</span>
          </label>
        )}

        <Field label="说明">
          <Textarea aria-label="说明" value={form.body} readOnly={!touchable} onChange={(e) => setForm({ ...form, body: e.target.value })} className="min-h-[84px] !text-[13px]" placeholder="验收标准、参考资料、相关链接" />
        </Field>

        {/* 清单 */}
        <div>
          <span className="text-[13px] font-medium text-neutral-800">清单</span>
          <ul className="mt-1.5 grid gap-1">
            {form.checklist.map((c) => (
              <li key={c.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-white/50">
                <input
                  type="checkbox"
                  checked={c.done}
                  disabled={!touchable}
                  onChange={(e) => setForm({ ...form, checklist: form.checklist.map((x) => (x.id === c.id ? { ...x, done: e.target.checked } : x)) })}
                  className="size-4 accent-[color:var(--tint)]"
                  aria-label={c.text}
                />
                <span className={cn("min-w-0 flex-1 text-[13px]", c.done ? "text-[color:var(--ink-3)] line-through" : "text-neutral-900")}>{c.text}</span>
                {touchable && (
                  <button type="button" aria-label={`删除清单项 ${c.text}`} onClick={() => setForm({ ...form, checklist: form.checklist.filter((x) => x.id !== c.id) })} className="icon-btn icon-danger !h-7 !w-7">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {touchable && (
            <div className="mt-1.5 flex gap-2">
              <Input value={checkDraft} placeholder="加一项，回车确认" onChange={(e) => setCheckDraft(e.target.value)} className="!h-10 !text-[13px]" aria-label="新增清单项" onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const t = checkDraft.trim();
                  if (t) setForm({ ...form, checklist: [...form.checklist, newCheck(t)] });
                  setCheckDraft("");
                }
              }} />
              <button type="button" onClick={() => { const t = checkDraft.trim(); if (t) setForm({ ...form, checklist: [...form.checklist, newCheck(t)] }); setCheckDraft(""); }} className="btn btn-glass !h-10 !px-3.5 text-[13px]">
                添加
              </button>
            </div>
          )}
        </div>

        {/* 子任务 */}
        {!isNew && children.length > 0 && (
          <div>
            <span className="text-[13px] font-medium text-neutral-800">拆分出的子任务</span>
            <ul className="mt-1.5 grid gap-1">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-xl bg-white/50 px-2.5 py-1.5 text-[13px]">
                  <span className={cn("size-1.5 rounded-full", c.status === "done" ? "bg-[color:var(--green)]" : c.status === "blocked" ? "bg-[color:var(--red)]" : "bg-[#007aff]")} />
                  <span className={cn("min-w-0 flex-1 truncate", c.status === "done" && "text-[color:var(--ink-3)] line-through")}>{c.title}</span>
                  <span className="flex items-center gap-1 text-[11px] text-[color:var(--ink-2)]">
                    <Avatar name={c.assigneeDisplayName} size={16} />
                    {c.assigneeDisplayName || "未指派"} · {ITEM_STATUS_LABEL[c.status]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 依赖 */}
        {!isNew && (
          <div>
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-neutral-800">
              <Link2 className="h-3.5 w-3.5 text-[color:var(--ink-3)]" /> 依赖关系
            </span>
            <ul className="mt-1.5 grid gap-1">
              {(item!.links ?? []).map((l) => (
                <li key={l.direction + l.toId + l.kind} className="flex items-center gap-2 rounded-xl bg-white/50 px-2.5 py-1.5 text-[13px]">
                  <span className="shrink-0 text-[color:var(--ink-2)]">{l.direction === "in" ? (l.kind === "blocks" ? "被它阻塞" : "被它关联") : l.kind === "blocks" ? "阻塞它" : "关联它"}</span>
                  <span className={cn("min-w-0 flex-1 truncate", l.toStatus === "done" && "text-[color:var(--ink-3)] line-through")}>{l.toTitle}</span>
                  <span className="text-[11px] text-[color:var(--ink-3)]">{ITEM_STATUS_LABEL[l.toStatus]}</span>
                  {project.can.comment && editable && (
                    <button type="button" aria-label="移除这条依赖" onClick={() => void removeLink(l.toId, l.kind)} className="icon-btn icon-danger !h-7 !w-7">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {project.can.comment && editable && linkable.length > 0 && (
              <div className="mt-1.5 flex gap-2">
                <select value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)} aria-label="选择要关联的工作项" className="field !h-10 min-w-0 flex-1 !text-[13px]">
                  <option value="">关联到…</option>
                  {linkable.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title}
                    </option>
                  ))}
                </select>
                <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as "blocks" | "relates")} aria-label="关系类型" className="field !h-10 w-auto !px-3 !text-[13px]">
                  <option value="blocks">阻塞</option>
                  <option value="relates">相关</option>
                </select>
                <button type="button" disabled={!linkTarget} onClick={() => void addLink()} className="btn btn-glass !h-10 !px-3.5 text-[13px] disabled:opacity-50">
                  添加
                </button>
              </div>
            )}
          </div>
        )}

        {/* 按成员拆分 */}
        {!isNew && canManage && (
          <details className="rounded-2xl bg-white/45 px-3.5 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-neutral-800">
              <Split className="h-3.5 w-3.5 text-[color:var(--ink-3)]" /> 按成员拆分
              <span className="text-xs font-normal text-[color:var(--ink-2)]">需要多人各自完成同一件事时，一人一条</span>
            </summary>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {candidates.map((c) => {
                const on = splitIds.includes(c.id);
                return (
                  <button key={c.id} type="button" onClick={() => setSplitIds((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))} aria-pressed={on} className={cn("rounded-full px-3 py-1.5 text-[12px] font-medium transition", on ? "bg-[color:var(--tint)] text-white" : "bg-white/70 text-neutral-800 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]")}>
                    {c.name}
                  </button>
                );
              })}
            </div>
            <button type="button" disabled={splitIds.length === 0} onClick={() => void split()} className="btn btn-glass mt-2.5 !h-9 !px-3.5 text-[13px] disabled:opacity-50">
              拆成 {splitIds.length || ""} 条并指派
            </button>
          </details>
        )}
      </div>

      {/* 评论 */}
      {!isNew && (
        <div className="mt-5 border-t border-[color:var(--sep)] pt-4">
          <span className="text-[13px] font-medium text-neutral-800">评论</span>
          {thread.length === 0 && <p className="mt-1.5 text-xs text-[color:var(--ink-3)]">还没有评论。在评论里 @某人 会通知对方。</p>}
          <ul className="mt-2 grid gap-2">
            {thread.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar name={c.authorDisplayName} size={24} />
                <div className="min-w-0 flex-1 rounded-2xl bg-white/60 px-3 py-2">
                  <div className="flex items-baseline gap-2 text-[11px] text-[color:var(--ink-3)]">
                    <span className="text-[12px] font-semibold text-neutral-900">{c.authorDisplayName}</span>
                    {fmtDateTime(c.createdAt)}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-900">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
          {project.can.comment && (
            <div className="mt-2.5 flex gap-2">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} aria-label="写评论" placeholder={`写评论… @${candidates[0]?.name ?? "某人"} 可提及`} className="min-h-[44px] !text-[13px]" onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void postComment();
              }} />
              <button type="button" disabled={!comment.trim()} onClick={() => void postComment()} className="btn btn-primary shrink-0 !h-10 self-end !px-3.5 text-[13px] disabled:opacity-50">
                发送
              </button>
            </div>
          )}
        </div>
      )}

      <DialogActions>
        {!isNew && project.can.manage && editable && (
          confirmDelete ? (
            <>
              <span className="mr-auto text-[13px] text-[color:var(--red-deep)]">删除后不可恢复，确定？</span>
              <button type="button" onClick={() => setConfirmDelete(false)} className="btn btn-glass !h-9">
                再想想
              </button>
              <button type="button" onClick={() => void remove()} className="btn !h-9 bg-[color:var(--red)] !px-4 text-white hover:brightness-110">
                确认删除
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-glass mr-auto !h-9 !px-3 text-[13px] text-[color:var(--red-deep)]">
              <Trash2 className="h-3.5 w-3.5" /> 删除
            </button>
          )
        )}
        <button type="button" onClick={onClose} className="btn btn-glass !h-10">
          {touchable ? "取消" : "关闭"}
        </button>
        {touchable && (
          <button type="button" disabled={saving} onClick={() => void save()} className="btn btn-primary !h-10 disabled:opacity-60">
            {isNew ? "创建" : "保存"}
          </button>
        )}
      </DialogActions>
    </Dialog>
  );
}
