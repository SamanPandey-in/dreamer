// Single source of truth for the docs site structure.
// `source` is the path of the markdown file inside /content/docs.
// `slug` is the URL path under /docs (empty string = /docs itself).
export type DocEntry = {
  slug: string;
  source: string;
  title: string;
  group: string;
};

export const docsManifest: DocEntry[] = [
  { slug: "", source: "README.md", title: "Overview", group: "Getting Started" },
  { slug: "architecture", source: "architecture/overview.md", title: "Architecture Overview", group: "Getting Started" },

  { slug: "auth", source: "auth/README.md", title: "Authentication", group: "Core Concepts" },
  { slug: "projects", source: "projects/README.md", title: "Projects & Import Wizard", group: "Core Concepts" },
  { slug: "framework-detection", source: "framework-detection/README.md", title: "Framework Detection", group: "Core Concepts" },
  { slug: "deployments", source: "deployments/overview.md", title: "Deployments Overview", group: "Core Concepts" },
  { slug: "deployments/static", source: "deployments/static-deployments.md", title: "Static Deployments", group: "Core Concepts" },
  { slug: "deployments/dynamic", source: "deployments/dynamic-deployments.md", title: "Dynamic (SSR) Deployments", group: "Core Concepts" },
  { slug: "reverse-proxy", source: "reverse-proxy/README.md", title: "Reverse Proxy", group: "Core Concepts" },
  { slug: "wildcard-domains", source: "reverse-proxy/wildcard-domains.md", title: "Wildcard Domains", group: "Core Concepts" },
];

export const docsGroups = ["Getting Started", "Core Concepts", "Guides"] as const;

export function getDocBySlug(slug: string): DocEntry | undefined {
  return docsManifest.find((d) => d.slug === slug);
}

export function getDocBySource(source: string): DocEntry | undefined {
  return docsManifest.find((d) => d.source === source);
}

// Fallback for any doc link we deliberately did not migrate into the app
// (internal build-log style docs) — send the reader to the source on GitHub
// instead of a 404.
export const GITHUB_DOCS_BASE =
  "https://github.com/SamanPandey-in/dreamer/blob/main/docs/";
