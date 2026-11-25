"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, FileSignature, Globe, Hourglass, MapPin, Pencil, Search, Smartphone, Trash2, User, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogActions, DialogHeader } from "@/components/ui/dialog";
import { DataTable, type DataColumn, type DataRow } from "@/components/ui/data-table";
import { ControlledModal } from "@/components/ui/controlled-modal";
import { CountersignModeBadge } from "@/components/countersign-mode-badge";
import { SearchBox } from "@/components/ui/search-box";
import { Avatar } from "@/components/projects/stage-rail";
import { PageHead, StateLine } from "@/components/shell/app-shell";
import { countersignMode } from "@/lib/step-checks";
import { fmtDateTime } from "@/lib/labels";
import { ADMIN_SECTION_META } from "@/lib/shell-nav";
import type { FlowProcess } from "@/lib/types";
import { adminFetch } from "@/lib/auth";
import { cn } from "@/lib/utils";

const COLUMNS: DataColumn[] = [
  { key: "name", header: "流程", wide: true },
  { key: "steps", header: "步骤", align: "right" },
  { key: "countersign", header: "会签" },
  { key: "applicant", header: "申报人" },
  { key: "time", header: "提交时间" },
  { key: "actions", header: "操作" },
];
const ACTIONS = 5;

/**
 * 后台 · 流程定义:已收集流程的查看 / 流程图 / 编辑 / 删除(全部走受保护的管理端 API)。
 * 编辑走和项目页同一个表单编辑器,弹层挂在外层(卡片带背景模糊,会困住 fixed 的弹层),保存后由外层通知这里重读列表。
 * 删除会连同流程项目及其全部记录一起删(见后端 postgresStore.Delete),所以必须先确认。
 */
export function ProcessManager({
  onPreviewChart,
  onEdit,
  reloadKey = 0,
}: {
  onPreviewChart: (p: FlowProcess) => void;
  onEdit: (p: FlowProcess) => void;
  /** 每次保存流程定义后加一,列表跟着重读 */
  reloadKey?: number;
}) {
  const [processes, setProcesses] = useState<FlowProcess[] | null>(null);
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<FlowProcess | null>(null);
  const [askRemove, setAskRemove] = useState<FlowProcess | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setProcesses(await adminFetch<FlowProcess[]>("/api/admin/processes", { cache: "no-store" }));
    } catch (e) {
      // 会话失效由外壳处理
      if (!(e instanceof Error && e.message === "UNAUTHORIZED")) toast.error("读取失败", { description: "无法从后端获取已收集的流程" });
      setProcesses((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 首次渲染由上面那个 effect 读取;这里只在保存后(reloadKey 变化)重读
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    void load();
  }, [reloadKey, load]);

  const remove = async (p: FlowProcess) => {
    setRemoving(true);
    try {
      await adminFetch(`/api/admin/processes/${p.id}`, { method: "DELETE" });
      toast.success("已删除", { description: `「${p.name}」及其流程项目已删除` });
      setAskRemove(null);
      void load();
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") return;
      // 把真实原因显示出来:是网络断了、被网关拦了,还是后端拒绝了(见 lib/auth.ts 的 transportError)
      toast.error("删除失败", { description: e instanceof Error && e.message ? e.message : "请稍后重试" });
    } finally {
      setRemoving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim();
    return (processes ?? []).filter((p) => !q || p.name.includes(q) || (p.applicant ?? "").includes(q));
  }, [processes, query]);

  const rows: DataRow[] = filtered.map((p) => {
    const countersignN = p.steps.filter((s) => s.countersign).length;
    const waitForN = p.steps.filter((s) => s.waitFor?.stepId).length;
    return {
      key: p.id,
      cells: [
        <div key="name">
          <div className="cell-main">{p.name}</div>
          {p.description && <div className="cell-sub">{p.description}</div>}
          {waitForN > 0 && <div className="cell-sub">前置依赖 {waitForN} 项</div>}
        </div>,
        <span key="steps" className="cell-num">
          {p.steps.length}
        </span>,
        countersignN > 0 ? (
          <span key="countersign" className="badge badge-amber !h-[20px] !px-2 text-[11px]">
            {countersignN} 处
          </span>
        ) : (
          <span key="countersign" className="cell-sub">
            —
          </span>
        ),
        <span key="applicant" className="cell-person">
          <Avatar name={p.applicant || "?"} size={28} />
          <span className="cell-main">{p.applicant || "—"}</span>
        </span>,
        <span key="time" className="cell-num">
          {fmtDateTime(p.updatedAt ?? p.createdAt)}
        </span>,
        <span key="actions" className="row-actions">
          <button type="button" onClick={() => setViewing(p)} aria-label={`查看 ${p.name} 详情`} title="查看详情" className="icon-btn">
            <Eye className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => onPreviewChart(p)} aria-label={`查看 ${p.name} 流程图`} title="流程图" className="icon-btn">
            <Waypoints className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => onEdit(p)} aria-label={`编辑 ${p.name}`} title="编辑流程" className="icon-btn">
            <Pencil className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setAskRemove(p)} aria-label={`删除 ${p.name}`} title="删除" className="icon-btn icon-danger">
            <Trash2 className="h-4 w-4" />
          </button>
        </span>,
      ],
    };
  });

  return (
    <section>
      <PageHead title={ADMIN_SECTION_META.processes.title} subtitle={ADMIN_SECTION_META.processes.lede} />

      {processes === null ? (
        <StateLine>加载中…</StateLine>
      ) : processes.length === 0 ? (
        <section className="glass-card px-5 py-14 text-center">
          <p className="text-[15px] font-semibold text-neutral-900">还没有收集到流程</p>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink-2)]">到流程收集表提交第一条流程后，会出现在这里。</p>
        </section>
      ) : (
        <>
          <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
            <SearchBox value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索流程名称、申报人" />
            <span className="ml-auto text-[13px] text-[color:var(--ink-2)]">
              {query.trim() ? `找到 ${filtered.length} 条，共 ${processes.length} 条` : `共 ${processes.length} 条`}
            </span>
          </div>

          <div className="glass-card !rounded-[22px] p-1.5 sm:p-2">
            <DataTable columns={COLUMNS} rows={rows} label="已收集的流程" actionsIndex={ACTIONS} />
            {filtered.length === 0 && <p className="px-5 py-10 text-center text-sm text-[color:var(--ink-3)]">没有符合搜索条件的流程</p>}
          </div>
        </>
      )}

      {/* 详情弹层:一次只开一个,且渲染在列表卡片之外 */}
      {viewing && (
        <ControlledModal onClose={() => setViewing(null)} bodyClassName="md:max-w-2xl" contentClassName="p-4 md:p-6" label={`流程详情：${viewing.name}`}>
          <ProcessDetail p={viewing} />
        </ControlledModal>
      )}

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

