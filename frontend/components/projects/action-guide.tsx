"use client";

/**
 * 行动卡:轮到当前登录人操作时,详情页页头下方出现的玻璃引导条——
 * 语义色图标珠 + 一句话标题 + 副行说明 + 单个主按钮直达操作位置。
 * 轮不到时不渲染(guideFor 返回 null)。样式对照设计稿 design/liquid-glass/action-guide.html。
 */

import type { ActionGuideItem, GuideTone } from "@/lib/action-guide";

const TONE: Record<GuideTone, { bar: string; bead: string; shadow: string }> = {
  blue: { bar: "var(--tint)", bead: "linear-gradient(180deg,#2b95ff,var(--tint))", shadow: "rgba(0,113,227,0.6)" },
  amber: { bar: "var(--amber)", bead: "linear-gradient(180deg,#ffb340,var(--amber))", shadow: "rgba(255,149,0,0.6)" },
  green: { bar: "var(--green)", bead: "linear-gradient(180deg,#5bd97c,var(--green))", shadow: "rgba(52,199,89,0.6)" },
  plain: { bar: "#aeaeb4", bead: "linear-gradient(180deg,#d5d5da,#aeaeb4)", shadow: "rgba(23,42,80,0.2)" },
};

function GuideIcon({ name }: { name: ActionGuideItem["icon"] }) {
  const common = { width: 19, height: 19, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "list":
      return (
        <svg {...common}>
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <path d="M9 13h6M9 17h4" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M22 2L11 13" />
          <path d="M22 2l-7 20-4-9-9-4z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case "pen":
      return (
        <svg {...common}>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
  }
}

export function ActionGuideCard({
  guide,
  onGo,
  onEditSubmission,
  className,
}: {
  guide: ActionGuideItem;
  onGo: (tab: Exclude<ActionGuideItem["tab"], undefined>) => void;
  onEditSubmission: () => void;
  className?: string;
}) {
  const tone = TONE[guide.tone];
  return (
    <div
      className={`relative flex items-center gap-3 rounded-[20px] bg-white/65 p-3.5 pl-4 ${className ?? ""}`}
      style={{
        backdropFilter: "blur(24px) saturate(180%)",
        WebkitBackdropFilter: "blur(24px) saturate(180%)",
        boxShadow: `inset 3.5px 0 0 -0.5px ${tone.bar}, inset 0 1px 0 rgba(255,255,255,0.95), inset 0 0 0 0.5px rgba(255,255,255,0.6), 0 10px 30px -18px rgba(23,42,80,0.4)`,
      }}
    >
      <span
        className="grid size-10 shrink-0 place-items-center rounded-[13px] text-white"
        style={{ background: tone.bead, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 4px 10px -4px ${tone.shadow}` }}
        aria-hidden="true"
      >
        <GuideIcon name={guide.icon} />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[15px] font-semibold leading-snug tracking-[-0.01em] text-neutral-900">{guide.title}</b>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">{guide.detail}</span>
      </span>
      {guide.editSubmission ? (
        <button type="button" onClick={onEditSubmission} className="btn btn-primary !h-9 shrink-0 !px-4 text-[13px]">
          {guide.cta}
        </button>
      ) : (
        guide.tab && (
          <button type="button" onClick={() => onGo(guide.tab!)} className="btn btn-primary !h-9 shrink-0 !px-4 text-[13px]">
            {guide.cta}
          </button>
        )
      )}
    </div>
  );
}
