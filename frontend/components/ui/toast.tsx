"use client";

import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/utils";

/** Toast(sonner):亮色玻璃 —— 与液态玻璃主题一致 */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  const { theme = "light", className, ...rest } = props;
  return (
    <Sonner
      theme={theme}
      className={cn("toaster", className)}
      toastOptions={{
        style: {
          background: "rgba(255, 255, 255, 0.82)",
          backdropFilter: "blur(24px) saturate(180%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          border: "0.5px solid rgba(255, 255, 255, 0.7)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.95), 0 12px 32px -12px rgba(23,42,80,0.28)",
          color: "#1d1d1f",
          borderRadius: "18px",
        },
        classNames: {
          description: "text-[#6e6e73]",
        },
      }}
      {...rest}
    />
  );
}
