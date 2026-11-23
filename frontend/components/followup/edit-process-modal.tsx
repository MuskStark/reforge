"use client";

/**
 * 编辑已有流程表单(复用 FlowBuilder):管理员或被指派跟进人可保存(PUT)。
 */

import { useEffect, useState } from "react";
import { FlowBuilder } from "@/components/flow-builder";
import type { FlowProcess } from "@/lib/types";

export function EditProcessModal({
  process,
  onClose,
  onSaved,
}: {
  process: FlowProcess;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({
    name: process.name,
    description: process.description,
    applicant: process.applicant,
    steps: process.steps,
  });

  // 外部流程刷新时同步草稿(首次打开后基本不触发)
  useEffect(() => {
    setDraft({
      name: process.name,
      description: process.description,
      applicant: process.applicant,
      steps: process.steps,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [process.id]);

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[rgba(18,26,48,0.32)] p-4 backdrop-blur-md sm:p-8">
      <div
        className="mx-auto w-full max-w-4xl rounded-[28px] p-5 sm:p-6"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.86), rgba(255,255,255,0.68))",
          backdropFilter: "blur(36px) saturate(180%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.98), 0 40px 90px -30px rgba(12,22,48,0.45)",
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <h3 className="text-[18px] font-bold tracking-[-0.02em]">编辑流程 · {process.name}</h3>
          <span className="badge badge-plain" style={{ height: 22 }}>修改将写入时间线</span>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn !h-9 !w-9 ml-auto bg-white/70 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.08)]"
            aria-label="关闭"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <FlowBuilder
          value={draft}
          onChange={setDraft}
          existingId={process.id}
          onSubmitted={onSaved}
          onPreviewChart={() => {
            /* 表单编辑态不提供图预览(入口在详情页) */
          }}
        />
      </div>
    </div>
  );
}
