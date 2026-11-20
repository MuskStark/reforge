import type { Metadata, Viewport } from "next";
// 字体自托管（fontsource 包，构建/运行零外网请求，中国环境友好）
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import { AppToaster } from "@/components/app-toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: "流程再造工程收集表 — ReForge",
  description:
    "流程再造工程收集表：自定义流程步骤与会签（内部可含多步），标注线上/线下办理，多人协作推进流程再造。",
  // iOS（含 iPhone Duo）：数字不被识别为电话号；添加到主屏幕时独立窗口 + 黑色状态栏融合暗色主题
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "流程再造工程收集表",
  },
};

/**
 * 移动端 / 折叠屏视口配置：
 * - viewportFit=cover 支持异形屏（刘海/打孔/铰链区）配合 safe-area 避让
 * - 折叠态↔展开态切换时浏览器按 device-width 重排，配合 dvh 动态高度
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#06090F",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="font-sans">
        {children}
        <AppToaster />
      </body>
    </html>
  );
}
