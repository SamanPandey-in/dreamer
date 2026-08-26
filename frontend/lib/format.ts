/** "3h ago", "just now", etc. — falls back to a locale date past 30 days. */
export function formatRelativeTime(date: string | Date): string {
  const then = new Date(date).getTime();
  const diffSeconds = Math.round((Date.now() - then) / 1000);

  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  return new Date(date).toLocaleDateString();
}

/** "2m 34s", "45s", "1h 02m" — for buildDurationMs and the state timeline. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "owner/repo" -> "repo" — used to auto-suggest a project name from a pasted GitHub URL. */
export function repoNameFromUrl(repoUrl: string): string {
  const match = repoUrl.match(/\/([^/]+?)(\.git)?\/?$/);
  return match?.[1] ?? "";
}

/**
 * Mirrors `slugifyProjectName` in the API's src/projects/project.service.ts
 * — same lowercase / collapse-non-alphanumeric / trim-hyphens rules — purely
 * so the new-project form can preview what the real slug will look like
 * before submitting. This is a PREVIEW ONLY: it can't know about collisions
 * (no DB access from the browser), so if the exact slug is already taken,
 * the actual created project gets `{preview}-{randomSuffix}` instead — the
 * form's helper text next to this says as much, deliberately, rather than
 * implying the preview is guaranteed.
 */
export function slugPreview(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}
/** "1.2 KB", "3.4 MB", "512 B" — for metrics bandwidth totals. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/** "1.2K", "3.4M" — for compact metric totals (request/visitor counts). */
export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
