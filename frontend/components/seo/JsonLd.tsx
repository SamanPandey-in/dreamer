import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";

// Homepage-only (app/page.tsx) — duplicating identical SoftwareApplication
// markup across every docs page reads as duplicate content. All fields are
// checkable facts; aggregateRating/review markup is deliberately omitted,
// since fabricated ratings violate Google's structured-data guidelines.
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
