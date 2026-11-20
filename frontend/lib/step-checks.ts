import type { FlowStep } from "./types";

/** 规范化子步骤（容忍旧数据缺字段） */
function normSub(raw: Partial<import("./types").SubStep>) {
  return {
    name: raw?.name ?? "",
    mode: (raw?.mode ?? "online") as "online" | "offline",
    online: raw?.online ?? { systemName: "", mobileSupported: null },
    offline: raw?.offline ?? { documents: [], handlers: [] },
  };
}

const validHandler = (h: { department: string; staff: string[] }) =>
  h.department.trim() || h.staff.some((x) => x.trim());

/** 步骤完整度检查：返回缺失项描述列表（空数组 = 就绪）。与后端校验规则一致。 */
export function stepIssues(step: FlowStep): string[] {
  const issues: string[] = [];

  if (step.countersign) {
    if (!step.parties.some(validHandler)) {
      issues.push("未添加会签方");
      return issues;
    }
    step.parties.forEach((party, j) => {
      const dept = party.department.trim() || `会签方${j + 1}`;
      const subs = (party.subSteps ?? []).map(normSub);
      subs.forEach((sub, k) => {
        if (!sub.name.trim()) return;
        if (sub.mode === "online") {
          if (!sub.online.systemName.trim())
            issues.push(`「${dept}」子步骤「${sub.name}」未填线上系统`);
          if (sub.online.mobileSupported == null)
            issues.push(`「${dept}」子步骤「${sub.name}」未选择是否支持移动端`);
          if (k > 0) {
            const prev = subs[k - 1];
            const pSys = prev.mode === "online" ? prev.online.systemName.trim() : "";
            if (pSys && pSys !== sub.online.systemName.trim() && sub.online.dataInteroperable == null)
              issues.push(`「${dept}」「${prev.name} → ${sub.name}」未选择系统数据互通`);
          }
        } else if (!sub.offline.handlers.some(validHandler)) {
          issues.push(`「${dept}」子步骤「${sub.name}」未填经办部门`);
        }
      });
    });
  } else {
    if (step.mode === "online") {
      if (!step.online.systemName.trim()) issues.push("未填线上系统名称");
      if (step.online.mobileSupported == null)
        issues.push("未选择是否支持移动端");
    } else if (!step.offline.handlers.some(validHandler)) {
      issues.push("未填经办部门及人员");
    }
  }
  return issues;
}

/** 相邻线上-线上系统不同：该步骤是否需要填数据互通（供表单显隐） */
export function needsInteropWithPrev(steps: FlowStep[], index: number): string | null {
  const cur = steps[index];
  if (!cur || cur.countersign || cur.mode !== "online") return null;
  if (index === 0) return null;
  const prev = steps[index - 1];
  if (prev.countersign || prev.mode !== "online") return null;
  const pSys = prev.online.systemName.trim();
  const cSys = cur.online.systemName.trim();
  if (!pSys || pSys === cSys) return null;
  return pSys;
}
