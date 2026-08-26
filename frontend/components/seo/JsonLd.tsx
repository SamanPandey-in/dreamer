import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";

// Rendered once, on the homepage only (app/page.tsx) — not in the root
// layout, since duplicating identical SoftwareApplication markup on every
// docs page would be the JSON-LD equivalent of the duplicate-title problem
// generateMetadata in app/docs/[[...slug]]/page.tsx was just written to fix.
//
// Every field here is a fact that's actually true and checkable on this
// site right now (free tier, author, repo) — deliberately NOT including
// aggregateRating/review markup, since fabricating those is exactly the
// kind of structured-data spam Google's guidelines explicitly penalize,
// and there's no real rating data to report.
export function JsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Web, Linux, Docker",
        description: SITE_DESCRIPTION,
        url: SITE_URL,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "USD",
          description: "Free hosting tier — lifetime free for the first 50 users",
        },
        author: {
          "@type": "Person",
          name: "Saman Pandey",
          url: "https://github.com/SamanPandey-in",
        },
      },
      {
        "@type": "WebSite",
        name: SITE_NAME,
        url: SITE_URL,
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