/** 一条流程的详情:基本信息 + 按顺序列出每个步骤的办理方式 */
function ProcessDetail({ p }: { p: FlowProcess }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="pr-8 text-[19px] font-bold tracking-[-0.02em]">{p.name}</h3>
        {p.description && <p className="mt-1 text-sm text-[color:var(--ink-2)]">{p.description}</p>}
        {p.applicant && (
          <p className="mt-2 inline-flex items-center gap-1 text-xs text-[color:var(--ink-2)]">
            <User className="h-3 w-3" /> 申报人：{p.applicant}
          </p>
        )}
      </div>

      <ol className="space-y-3">
        {p.steps.map((s, i) => (
          <li key={s.id || `step-${i}`} className="rounded-2xl bg-white/55 p-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "font-data flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                  s.countersign ? "rotate-45 bg-[color:var(--amber-soft)] text-[color:var(--amber-deep)]" : "bg-[color:var(--tint-soft)] text-[color:var(--tint-deep)]",
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
                    ? `的「${p.steps.find((x) => x.id === s.waitFor!.stepId)?.parties?.find((pt) => pt.id === s.waitFor!.partyId)?.department ?? "?"}」分支`
                    : "整个会签"}
                  通过后执行
                </p>
              )}
              {!s.countersign &&
                (s.mode === "online" ? (
                  <>
                    <p>
                      处理系统：
                      <span className="ml-1 rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">{s.online.systemName}</span>
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
                        {s.online.mobileSupported ? "支持" : s.online.mobileSupported === false ? "不支持" : "未选择"}
                      </span>
                      {s.online.mobileSupported && <Smartphone className="h-3.5 w-3.5 text-[color:var(--green)]" />}
                    </p>
                    {s.online.dataInteroperable != null && (
                      <p>
                        与上步系统数据互通：
                        <span className={cn("ml-1 rounded-lg px-1.5 py-0.5 font-medium", s.online.dataInteroperable ? "bg-[color:var(--green-soft)] text-[color:var(--green-deep)]" : "bg-[color:var(--red-soft)] text-[color:var(--red-deep)]")}>
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
                          <span key={d} className="ml-1 inline-block rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">
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
                            <span className="rounded-lg bg-white/80 px-1.5 py-0.5 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]">{h.department || "未填写部门"}</span>
                            <span className="ml-2 text-[color:var(--ink-2)]">{h.staff.join("、") || "—"}</span>
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
                        <span className="rounded-lg bg-[color:var(--amber-soft)] px-1.5 py-0.5 font-medium text-[color:var(--amber-deep)]">{h.department || "未填写部门"}</span>
                        <span className="ml-2 text-[color:var(--ink-2)]">{h.staff?.join("、") || "—"}</span>
                        {(h.subSteps ?? []).filter((x) => x?.name).length > 0 && (
                          <div className="ml-6 mt-1.5 space-y-1">
                            {h.subSteps
                              .filter((x) => x?.name)
                              .map((x, k) => (
                                <div key={x.id ?? k} className="flex flex-wrap items-start gap-1">
                                  <span className="text-[color:var(--amber-deep)]">{k + 1}.</span>
                                  <span className="text-neutral-800">{x.name}</span>
                                  <span className={cn("badge !h-[18px] !px-1.5 text-[10px]", (x.mode ?? "online") === "online" ? "badge-blue" : "badge-green")}>
                                    {(x.mode ?? "online") === "online"
                                      ? `线上${x.online?.systemName ? ` · ${x.online.systemName}` : ""}${x.online?.mobileSupported ? " · 支持移动端" : ""}`
                                      : `线下${x.offline?.documents?.length ? ` · ${x.offline.documents.join("、")}` : ""}${
                                            x.offline?.handlers?.length ? ` · ${x.offline.handlers.map((hd) => hd.department).filter(Boolean).join("、")}办理` : ""
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
  );
}
