import type { Metadata } from "next";
import { MePage } from "@/components/shell/me-page";

export const metadata: Metadata = { title: "我的 — ReForge" };

/** 「我的」:手机底部 Tab 栏的第四页(数据大屏 / 提交流程 / 管理后台 / 个人信息 / 退出) */
export default function MeRoute() {
  return <MePage />;
}
