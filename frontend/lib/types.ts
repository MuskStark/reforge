import { genId } from "@/lib/utils";

export type StepMode = "online" | "offline";

/** 经办方：部门 + 涉及人员（线下办理用） */
export interface Handler {
  department: string;
  staff: string[];
}

/** 会签方内部的子步骤（会签内部可能存在多步），与主步骤同样采集线上/线下属性 */
export interface SubStep {
  id: string;
  name: string;
  mode: StepMode;
  online: OnlineInfo;
  offline: OfflineInfo;
}

/** 会签方：部门 + 涉及人员 + 内部子步骤（各方并行、内部顺序执行） */
export interface CountersignParty {
  id: string;
  department: string;
  staff: string[];
  subSteps: SubStep[];
}

export interface OnlineInfo {
  systemName: string;
  /** 是否支持移动端：必选（null=未选择） */
  mobileSupported: boolean | null;
  /** 与前一线上节点的系统是否数据互通：相邻系统不同时必填（null=未填写） */
  dataInteroperable?: boolean | null;
}

export interface OfflineInfo {
  documents: string[];
  handlers: Handler[];
}

/** 管理员维护的线上系统库条目（前台表单下拉选择） */
export interface SystemOption {
  id: string;
  name: string;
}

/** 前置会签依赖：等待指定会签步骤（可选：仅某个会签方）通过后方可执行 */
export interface WaitFor {
  stepId: string;
  partyId?: string;
}

export interface FlowStep {
  id: string;
  name: string;
  mode: StepMode;
  countersign: boolean;
  online: OnlineInfo;
  offline: OfflineInfo;
  parties: CountersignParty[];
  waitFor: WaitFor | null;
  remark: string;
}

export interface FlowProcess {
  id: string;
  name: string;
  description: string;
  applicant: string;
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

export function emptyHandler(): Handler {
  return { department: "", staff: [] };
}

export function emptySubStep(): SubStep {
  return {
    id: genId(),
    name: "",
    mode: "online",
    online: { systemName: "", mobileSupported: null },
    offline: { documents: [], handlers: [] },
  };
}

/** 旧数据兜底：缺省 mode/online/offline 的子步骤补默认值 */
export function normalizeSubStep(s: Partial<SubStep>): SubStep {
  return {
    id: s.id ?? genId(),
    name: s.name ?? "",
    mode: s.mode ?? "online",
    online: s.online ?? { systemName: "", mobileSupported: null },
    offline: s.offline ?? { documents: [], handlers: [] },
  };
}

export function emptyParty(): CountersignParty {
  return { id: genId(), department: "", staff: [], subSteps: [emptySubStep()] };
}

/** 旧数据（无 subSteps 字段）读取兜底 */
export function normalizeParty(p: Partial<CountersignParty>): CountersignParty {
  return {
    id: p.id ?? genId(),
    department: p.department ?? "",
    staff: p.staff ?? [],
    subSteps: (p.subSteps ?? [])
      .filter((s) => s && s.name)
      .map((s) => normalizeSubStep(s)),
  };
}

export function emptyStep(name = "", id = genId()): FlowStep {
  return {
    id,
    name,
    mode: "online",
    countersign: false,
    online: { systemName: "", mobileSupported: null },
    offline: { documents: [], handlers: [] },
    parties: [],
    waitFor: null,
    remark: "",
  };
}

export function emptyProcess(): { name: string; description: string; applicant: string; steps: FlowStep[] } {
  return {
    name: "",
    description: "",
    applicant: "",
    // 首屏初始步骤用固定 id，保证 SSR 与 CSR 一致（后续新增步骤仅在客户端生成随机 id）
    steps: [emptyStep("", "step-initial")],
  };
}
