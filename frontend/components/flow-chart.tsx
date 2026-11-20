"use client";

/**
 * 流程图弹窗：React Flow 渲染（见 flow-graph.tsx）。
 * 在官方 AnimatedModal 之上做受控桥接：挂载即打开，用户关闭后回调卸载。
 */

import { useEffect, useRef, useState } from "react";
import { Modal, ModalBody, ModalContent, useModal } from "@/components/ui/animated-modal";
import { FlowGraph } from "@/components/flow-graph";
import { type ChartSource } from "@/components/flow-graph";

export type { ChartSource };

/** 在官方 Modal 之上做受控桥接：挂载即打开，用户关闭后回调卸载 */
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

/** 流程图弹窗 */
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
      <ModalBody className="md:max-w-4xl rounded-[24px] bg-transparent dark:bg-zinc-950/60 backdrop-blur-2xl shadow-2xl">
        <ModalContent className="p-4 md:p-6">
          <div className="space-y-4">
            <div className="flex items-center gap-3 pr-8">
              <h2 className="font-display text-lg font-semibold text-white">
                流程图 — {source.name || "未命名流程"}
              </h2>
              <div className="ml-auto flex flex-wrap gap-1.5 text-[10px] text-neutral-400">
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-sky-300">
                  蓝 · 线上
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/15 px-2 py-0.5 text-emerald-300">
                  绿 · 线下
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-amber-300">
                  琥珀 · 会签
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-amber-300">
                  - - ▶ 前置依赖
                </span>
              </div>
            </div>

            <FlowGraph source={source} />
          </div>
        </ModalContent>
      </ModalBody>
    </Modal>
  );
}
