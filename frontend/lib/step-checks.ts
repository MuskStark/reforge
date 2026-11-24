import type { FlowStep, StepMode } from "./types";

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

/** 会签整体办理方式：由各方已命名的内部子步骤聚合 */
export type OverallMode = StepMode | "mixed" | "unknown";

export const OVERALL_MODE_LABEL: Record<OverallMode, string> = {
  online: "线上",
  offline: "线下",
  mixed: "线上+线下",
  unknown: "未标注",
};

/**
 * 会签整体办理方式：全部子步骤线上 → online，全部线下 → offline，兼有 → mixed；
 * 没有任何已命名子步骤（单步签署）时无从判断 → unknown。
 */
export function countersignMode(step: FlowStep): OverallMode {
  let online = false;
  let offline = false;
  let named = false;
  for (const party of step.parties ?? []) {
    for (const raw of party.subSteps ?? []) {
      const sub = normSub(raw);
      if (!sub.name.trim()) continue;
      named = true;
      if (sub.mode === "offline") offline = true;
      else online = true;
    }
  }
  if (!named) return "unknown";
  if (online && offline) return "mixed";
  return online ? "online" : "offline";
}

/**
 * 线上主步骤 cur 相对上一步 prev 的「异构前置系统」列表（非空 = 须填写数据互通）：
 * 上一步为普通步骤取其系统；为会签则取每一方最后一个已命名子步骤（交接给本步骤的产出环节）的系统。
 * 只保留与本步骤系统不同的，按出现顺序去重。
 */
export function interopSystems(cur: FlowStep | undefined, prev: FlowStep | undefined): string[] {
  if (!cur || cur.countersign || cur.mode !== "online") return [];
  if (!prev) return [];
  const cSys = cur.online.systemName.trim();
  if (!cSys) return [];
  const out: string[] = [];
  const push = (sys: string) => {
    if (sys && sys !== cSys && !out.includes(sys)) out.push(sys);
  };
  if (!prev.countersign) {
    if (prev.mode === "online") push(prev.online.systemName.trim());
    return out;
  }
  for (const party of prev.parties ?? []) {
    const subs = (party.subSteps ?? []).map(normSub).filter((s) => s.name.trim());
    const last = subs[subs.length - 1];
    if (last && last.mode !== "offline") push(last.online.systemName.trim());
  }
  return out;
}

/** 相邻线上-线上系统不同：该步骤需填写数据互通的前置系统列表（供表单显隐与校验；空数组 = 不需要） */
export function needsInteropWithPrev(steps: FlowStep[], index: number): string[] {
  return interopSystems(steps[index], steps[index - 1]);
}

type Sub = ReturnType<typeof normSub>;

/**
 * 会签分支内子步骤 subs[index] 需填写数据互通时的前置子步骤（null = 不需要）：
 * 以「上一个已命名子步骤」为基准（与后端清理空行后的校验一致），二者均线上且系统不同才成立。
 */
export function subInteropPrev(subs: Partial<import("./types").SubStep>[], index: number): Sub | null {
  const cur = normSub(subs[index]);
  if (cur.mode !== "online") return null;
  const cSys = cur.online.systemName.trim();
  // 本步骤尚未选择系统:问题无从提出(系统名称本身另有必填校验)
  if (!cSys) return null;
  for (let k = index - 1; k >= 0; k--) {
    const p = normSub(subs[k]);
    if (!p.name.trim()) continue;
    if (p.mode !== "online") return null;
    const pSys = p.online.systemName.trim();
    return pSys && pSys !== cSys ? p : null;
  }
  return null;
}

/** 会签分支内相邻两个已命名子步骤的衔接是否为断点：线上↔线下切换，或已标注系统数据不互通 */
export function subLinkBroken(
  prev: Partial<import("./types").SubStep>,
  cur: Partial<import("./types").SubStep>,
): boolean {
  const a = normSub(prev);
  const b = normSub(cur);
  const aOff = a.mode === "offline";
  if (aOff !== (b.mode === "offline")) return true;
  if (aOff || b.mode !== "online") return false;
  const pSys = a.online.systemName.trim();
  return !!pSys && pSys !== b.online.systemName.trim() && b.online.dataInteroperable === false;
}

/** 缺失项对应的控件:点提示时据此滚过去并把焦点放进去(id 见 form-focus.ts 的 issueAnchorId) */
export type IssueField =
  | "name" // 步骤名称
  | "system" // 线上处理系统
  | "mobile" // 是否支持移动端
  | "interop" // 与上一步系统的数据互通
  | "handlers" // 线下经办部门及人员
  | "parties" // 会签部门及人员
  | { subId: string; sub: "system" | "mobile" | "interop" | "handlers" }; // 会签方的内部子步骤

export interface StepIssue {
  /** 缺失项说明 */
  text: string;
  field: IssueField;
}

const ONLINE_SUB = "未选择线上系统";
const HANDLER_MISSING = "还没有添加经办部门及人员";

/**
 * 步骤完整度检查：返回还差的必填项（空数组 = 就绪）。与后端校验规则一致。
 * prev 为上一步骤（缺省时跳过依赖上一步的数据互通检查）。
 */
export function stepIssueList(step: FlowStep, prev?: FlowStep): StepIssue[] {
  const issues: StepIssue[] = [];

  if (!step.name.trim()) issues.push({ text: "未填写步骤名称", field: "name" });

  if (step.countersign) {
    if (!step.parties.some(validHandler)) {
      issues.push({ text: "还没有添加会签部门及人员", field: "parties" });
      return issues;
    }
    step.parties.forEach((party, j) => {
      const dept = party.department.trim() || `会签方${j + 1}`;
      (party.subSteps ?? []).forEach((raw, k) => {
        const sub = normSub(raw);
        const subId = raw.id ?? "";
        const where = `「${dept}」的「${sub.name}」`;
        if (!sub.name.trim()) return;
        if (sub.mode === "online") {
          if (!sub.online.systemName.trim())
            issues.push({ text: `${where}${ONLINE_SUB}`, field: { subId, sub: "system" } });
          if (sub.online.mobileSupported == null)
            issues.push({ text: `${where}未选择是否支持移动端`, field: { subId, sub: "mobile" } });
          const p = subInteropPrev(party.subSteps ?? [], k);
          if (p && sub.online.dataInteroperable == null)
            issues.push({ text: `${where}未选择与「${p.name}」的系统是否数据互通`, field: { subId, sub: "interop" } });
        } else if (!sub.offline.handlers.some(validHandler)) {
          issues.push({ text: `${where}${HANDLER_MISSING}`, field: { subId, sub: "handlers" } });
        }
      });
    });
  } else {
    if (step.mode === "online") {
      if (!step.online.systemName.trim()) issues.push({ text: "未选择线上处理系统", field: "system" });
      if (step.online.mobileSupported == null) issues.push({ text: "未选择是否支持移动端", field: "mobile" });
      const prevSys = interopSystems(step, prev);
      if (prevSys.length && step.online.dataInteroperable == null)
        issues.push({ text: `未选择与上一步系统（${prevSys.join("、")}）是否数据互通`, field: "interop" });
    } else if (!step.offline.handlers.some(validHandler)) {
      issues.push({ text: `${HANDLER_MISSING}（线下办理必填）`, field: "handlers" });
    }
  }
  return issues;
}

/** 步骤完整度检查的说明文字列表（空数组 = 就绪） */
export function stepIssues(step: FlowStep, prev?: FlowStep): string[] {
  return stepIssueList(step, prev).map((i) => i.text);
}
