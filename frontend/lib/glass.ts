import { useReducedMotion } from "motion/react";

/** 官方 LiquidGlass demo 的玻璃阴影：顶部内高光 + 深投影（玻璃厚度感的关键） */
export const GLASS_SHADOW =
  "shadow-[0_10px_40px_rgb(0_0_0/0.18),inset_0_1px_0_rgb(255_255_255/0.45)]";

/** 官方 demo 的交互：hover 微放大、按下回缩（尊重系统减弱动效设置） */
export function useGlassInteraction() {
  const reduceMotion = useReducedMotion();
  return reduceMotion
    ? {}
    : { whileHover: { scale: 1.03 }, whileTap: { scale: 0.97 } };
}
