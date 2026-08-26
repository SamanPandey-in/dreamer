import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Everything under these paths is either an authenticated app view (no
// content to rank — a logged-out crawler just gets redirected to /login
// anyway) or a pure API surface. None of it has SEO value, and indexing
// /project/:id pages specifically would leak project names/slugs into
// search results for what are effectively private dashboards.
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
      // Explicit AI crawler / answer-engine allow rules. A bare `userAgent:
      // "*"` rule already covers these (none of them are blocked above),
      // but naming them explicitly is the difference between "not
      // forbidden" and "on purpose" — several of these bots are
      // increasingly the FIRST hop a potential user's question about
      // Dreamer goes through (an AI answer engine, not a search results
      // page), so being unambiguous here is worth the extra lines.
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
