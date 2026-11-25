"use client";

import { useEffect, useRef } from "react";
import { Modal, ModalBody, ModalContent, useModal } from "@/components/ui/animated-modal";

/** 挂载即打开;用户关闭后回调 onClose,由调用方卸载 */
function AutoOpen({ onClose }: { onClose: () => void }) {
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

/**
 * 官方 AnimatedModal 的受控用法(与 flow-chart.tsx 同一模式):挂载即打开,关闭后回调。
 * 弹层本体原地渲染,所以要放在列表卡片之外——带背景模糊的祖先会成为 fixed 定位的包含块,把弹层困在卡片里。
 */
export function ControlledModal({
  onClose,
  bodyClassName,
  contentClassName,
  label,
  children,
}: {
  onClose: () => void;
  bodyClassName?: string;
  contentClassName?: string;
  /** 弹层的名字(读屏用) */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Modal>
      <AutoOpen onClose={onClose} />
      <ModalBody className={bodyClassName}>
        <ModalContent className={contentClassName}>
          <div role="dialog" aria-modal="true" aria-label={label} className="min-w-0 flex-1">
            {children}
          </div>
        </ModalContent>
      </ModalBody>
    </Modal>
  );
}
