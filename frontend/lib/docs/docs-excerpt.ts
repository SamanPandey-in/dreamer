// Strips markdown syntax down to plain text and returns the first real
// paragraph, truncated to a search-result-friendly length — used by
// app/docs/[[...slug]]/page.tsx's generateMetadata so every doc page gets
// its own description instead of inheriting the root layout's site-wide
// one. Deliberately simple (no full markdown AST) since this only needs to
// be "good enough plain text," not a faithful render — DocsMarkdown already
// owns the real rendering.
const MAX_DESCRIPTION_LENGTH = 155;

function stripMarkdownSyntax(line: string): string {
  return line
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

export function extractDocDescription(markdown: string): string | undefined {
  let inCodeBlock = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || line.length === 0) continue;
    // Skip headings, list markers, and blockquotes — we want the first
    // sentence of actual prose, not a heading repeating the page title.
    if (/^(#{1,6}\s|[-*+]\s|>\s|\d+\.\s)/.test(line)) continue;

    const text = stripMarkdownSyntax(line);
    if (!text) continue;

    return text.length > MAX_DESCRIPTION_LENGTH
      ? `${text.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd()}…`
      : text;
  }

  return undefined;
}
