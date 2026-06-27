import { Box, Clock, FileStack, HardDrive } from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { Deployment } from "@/lib/dashboard-types";

const FRAMEWORK_LABELS: Record<string, string> = {
  REACT_CRA: "Create React App",
  REACT_VITE: "React (Vite)",
  VUE: "Vue",
  SVELTE: "Svelte",
  NEXT_STATIC: "Next.js (static export)",
  NEXT_SSR: "Next.js (SSR)",
  EXPRESS: "Express",
  FASTIFY: "Fastify",
  HONO: "Hono",
  STATIC_HTML: "Static HTML",
  UNKNOWN: "Unknown",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BuildSummaryCard({ deployment }: { deployment: Deployment }) {
  const items = [
    {
      icon: Box,
      label: "Framework",
      value: deployment.framework ? FRAMEWORK_LABELS[deployment.framework] ?? deployment.framework : "Not detected",
    },
    {
      icon: Box,
      label: "Type",
      value: deployment.type ?? "Unknown",
    },
    {
      icon: Clock,
      label: "Build time",
      value: deployment.buildDurationMs ? formatDuration(deployment.buildDurationMs) : "—",
    },
    deployment.type === "DYNAMIC"
      ? {
          icon: HardDrive,
          label: "Image size",
          value: deployment.imageSizeBytes ? formatBytes(deployment.imageSizeBytes) : "—",
        }
      : {
          icon: FileStack,
          label: "Files uploaded",
          value: deployment.uploadedFileCount != null ? String(deployment.uploadedFileCount) : "—",
        },
  ];

  return (
    <div className="bg-zinc-950/80 rounded-2xl border border-zinc-800 p-5 mb-6">
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-4">Build Summary</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {items.map(({ icon: Icon, label, value }) => (
          <div key={label}>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-1">
              <Icon className="w-3.5 h-3.5" />
              {label}
            </div>
            <p className="text-sm font-medium text-zinc-200 truncate">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
