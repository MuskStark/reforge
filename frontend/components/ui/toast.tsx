"use client";

import { Toaster as Sonner } from "sonner";
import { cn } from "@/lib/utils";

/** Aceternity UI — Toast（基于 sonner 封装） */
export function Toaster(props: React.ComponentProps<typeof Sonner>) {
  const { theme = "dark", className, ...rest } = props;
  return (
    <Sonner
      theme={theme}
      className={cn("toaster group", className)}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-neutral-950 group-[.toaster]:text-white group-[.toaster]:border-white/10 group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-neutral-400",
        },
      }}
      {...rest}
    />
  );
}
