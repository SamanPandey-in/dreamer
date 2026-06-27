"use client";

import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-white text-black hover:bg-zinc-200 disabled:bg-white/50 disabled:text-black/40",
  secondary:
    "bg-transparent border border-zinc-800 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900 disabled:opacity-50",
  ghost: "bg-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900 disabled:opacity-50",
  destructive:
    "bg-transparent border border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50 disabled:opacity-50",
};

export function Button({
  variant = "secondary",
  loading = false,
  disabled,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  );
}