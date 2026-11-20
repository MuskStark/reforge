import type { FlowStep } from "./types";

/** 规范化后的会签方子步骤校验 */
function subIssues(dept: string, sub: { name: string; mode: string; online: { systemName: string }; offline: { handlers: { department: string; staff: string[] }[] } }): string[] {
  if (!sub.name.trim()) return [];
  const issues: string[] = [];
  if (sub.mode === "online" && !sub.online.systemName.trim()) {
    issues.push(`「${dept}」子步骤「${sub.name}」未填线上系统`);
  }
  if (sub.mode === "offline") {
    const ok = sub.offline.handlers.some(
      (h) => h.department.trim() || h.staff.some((x) => x.trim()),
    );
    if (!ok) issues.push(`「${dept}」子步骤「${sub.name}」未填经办部门`);
  }
  return issues;
}

/** 步骤完整度检查：返回缺失项描述列表（空数组 = 就绪）。
 * 与后端 validateProcess 规则一致，用于收集界面的实时就绪徽章。 */
export function stepIssues(step: FlowStep): string[] {
  const issues: string[] = [];
  const validHandler = (h: { department: string; staff: string[] }) =>
    h.department.trim() || h.staff.some((x) => x.trim());

  if (step.countersign) {
    if (!step.parties.some(validHandler)) {
      issues.push("未添加会签方");
      return issues;
    }
    step.parties.forEach((party, j) => {
      const dept = party.department.trim() || `会签方${j + 1}`;
      (party.subSteps ?? []).forEach((raw) => {
        const sub = {
          name: raw?.name ?? "",
          mode: raw?.mode ?? "online",
          online: raw?.online ?? { systemName: "" },
          offline: raw?.offline ?? { handlers: [] },
        };
        issues.push(...subIssues(dept, sub));
      });
    });
  } else {
    if (step.mode === "online" && !step.online.systemName.trim()) {
      issues.push("未填线上系统名称");
    }
    if (step.mode === "offline" && !step.offline.handlers.some(validHandler)) {
      issues.push("未填经办部门及人员");
    }
  }
  if (step.waitFor?.stepId && !issues.length) {
    // 依赖合法性由提交校验兜底，这里不重复提示
  }
  return issues;
}
