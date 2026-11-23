"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Eye,
  FileSignature,
  Globe,
  Hourglass,
  MapPin,
  Search,
  Smartphone,
  Trash2,
  User,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { Modal, ModalBody, ModalContent, ModalTrigger } from "@/components/ui/animated-modal";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { CountersignModeBadge } from "@/components/countersign-mode-badge";
import { countersignMode } from "@/lib/step-checks";
import type { FlowProcess } from "@/lib/types";
import { adminFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * 后台管理(液态玻璃):已收集流程的查看 / 流程图 / 删除(全部走受保护的管理端 API)。
 * 删除会连同流程项目及其全部记录一起删(见后端 postgresStore.Delete),所以必须先确认。
 */
export function ProcessManager({
  onLogout,
  onPreviewChart,
}: {
  onLogout: () => void;
  onPreviewChart: (p: FlowProcess) => void;
}) {
  const [processes, setProcesses] = useState<FlowProcess[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [askRemove, setAskRemove] = useState<FlowProcess | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setProcesses(await adminFetch<FlowProcess[]>("/api/admin/processes", { cache: "no-store" }));
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        onLogout();
        return;
      }
      toast.error("读取失败", { description: "无法从后端获取已收集的流程" });
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (p: FlowProcess) => {
    setRemoving(true);
    try {
      await adminFetch(`/api/admin/processes/${p.id}`, { method: "DELETE" });
      toast.success("已删除", { description: `「${p.name}」及其流程项目已删除` });
      setAskRemove(null);
      void load();
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        onLogout();
        return;
      }
      toast.error("删除失败", { description: "请稍后重试" });
    } finally {
      setRemoving(false);
    }
  };

  const filtered = processes.filter(
    (p) =>
      !query.trim() ||
      p.name.includes(query.trim()) ||
      (p.applicant ?? "").includes(query.trim()),
  );

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="text-[22px] font-bold tracking-[-0.02em]">流程管理</h2>
        <span className="badge badge-plain">
          {loading ? "…" : `${processes.length} 条`}
        </span>
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--ink-3)]" />
          <input
            className="field pl-10"
            placeholder="搜索流程名称、申报人"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索流程"
          />
        </div>
      </div>

      {!loading && processes.length === 0 && (
        <p className="glass-card px-5 py-10 text-center text-sm text-[color:var(--ink-3)]">
          暂无数据，提交第一个流程后在此展示
        </p>
      )}

      <div className="glass-card space-y-0.5 p-1.5">
        {filtered.map((p) => {
          const countersignN = p.steps.filter((s) => s.countersign).length;
          const waitForN = p.steps.filter((s) => s.waitFor?.stepId).length;
          return (
          <Modal key={p.id}>
          <div className="group flex items-center gap-3.5 rounded-[18px] px-3.5 py-3.5 transition-colors hover:bg-white/45 sm:px-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-[16px] font-semibold text-neutral-900">{p.name}</p>
                {countersignN > 0 && (
                  <span className="badge badge-amber !h-[20px]"><span className="dot" />会签 {countersignN}</span>
                )}
              </div>
              <div className="font-data mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[color:var(--ink-2)]">
                <span>{p.steps.length} 个步骤</span>
                {waitForN > 0 && <span>前置依赖 {waitForN} 项</span>}
                <span>{new Date(p.updatedAt ?? p.createdAt).toLocaleString("zh-CN")}</span>
              </div>
            </div>
            {/* 申报人头像 */}
            <span
              aria-hidden="true"
              className="hidden h-[38px] w-[38px] shrink-0 place-items-center rounded-full text-[13px] font-semibold sm:grid"
              style={{ background: "linear-gradient(180deg,#b8ccff,#9db4ff)", color: "#21407a" }}
              title={p.applicant ? `申报人:${p.applicant}` : undefined}
            >
              {(p.applicant || p.name || "?").slice(0, 1)}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <ModalTrigger
                className="!h-11 !w-11 !p-0 sm:!h-9 sm:!w-9"
                aria-label={`查看 ${p.name} 详情`}
              >
                <Eye className="mx-auto h-4 w-4 text-[color:var(--ink-2)] group-hover:text-neutral-900" />
              </ModalTrigger>
              <button
                type="button"
                onClick={() => onPreviewChart(p)}
                className="icon-btn !h-11 !w-11 sm:!h-9 sm:!w-9"
                aria-label={`查看 ${p.name} 流程图`}
                title="流程图"
              >
                <Waypoints className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setAskRemove(p)}
                className="icon-btn icon-danger !h-11 !w-11 sm:!h-9 sm:!w-9"
                aria-label={`删除 ${p.name}`}
                title="删除"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
          <ModalBody className="md:max-w-2xl">
          <ModalContent className="p-4 md:p-6">
          <div className="space-y-5">
            <div>
              <h3 className="pr-8 text-[19px] font-bold tracking-[-0.02em]">{p.name}</h3>
              {p.description && (
                <p className="mt-1 text-sm text-[color:var(--ink-2)]">{p.description}</p>
              )}
              {p.applicant && (
                <p className="mt-2 inline-flex items-center gap-1 text-xs text-[color:var(--ink-2)]">
                  <User className="h-3 w-3" /> 申报人：{p.applicant}
                </p>
              )}
            </div>

            <ol className="space-y-3">
              {p.steps.map((s, i) => (
                <li key={s.id} className="rounded-2xl bg-white/55 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "font-data flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                        s.countersign
                          ? "rotate-45 bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]"
                          : "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
                      )}
                    >
                      <span className={s.countersign ? "-rotate-45" : undefined}>{i + 1}</span>
                    </span>
                    <span className="text-sm font-semibold text-neutral-900">{s.name}</span>
                    {/* 办理方式:普通步骤读自身 mode;会签读由各方内部子步骤汇总的整体办理方式 */}
                    {s.countersign ? (
                      <CountersignModeBadge mode={countersignMode(s)} className="!h-[20px]" />
                    ) : (
                      <span className={cn("badge !h-[20px]", s.mode === "online" ? "badge-blue" : "badge-green")}>
                        {s.mode === "online" ? <Globe className="h-3 w-3" /> : <MapPin className="h-3 w-3" />}
                        {s.mode === "online" ? "线上处理" : "线下处理"}
                      </span>
                    )}
                    {s.countersign && (
                      <span className="badge badge-amber !h-[20px]">
                        <FileSignature className="h-3 w-3" /> 会签
                      </span>
                    )}
                  </div>

                  <div className="mt-3 space-y-2 text-xs text-neutral-700">
                    {s.waitFor?.stepId && (
                      <p className="inline-flex items-center gap-1 text-[color:var(--indigo-deep)]">
                        <Hourglass className="h-3 w-3" />
                        前置条件：等待「
                        {p.steps.find((x) => x.id === s.waitFor!.stepId)?.name ?? "?"}」
                        {s.waitFor.partyId
                          ? `的「${
                              p.steps
                                .find((x) => x.id === s.waitFor!.stepId)
                                ?.parties?.find((pt) => pt.id === s.waitFor!.partyId)?.department ?? "?"
                            }」分支`
                          : "整个会签"}
                        通过后执行
                      </p>
                    )}
                    {!s.countersign && (s.mode === "online" ? (
                      <>
                        <p>
                          处理系统：
                          <span className="ml-1 rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">
                            {s.online.systemName}
                          </span>
                        </p>
                        <p className="inline-flex items-center gap-1">
                          移动端：
                          <span
                            className={cn(
                              "ml-1 rounded-lg px-1.5 py-0.5 font-medium",
                              s.online.mobileSupported
                                ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]"
                                : s.online.mobileSupported === false
                                  ? "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-2)]"
                                  : "bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]",
                            )}
                          >
                            {s.online.mobileSupported
                              ? "支持"
                              : s.online.mobileSupported === false
                                ? "不支持"
                                : "未选择"}
                          </span>
                          {s.online.mobileSupported && (
                            <Smartphone className="h-3.5 w-3.5 text-[color:var(--green)]" />
                          )}
                        </p>
                        {s.online.dataInteroperable != null && (
                          <p>
                            与上步系统数据互通：
                            <span
                              className={cn(
                                "ml-1 rounded-lg px-1.5 py-0.5 font-medium",
                                s.online.dataInteroperable
                                  ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]"
                                  : "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]",
                              )}
                            >
                              {s.online.dataInteroperable ? "互通" : "不互通"}
                            </span>
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p>
                          涉及文件：
                          {s.offline.documents.length ? (
                            s.offline.documents.map((d) => (
                              <span
                                key={d}
                                className="ml-1 inline-block rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]"
                              >
                                {d}
                              </span>
                            ))
                          ) : (
                            <span className="ml-1 text-[color:var(--ink-3)]">无</span>
                          )}
                        </p>
                        <div>
                          <p className="text-[color:var(--ink-3)]">经办部门及人员：</p>
                          <ul className="mt-1 space-y-1">
                            {s.offline.handlers.map((h, j) => (
                              <li key={j}>
                                <span className="rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">
                                  {h.department || "未填写部门"}
                                </span>
                                <span className="ml-2 text-[color:var(--ink-2)]">
                                  {h.staff.join("、") || "—"}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </>
                    ))}
                    {s.countersign && (
                      <div>
                        <p className="font-medium text-[color:var(--amber-deep)]">会签方（并行）：</p>
                        <ul className="mt-1 space-y-1.5">
                          {(s.parties ?? []).map((h, j) => (
                            <li key={j}>
                              <span className="rounded-lg bg-[color:var(--amber-soft)] px-1.5 py-0.5 font-medium text-[color:var(--amber-deep)]">
                                {h.department || "未填写部门"}
                              </span>
                              <span className="ml-2 text-[color:var(--ink-2)]">
                                {h.staff?.join("、") || "—"}
                              </span>
                              {(h.subSteps ?? []).filter((x) => x?.name).length > 0 && (
                                <div className="ml-6 mt-1.5 space-y-1">
                                  {h.subSteps
                                    .filter((x) => x?.name)
                                    .map((x, k) => (
                                      <div key={x.id ?? k} className="flex flex-wrap items-start gap-1">
                                        <span className="text-[color:var(--amber-deep)]">{k + 1}.</span>
                                        <span className="text-neutral-800">{x.name}</span>
                                        <span
                                          className={cn(
                                            "badge !h-[18px] !px-1.5 text-[10px]",
                                            (x.mode ?? "online") === "online"
                                              ? "badge-blue"
                                              : "badge-green",
                                          )}
                                        >
                                          {(x.mode ?? "online") === "online"
                                            ? `线上${x.online?.systemName ? ` · ${x.online.systemName}` : ""}${
                                                x.online?.mobileSupported ? " · 支持移动端" : ""
                                              }`
                                            : `线下${
                                                x.offline?.documents?.length
                                                  ? ` · ${x.offline.documents.join("、")}`
                                                  : ""
                                              }${
                                                x.offline?.handlers?.length
                                                  ? ` · ${x.offline.handlers
                                                      .map((hd) => hd.department)
                                                      .filter(Boolean)
                                                      .join("、")}办理`
                                                  : ""
                                              }`}
                                        </span>
                                      </div>
                                    ))}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.remark && <p className="text-[color:var(--ink-3)]">备注：{s.remark}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
          </ModalContent>
          </ModalBody>
          </Modal>
          );
        })}
      </div>

      {askRemove && (
        <Dialog onClose={() => setAskRemove(null)} labelledBy="process-remove-title">
          <DialogHeader id="process-remove-title" title={`删除流程「${askRemove.name}」？`} subtitle="无法恢复。" onClose={() => setAskRemove(null)} />
          <div className="mt-4 rounded-2xl bg-[color:var(--red-soft)] px-4 py-3 text-[13px] leading-relaxed text-[color:var(--red-deep)]">
            流程提交后已自动立为流程项目。删除会一并删掉它的项目及全部记录：阶段进度、评审与表决、工作项、评论与简报、流程版本快照和动态时间线。
            如果只是不想再推进，可以在项目页「取消」或「搁置」项目，记录会保留。
          </div>
          <DialogActions>
            <button type="button" onClick={() => setAskRemove(null)} disabled={removing} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => void remove(askRemove)} disabled={removing} className="btn btn-glass text-[color:var(--red-deep)] disabled:opacity-50">
              <Trash2 className="h-4 w-4" /> {removing ? "删除中…" : "确认删除"}
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
