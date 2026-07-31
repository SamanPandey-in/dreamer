import { docsManifest } from "./docs-manifest";
import { getDocSourceText } from "./docs-content";
import { extractHeadings } from "./docs-headings";

export type DocSearchEntry = {
  slug: string;
  title: string;
  group: string;
  excerpt: string;
  headings: { id: string; label: string }[];
};

function firstParagraph(markdown: string): string {
  let inCodeBlock = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("!") || line.startsWith("|")) continue;
    return line.replace(/[*_`[\]()]/g, "").slice(0, 160);
  }
  return "";
}

export function buildDocsSearchIndex(): DocSearchEntry[] {
  return docsManifest.map((doc) => {
    const source = getDocSourceText(doc);
    return {
      slug: doc.slug,
      title: doc.title,
      group: doc.group,
      excerpt: firstParagraph(source),
      headings: extractHeadings(source).map(({ id, label }) => ({ id, label })),
    };
  });
}
