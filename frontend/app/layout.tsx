import type { Metadata, Viewport } from "next";
// 字体自托管（fontsource，构建/运行零外网请求，中国环境友好）
// Apple 设备上 --font-sans 优先命中 SF Pro + PingFang SC，Inter 作为非苹果平台回退
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import { AppToaster } from "@/components/app-toaster";
import { ClientLogger } from "@/components/client-logger";
import "./globals.css";

/**
 * 页面一律动态渲染：预渲染页默认带 `s-maxage=31536000`，而 Cloudflare 面板对
 * /admin、/monitor 开了 HTML 缓存，会照此缓存近一年；部署新构建后旧 HTML 引用的
 * chunk 已不存在 → 404 白屏。动态渲染改发 no-store，CDN 与浏览器都不缓存 HTML。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "流程再造工程收集表 — ReForge",
  description:
    "流程再造工程收集表：自定义流程步骤与会签（内部可含多步），标注线上/线下办理，多人协作推进流程再造。",
  // iOS（含 iPhone Duo）：数字不被识别为电话号；添加到主屏幕时独立窗口
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
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
  themeColor: "#EEF0F4",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="font-sans">
        {children}
        <AppToaster />
        {/* 浏览器端的报错与失败的接口调用,自动上报到后端日志 */}
        <ClientLogger />
      </body>
    </html>
  );
}
