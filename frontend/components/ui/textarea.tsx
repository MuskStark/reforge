import React from "react";
import { cn } from "@/lib/utils";

/** Aceternity UI — Textarea：与 Input 同款视觉 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[64px] w-full border-none bg-black shadow-[0_0_1px_1px_rgba(255,255,255,0.12)] rounded-md text-white text-sm px-3 py-2 transition-shadow duration-200 placeholder:text-neutral-500 focus-visible:outline-none focus-visible:shadow-[0_0_1px_2px_#3EC1D3] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";

export { Textarea };
