import type { Metadata } from "next";
import { LoginScreen } from "@/components/auth/login-card";

export const metadata: Metadata = { title: "登录 — ReForge" };

/** 唯一的登录页:任何页面未登录都来这里,登录成功一律进工作台 */
export default function LoginPage() {
  return <LoginScreen />;
}
