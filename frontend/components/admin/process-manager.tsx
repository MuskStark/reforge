"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownWideNarrow,
  ChevronRight,
  Eye,
  FileSignature,
  Globe,
  Hourglass,
  Inbox,
  MapPin,
  Smartphone,
  Trash2,
  User,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { Modal, ModalBody, ModalContent, ModalTrigger } from "@/components/ui/animated-modal";
import { HoverBorderGradient } from "@/components/ui/hover-border-gradient";
import { PlaceholdersAndVanishInput } from "@/components/ui/placeholders-and-vanish-input";
import type { FlowProcess } from "@/lib/types";
import { adminFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

/** 后台管理：已收集流程的查看 / 流程图 / 删除（全部走受保护的管理端 API） */
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
    try {
      await adminFetch(`/api/admin/processes/${p.id}`, { method: "DELETE" });
      toast.success("已删除", { description: `「${p.name}」已删除` });
      void load();
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") {
        onLogout();
        return;
      }
      toast.error("删除失败", { description: "请稍后重试" });
    }
  };

  return (
    <section className="mt-10">
      <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
        <Inbox className="h-4 w-4 text-neutral-400" />
        流程管理
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-normal text-neutral-300">
          {loading ? "…" : processes.length}
        </span>
      </h2>

      {!loading && processes.length === 0 && (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-neutral-500">
          暂无数据，提交第一个流程后在此展示
        </p>
      )}

      {/* 官方 PlaceholdersAndVanishInput：占位轮播搜索框 */}
      <div className="mb-4 flex justify-center">
        <PlaceholdersAndVanishInput
          placeholders={["搜索流程名称…", "按申报人筛选…", "查看已收集的流程"]}
          onChange={(e) => setQuery(e.target.value)}
          onSubmit={(e) => e.preventDefault()}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {processes
          .filter((p) =>
            !query.trim() ||
            p.name.includes(query.trim()) ||
            (p.applicant ?? "").includes(query.trim()),
          )
          .map((p) => (
          <Modal key={p.id}>
          <div className="glass-card flex flex-col justify-between gap-3 p-4 transition-colors hover:border-cyan-400/40 hover:shadow-[0_0_24px_-10px_rgba(34,211,238,0.35)]">
            <div>
              <div className="flex items-center gap-2">
                <ArrowDownWideNarrow className="h-4 w-4 shrink-0 text-cyan-300" />
                <p className="truncate text-sm font-medium text-white">{p.name}</p>
              </div>
              {p.description && (
                <p className="mt-1 line-clamp-1 text-xs text-neutral-500">{p.description}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-neutral-400">
                <span className="rounded-full bg-white/5 px-2 py-0.5">
                  {p.steps.length} 个步骤
                </span>
                <span className="rounded-full bg-white/5 px-2 py-0.5">
                  {p.steps.filter((s) => s.countersign).length} 处会签
                </span>
                <span className="rounded-full bg-white/5 px-2 py-0.5">
                  {p.steps.filter((s) => s.mode === "online").length} 线上 ·{" "}
                  {p.steps.filter((s) => s.mode === "offline").length} 线下
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-data text-[11px] text-[color:var(--flow-muted)]">
                {new Date(p.createdAt).toLocaleString("zh-CN")}
              </span>
              <div className="flex gap-1 sm:gap-1">
                <ModalTrigger className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2.5 text-xs text-neutral-300 transition hover:bg-white/10 hover:text-white sm:px-2 sm:py-1">
                  <Eye className="h-3.5 w-3.5" /> 详情
                </ModalTrigger>
                <button
                  type="button"
                  onClick={() => onPreviewChart(p)}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2.5 text-xs text-cyan-300 transition hover:bg-cyan-500/10 hover:text-cyan-200 sm:px-2 sm:py-1"
                >
                  <Waypoints className="h-3.5 w-3.5" /> 流程图
                </button>
                <button
                  type="button"
                  onClick={() => void remove(p)}
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2.5 text-xs text-neutral-500 transition hover:bg-red-500/10 hover:text-red-400 sm:px-2 sm:py-1"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 删除
                </button>
              </div>
            </div>
          </div>
          <ModalBody className="md:max-w-2xl rounded-[24px] bg-transparent dark:bg-zinc-950/60 backdrop-blur-2xl shadow-2xl">
          <ModalContent className="p-4 md:p-6">
          <div className="space-y-5">
            <div>
              <h3 className="font-display text-lg font-semibold text-white pr-8">{p.name}</h3>
              {p.description && (
                <p className="mt-1 text-sm text-neutral-400">{p.description}</p>
              )}
              {p.applicant && (
                <p className="mt-2 inline-flex items-center gap-1 text-xs text-neutral-500">
                  <User className="h-3 w-3" /> 申报人：{p.applicant}
                </p>
              )}
            </div>

            <ol className="space-y-4">
              {p.steps.map((s, i) => (
                <li key={s.id} className="relative rounded-xl border border-white/10 bg-black/40 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-data flex h-6 w-6 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-500/10 text-xs font-semibold text-cyan-300">
                      {i + 1}
                    </span>
                    <span className="text-sm font-medium text-white">{s.name}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                        s.mode === "online"
                          ? "bg-sky-500/15 text-sky-300"
                          : "bg-emerald-500/15 text-emerald-300",
                      )}
                    >
                      {s.mode === "online" ? (
                        <Globe className="h-3 w-3" />
                      ) : (
                        <MapPin className="h-3 w-3" />
                      )}
                      {s.mode === "online" ? "线上处理" : "线下处理"}
                    </span>
                    {s.countersign && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                        <FileSignature className="h-3 w-3" /> 会签
                      </span>
                    )}
                  </div>

                  <div className="mt-3 space-y-2 text-xs text-neutral-300">
                    {s.waitFor?.stepId && (
                      <p className="inline-flex items-center gap-1 text-sky-300">
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
                          <span className="ml-1 rounded bg-white/5 px-1.5 py-0.5 text-neutral-100">
                            {s.online.systemName}
                          </span>
                        </p>
                        <p className="inline-flex items-center gap-1">
                          移动端：
                          <span
                            className={cn(
                              "ml-1 rounded px-1.5 py-0.5",
                              s.online.mobileSupported
                                ? "bg-emerald-500/15 text-emerald-300"
                                : s.online.mobileSupported === false
                                  ? "bg-white/5 text-neutral-500"
                                  : "bg-amber-500/15 text-amber-300",
                            )}
                          >
                            {s.online.mobileSupported
                              ? "支持"
                              : s.online.mobileSupported === false
                                ? "不支持"
                                : "未选择"}
                          </span>
                          {s.online.mobileSupported && (
                            <Smartphone className="h-3.5 w-3.5 text-emerald-300" />
                          )}
                        </p>
                        {s.online.dataInteroperable != null && (
                          <p>
                            与上步系统数据互通：
                            <span
                              className={cn(
                                "ml-1 rounded px-1.5 py-0.5",
                                s.online.dataInteroperable
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-red-500/15 text-red-300",
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
                                className="ml-1 inline-block rounded bg-white/5 px-1.5 py-0.5 text-neutral-100"
                              >
                                {d}
                              </span>
                            ))
                          ) : (
                            <span className="ml-1 text-neutral-500">无</span>
                          )}
                        </p>
                        <div>
                          <p className="text-neutral-500">经办部门及人员：</p>
                          <ul className="mt-1 space-y-1">
                            {s.offline.handlers.map((h, j) => (
                              <li key={j}>
                                <span className="rounded bg-white/5 px-1.5 py-0.5 text-neutral-100">
                                  {h.department || "未填写部门"}
                                </span>
                                <span className="ml-2 text-neutral-400">
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
                        <p className="text-amber-300/80">会签方（并行）：</p>
                        <ul className="mt-1 space-y-1.5">
                          {(s.parties ?? []).map((h, j) => (
                            <li key={j}>
                              <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-100">
                                {h.department || "未填写部门"}
                              </span>
                              <span className="ml-2 text-neutral-400">
                                {h.staff?.join("、") || "—"}
                              </span>
                              {(h.subSteps ?? []).filter((x) => x?.name).length > 0 && (
                                <div className="ml-6 mt-1.5 space-y-1">
                                  {h.subSteps
                                    .filter((x) => x?.name)
                                    .map((x, k) => (
                                      <div key={x.id ?? k} className="flex items-start gap-1">
                                        <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-neutral-600" />
                                        <span className="text-neutral-200">
                                          {k + 1}. {x.name}
                                        </span>
                                        <span
                                          className={cn(
                                            "ml-1 rounded px-1.5 py-0.5 text-[10px]",
                                            (x.mode ?? "online") === "online"
                                              ? "bg-sky-500/15 text-sky-300"
                                              : "bg-emerald-500/15 text-emerald-300",
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
                    {s.remark && <p className="text-neutral-500">备注：{s.remark}</p>}
                  </div>
                </li>
              ))}
            </ol>


          </div>
          </ModalContent>
          </ModalBody>
          </Modal>
        ))}
      </div>
    </section>
  );
}
