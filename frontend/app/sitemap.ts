import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { docsManifest } from "@/lib/docs/docs-manifest";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/login`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  // Derived from docsManifest, the same single source of truth
  // app/docs/[[...slug]]/page.tsx's generateStaticParams uses — a doc page
  // added there shows up here automatically, with no separate list to
  // remember to update.
  const docsRoutes: MetadataRoute.Sitemap = docsManifest.map((doc) => ({
    url: doc.slug ? `${SITE_URL}/docs/${doc.slug}` : `${SITE_URL}/docs`,
    lastModified: now,
    changeFrequency: "monthly",
    // The self-hosting guide is the single most link-worthy/most-searched
    // doc page (it's also the hero's secondary CTA target) — nudged
    // slightly above the rest of the docs tree.
    priority: doc.slug === "self-hosting" ? 0.8 : 0.6,
  }));

  return [...staticRoutes, ...docsRoutes];
}
