"use client";

/**
 * 流程图弹窗：React Flow 渲染（见 flow-graph.tsx）。
 * 在 AnimatedModal 之上做受控桥接：挂载即打开，用户关闭后回调卸载。
 */

import { useEffect, useRef } from "react";
import { Modal, ModalBody, ModalContent, useModal } from "@/components/ui/animated-modal";
import { FlowGraph } from "@/components/flow-graph";
import { type ChartSource } from "@/components/flow-graph";

export type { ChartSource };

/** 在官方 Modal 之上做受控桥接：挂载即打开 */
function AutoOpenController({ onClose }: { onClose: () => void }) {
  const { open, setOpen } = useModal();
  const openedOnce = useRef(false);
  useEffect(() => {
    setOpen(true);
  }, [setOpen]);
  useEffect(() => {
    if (open) openedOnce.current = true;
    else if (openedOnce.current) onClose();
  }, [open, onClose]);
  return null;
}

/** 流程图弹窗(玻璃 Sheet) */
export function FlowChartModal({
  onClose,
  source,
}: {
  onClose: () => void;
  source: ChartSource;
}) {
  return (
    <Modal>
      <AutoOpenController onClose={onClose} />
      <ModalBody className="md:max-w-4xl">
        <ModalContent className="p-4 md:p-6">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pr-8">
              <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-neutral-900">
                流程图 — {source.name || "未命名流程"}
              </h2>
              <div className="ml-auto flex flex-wrap gap-1.5">
                <span className="badge badge-blue"><span className="dot" />线上</span>
                <span className="badge badge-green"><span className="dot" style={{ background: "var(--green)" }} />线下</span>
                <span className="badge badge-amber">▣ 会签 · 旁路并行 · 全部通过后汇回主干</span>
                <span className="badge badge-plain" style={{ color: "#6e7a8c" }}>- -&nbsp;▶&nbsp;线上↔线下衔接 / 系统数据不互通</span>
                <span className="badge badge-indigo">- -&nbsp;▶&nbsp;等待会签结果</span>
              </div>
            </div>

            <FlowGraph source={source} />
            <p className="mt-2 text-center text-[11px] text-[color:var(--ink-3)] sm:hidden">
              双指缩放 · 拖动查看完整图
            </p>
          </div>
        </ModalContent>
      </ModalBody>
    </Modal>
  );
}
