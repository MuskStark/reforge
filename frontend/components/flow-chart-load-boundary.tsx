"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 兜住按需加载的流程图弹窗加载失败的情况（页面打开后正好发了版，旧构建的代码块已不存在；
 * 或网络抖动）。只兜住这一小块，不惊动外层：表单里填到一半的内容原样保留。
 * 关掉提示后下次再点会重新尝试加载。
 */
export class FlowChartLoadBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("流程图组件加载失败", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          role="alertdialog"
          aria-label="流程图加载失败"
          className="fixed inset-0 z-[80] grid place-items-center bg-neutral-900/15 px-4 backdrop-blur-sm"
        >
          <div className="glass-card w-full max-w-sm p-6 text-center">
            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-neutral-900">流程图暂时打不开</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink-2)]">
              页面可能刚更新过，或者网络不太稳定。你填写的内容都还在；
              可以先继续填写或提交，刷新页面后预览会恢复。
            </p>
            <button type="button" className="btn btn-glass mt-4" onClick={this.props.onClose}>
              继续填写
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
