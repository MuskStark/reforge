import React from "react";
import { cn } from "@/lib/utils";

/** 多行输入:与 .field 同族视觉(样式见 globals.css) */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn("field", className)}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";

export { Textarea };
