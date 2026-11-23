"use client";

import { Globe, MapPin } from "lucide-react";
import { OVERALL_MODE_LABEL, type OverallMode } from "@/lib/step-checks";
import { cn } from "@/lib/utils";

/**
 * 会签整体办理方式标识：由各方内部子步骤聚合（全部线上 / 全部线下 / 两者兼有），
 * 尚无已命名子步骤（单步签署）时无从判断，显示「未标注」。
 */
export function CountersignModeBadge({
  mode,
  className,
}: {
  mode: OverallMode;
  className?: string;
}) {
  return (
    <span
      title="会签整体办理方式：由各会签方的内部子步骤汇总"
      className={cn(
        "badge",
        mode === "online" && "badge-blue",
        mode === "offline" && "badge-green",
        (mode === "mixed" || mode === "unknown") && "badge-plain",
        className,
      )}
    >
      {mode === "online" && <Globe className="h-3 w-3" />}
      {mode === "offline" && <MapPin className="h-3 w-3" />}
      {mode === "mixed" && (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tint)]" aria-hidden="true" />
          <span className="-ml-1 h-1.5 w-1.5 rounded-full bg-[color:var(--green)]" aria-hidden="true" />
        </>
      )}
      {OVERALL_MODE_LABEL[mode]}
    </span>
  );
}
