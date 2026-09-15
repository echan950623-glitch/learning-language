import type { ReactNode } from "react";

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "primary";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-foreground-muted",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  primary: "bg-primary/10 text-primary",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
