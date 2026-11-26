import type { SessionUser } from "@/lib/auth";
import type { ProjectView, WorkItem } from "@/lib/types";
import { canEditSubmission, iAmPM } from "@/lib/workbench";
import { MODE_LABEL } from "@/lib/labels";
import { awaitingFinal, inIntakeStage, myIntakeAction } from "@/lib/intake";
import { fmtDateTime } from "@/lib/labels";

/**
 * 行动引导:轮到当前登录人操作时,给出一句话说明与直达按钮。
 * 判据只用现成字段(与各处入口同口径),按流程先后取第一个命中的分支;
 * 轮不到时返回 null——行动卡不渲染,页面与现状一致。
 *
 * 分支次序 = 流程先后:完成核准 → 承接(初析/指派/推进/评估/终审) → 普通关卡表决 → PM 推进 → 提交人改单。
 */
export type GuideTone = "blue" | "amber" | "green" | "plain";
export type GuideTab = "overview" | "plan" | "review" | "intake";

export interface ActionGuideItem {
  tone: GuideTone;
  icon: "check" | "list" | "send" | "shield" | "pen";
  title: string;
  detail: string;
  cta: string;
  /** 按钮去哪个标签页;与 editSubmission 二选一 */
  tab?: GuideTab;
  /** 打开提交人改单弹层(自己提交的需求还没被处理时) */
  editSubmission?: boolean;
}

export function guideFor(
  me: SessionUser,
  project: ProjectView,
  missingRequired: WorkItem[],
): ActionGuideItem | null {
  if (project.status !== "active") return null;
  const cur = project.stages[project.currentStage - 1];

  // ---- 完成核准:PM 发起后到 PMO 处形成待办,核准人才有卡(申请人已由概览的琥珀卡覆盖) ----
  if (project.completionStatus === "pending" && project.can.assign) {
    return {
      tone: "green",
      icon: "shield",
      title: `${project.completionRequestedByName || "项目成员"}申请把项目标记为完成，等你核准`,
      detail: [
        project.completionRequestedAt ? `申请于 ${fmtDateTime(project.completionRequestedAt)}` : "",
        project.completionNote ? `说明：${project.completionNote}` : "核准后项目即完成；退回则继续推进",
      ]
        .filter(Boolean)
        .join(" · "),
      tab: "overview",
      cta: "去核准",
    };
  }

  // ---- 需求承接:初析 / 指派 / PM 推进提交 / CTO 评估 / PMO 终审(判定与页头主按钮同口径) ----
  const intakeAction = myIntakeAction(project);
  if (intakeAction) {
    const detail =
      intakeAction === "提交技术可行性评估"
        ? "按「线下转线上 → 系统互通 → 移动化」补齐原因与解决方案；还缺什么，承接页的提交卡会一次列明"
        : intakeAction === "评估技术可行性"
          ? "逐个技术点给出可行 / 有条件可行 / 不可行的结论；附条件要写明条件，不可行给替代方案"
          : intakeAction === "终审"
            ? "技术可行性评估已通过，整体流程与方案交你终审；通过后进入下一阶段"
            : "先完成初级分析（价值 / 复杂度 / 流程完整性），再指派一名或多名 PM；PM 到岗后项目正式启动";
    return {
      tone: intakeAction === "终审" ? "green" : "blue",
      icon: intakeAction === "提交技术可行性评估" ? "send" : "check",
      title: `轮到你${intakeAction}`,
      detail,
      tab: "intake",
      cta: intakeAction === "提交技术可行性评估" ? "去提交" : intakeAction === "评估技术可行性" ? "去评估" : "去处理",
    };
  }

  // ---- 普通关卡表决(承接期上面的"评估技术可行性"已覆盖) ----
  const atIntake = inIntakeStage(project);
  const reviewerOk =
    cur?.reviewerRole === "cto" ? project.can.reviewCTO : cur?.reviewerRole === "handler" ? project.can.reviewHandler : project.can.manage;
  if (!atIntake && cur?.status === "in_review" && cur.gate && !awaitingFinal(project) && reviewerOk) {
    const r = project.review;
    return {
      tone: "blue",
      icon: "check",
      title: `轮到你表决「${cur.gate}」`,
      detail: [
        r?.submittedByName ? `${r.submittedByName} ${fmtDateTime(r.submittedAt)}提交` : "",
        cur.reviewerRole ? `${cur.reviewerRole === "cto" ? "CTO" : "BH"}${MODE_LABEL[cur.mode] ?? ""}` : "",
        "核对提交说明与必交付物完成情况后给出结论，驳回时写明原因",
      ]
        .filter(Boolean)
        .join(" · "),
      tab: "review",
      cta: "去评审",
    };
  }

  // ---- PM 推进:必交付物与评审提交(提交入口在「评审」,清单在「计划」) ----
  if (!atIntake && cur?.status === "in_progress" && cur.gate && project.hasPm && iAmPM(me.id, project)) {
    if (missingRequired.length > 0) {
      return {
        tone: "amber",
        icon: "list",
        title: `还差 ${missingRequired.length} 项必交付物，完成后提交「${cur.gate}」`,
        detail: `缺：${missingRequired.map((i) => i.title).join("、")} · 必交付物未完成时评审提交会被拦住`,
        tab: "plan",
        cta: "去计划",
      };
    }
    if (project.can.manage) {
      return {
        tone: "blue",
        icon: "send",
        title: `必交付物已齐，提交「${cur.gate}」评审`,
        detail: `由${cur.reviewerRole === "cto" ? "CTO" : "BH"}${MODE_LABEL[cur.mode] ?? ""}`,
        tab: "review",
        cta: "提交评审",
      };
    }
  }

  // ---- 提交人(无岗位):自己提交的需求还没被处理时可以修改 ----
  if (canEditSubmission(me.id, project)) {
    return {
      tone: "plain",
      icon: "pen",
      title: "你的需求还在等待初级分析",
      detail: "PMO 完成初级分析并指派 PM 之前，你可以随时修改流程内容 · 开始处理后将锁定，只能查看进度",
      editSubmission: true,
      cta: "修改需求",
    };
  }

  return null;
}
