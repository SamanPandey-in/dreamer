import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

export type AlertVariant = "error" | "warning" | "info" | "success";

const VARIANT_STYLES: Record<AlertVariant, { container: string; icon: string }> = {
  // Something failed outright — invalid credentials, a link that no longer
  // works, a request that errored. Red is reserved for this only, so it
  // still reads as "something's actually wrong" when it shows up.
  error: {
    container: "bg-red-500/10 border-red-500/20 text-red-400",
    icon: "text-red-400",
  },
  // Action needed before the user can continue, but nothing is broken —
  // e.g. "verify your email first". Amber, not red, so it doesn't read as
  // a failure on the user's part.
  warning: {
    container: "bg-amber-500/10 border-amber-500/20 text-amber-300",
    icon: "text-amber-400",
  },
  // Neutral status update, no judgment either way.
  info: {
    container: "bg-blue-500/10 border-blue-500/20 text-blue-300",
    icon: "text-blue-400",
  },
  // Positive confirmation — connected, saved, verified.
  success: {
    container: "bg-emerald-500/10 border-emerald-500/20 text-emerald-300",
    icon: "text-emerald-400",
  },
};

const VARIANT_ICONS: Record<AlertVariant, typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};

interface AlertProps {
  variant: AlertVariant;
  children: ReactNode;
  /**
   * Support reference shown as small, muted, monospace text below the
   * message — deliberately never inline with the message itself. A raw ID
   * sitting in the middle of a sentence reads as a bug, not a feature; on
   * its own line it reads as "here's what to give support" instead.
   */
  requestId?: string;
  className?: string;
}

export function Alert({ variant, children, requestId, className = "" }: AlertProps) {
  const styles = VARIANT_STYLES[variant];
  const Icon = VARIANT_ICONS[variant];

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2.5 ${styles.container} ${className}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${styles.icon}`} />
        <div className="text-sm leading-snug">{children}</div>
      </div>
      {requestId && (
        <p className="text-[11px] font-mono text-zinc-600 mt-1.5 ml-6">Reference: {requestId}</p>
      )}
    </div>
  );
}
