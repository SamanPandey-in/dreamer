import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Everything under these paths is an authenticated app view (a logged-out
// crawler just gets redirected to /login anyway) or a pure API surface —
// no SEO value, and indexing /project/:id pages would leak project
// names/slugs from private dashboards into search results.
const DISALLOWED_PATHS = ["/dashboard", "/dashboard/", "/project/", "/api/", "/setup"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default rule — every crawler not named below, standard search
      // engines included, can index everything except the app itself.
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOWED_PATHS,
      },
      // AI crawlers named explicitly: technically covered by the "*"
      // default above, but spelling them out marks access as intentional —
      // AI answer engines are a primary discovery channel.
      { userAgent: "GPTBot", allow: "/", disallow: DISALLOWED_PATHS }, // OpenAI training + browsing
      { userAgent: "OAI-SearchBot", allow: "/", disallow: DISALLOWED_PATHS }, // ChatGPT search
      { userAgent: "ChatGPT-User", allow: "/", disallow: DISALLOWED_PATHS }, // ChatGPT live browsing on a user's behalf
      { userAgent: "ClaudeBot", allow: "/", disallow: DISALLOWED_PATHS }, // Anthropic crawling
      { userAgent: "Claude-Web", allow: "/", disallow: DISALLOWED_PATHS }, // Claude live browsing
      { userAgent: "anthropic-ai", allow: "/", disallow: DISALLOWED_PATHS },
      { userAgent: "PerplexityBot", allow: "/", disallow: DISALLOWED_PATHS },
      { userAgent: "Perplexity-User", allow: "/", disallow: DISALLOWED_PATHS },
      { userAgent: "Google-Extended", allow: "/", disallow: DISALLOWED_PATHS }, // Gemini / Google AI features training
      { userAgent: "Applebot-Extended", allow: "/", disallow: DISALLOWED_PATHS }, // Apple Intelligence
      { userAgent: "meta-externalagent", allow: "/", disallow: DISALLOWED_PATHS }, // Meta AI
      { userAgent: "Bytespider", allow: "/", disallow: DISALLOWED_PATHS }, // ByteDance
      { userAgent: "Amazonbot", allow: "/", disallow: DISALLOWED_PATHS },
      { userAgent: "CCBot", allow: "/", disallow: DISALLOWED_PATHS }, // Common Crawl — feeds many downstream LLMs
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
