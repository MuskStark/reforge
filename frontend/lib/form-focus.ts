import type { IssueField } from "./step-checks";

const FIELD_PREFIX: Record<Exclude<IssueField, { subId: string }>, string> = {
  name: "step-name",
  system: "sys",
  mobile: "mobile",
  interop: "interop",
  handlers: "handlers",
  parties: "parties",
};

const SUB_PREFIX: Record<{ subId: string; sub: "system" | "mobile" | "interop" | "handlers" }["sub"], string> = {
  system: "sub-sys",
  mobile: "sub-mobile",
  interop: "sub-interop",
  handlers: "sub-handlers",
};

/** 会签子步骤里控件的锚点 id(只取决于子步骤自身,不依赖所属步骤) */
export function subAnchorId(subId: string, sub: "system" | "mobile" | "interop" | "handlers"): string {
  return `${SUB_PREFIX[sub]}-${subId}`;
}

/** 缺失项对应控件的 DOM id:各控件渲染时挂上,提示条按它定位 */
export function issueAnchorId(stepId: string, field: IssueField): string {
  if (typeof field === "string") return `${FIELD_PREFIX[field]}-${stepId}`;
  return subAnchorId(field.subId, field.sub);
}

/**
 * 跳到某个缺失项:滚到对应控件、把焦点放进输入框(没有输入框时退而取第一个按钮),并闪一下标出位置。
 * 延迟一拍再执行,等弹层先关闭(body 的 overflow 恢复后滚动才生效)。
 */
export function focusAnchor(id: string | null) {
  if (!id) return;
  window.setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const control = el.matches("input,select,textarea")
      ? el
      : el.querySelector<HTMLElement>("input,select,textarea") ?? el.querySelector<HTMLElement>("button");
    control?.focus({ preventScroll: true });
    el.classList.remove("flash-target");
    void el.offsetWidth; // 重新触发动画
    el.classList.add("flash-target");
    window.setTimeout(() => el.classList.remove("flash-target"), 1600);
  }, 80);
}
