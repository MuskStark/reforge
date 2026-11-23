"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { Health, ProjectView } from "@/lib/types";
import { authFetch } from "@/lib/auth";
import { HEALTH_LABEL } from "@/lib/labels";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DetailCtx } from "@/components/projects/project-detail";

const FIELDS = [
  { key: "progress", label: "本期进展", hint: "完成了什么", required: true },
  { key: "next", label: "下期计划", hint: "接下来做什么" },
  { key: "risks", label: "风险与阻塞", hint: "卡在哪里" },
  { key: "help", label: "需要的支持", hint: "需要谁出面" },
] as const;

type Form = { progress: string; next: string; risks: string; help: string; health: Health };

/**
 * 项目简报:四栏进展 + 健康度。健康度随每次简报更新(不是独立字段),
 * 标为「有风险 / 已偏离」时通知全部 CTO。
 */
export function UpdateDialog({ ctx, onClose }: { ctx: DetailCtx; onClose: () => void }) {
  const project: ProjectView = ctx.project;
  const [form, setForm] = useState<Form>({ progress: "", next: "", risks: "", help: "", health: project.health });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!form.progress.trim()) {
      toast.error("请填写本期进展");
      return;
    }
    setBusy(true);
    try {
      await authFetch(`/api/projects/${project.id}/updates`, { method: "POST", body: JSON.stringify(form) });
      toast.success("简报已发布", {
        description: form.health === "on_track" ? undefined : `健康度标为「${HEALTH_LABEL[form.health]}」，已通知 CTO`,
      });
      await ctx.refresh();
      onClose();
    } catch (e) {
      toast.error("发布失败", { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} labelledBy="update-title" className="max-w-[640px]">
      <DialogHeader
        id="update-title"
        title="写简报"
        subtitle={`「${project.name}」· 阶段 ${project.currentStage} ${project.stages[project.currentStage - 1]?.name ?? ""}。用四栏说清进展，让 CTO 不用开会也知道项目怎么样。`}
        onClose={onClose}
      />

      <div className="mt-5 grid gap-4">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} required={"required" in f && f.required}>
            <Textarea
              aria-label={f.label}
              value={form[f.key]}
              onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
              className="min-h-[64px] !text-[13px]"
              placeholder={f.key === "progress" ? "如：接口清单已梳理完，To-Be 流程初稿完成" : ""}
            />
          </Field>
        ))}

        <Field label="健康度" hint="随简报更新；非「正常」时通知 CTO">
          <div className="grid grid-cols-3 gap-2">
            {(["on_track", "at_risk", "off_track"] as const).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setForm((x) => ({ ...x, health: h }))}
                aria-pressed={form.health === h}
                className={cn(
                  "flex h-11 flex-col items-center justify-center rounded-2xl text-[14px] font-semibold transition",
                  form.health === h
                    ? cn(
                        "text-white shadow-[0_6px_16px_-6px_rgba(23,42,80,0.4)]",
                        h === "on_track" && "bg-[color:var(--green)]",
                        h === "at_risk" && "bg-[color:var(--amber)]",
                        h === "off_track" && "bg-[color:var(--red)]",
                      )
                    : "bg-white/55 text-[color:var(--ink-2)] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.05)] hover:bg-white/80",
                )}
              >
                {HEALTH_LABEL[h]}
                <span className="text-[10px] font-normal opacity-80">{h === "on_track" ? "按计划推进" : h === "at_risk" ? "可能延期，需关注" : "明显偏离，需要介入"}</span>
              </button>
            ))}
          </div>
        </Field>
      </div>

      <DialogActions>
        <button type="button" onClick={onClose} className="btn btn-glass">
          取消
        </button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="btn btn-primary disabled:opacity-60">
          发布简报
        </button>
      </DialogActions>
    </Dialog>
  );
}
