import GithubSlugger from "github-slugger";

export type DocHeading = { id: string; label: string; depth: 2 | 3 };

// Strips basic markdown inline formatting (bold/italic/code/links) so the
// heading text matches what react-markdown will actually render.
function cleanHeadingText(raw: string): string {
  return raw
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

// Only h2/h3 are surfaced — h1 duplicates the page title and h4+ is too
// granular for a "on this page" style outline.
export function extractHeadings(markdown: string): DocHeading[] {
  const slugger = new GithubSlugger();
  const headings: DocHeading[] = [];
  let inCodeBlock = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) continue;

    const depth = match[1].length as 2 | 3;
    const label = cleanHeadingText(match[2]);
    if (!label) continue;

    headings.push({ id: slugger.slug(label), label, depth });
  }

  return headings;
}
