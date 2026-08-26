import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Dreamer - Free Deployment, or Self-Hosted PaaS | Built by Saman Pandey",
    template: "%s | Dreamer",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "PaaS",
    "platform as a service",
    "free hosting",
    "web hosting",
    "self-hosted",
    "open source",
    "deploy",
    "Docker",
    "self-hosted PaaS",
    "Next.js hosting",
    "Vercel alternative",
    "Railway alternative",
    "static hosting",
    "dynamic app hosting",
    "auto-deploy on push",
    "GitHub webhook deploy",
    "containerization",
    "CI/CD",
    "wildcard subdomains",
    "Saman Pandey",
    "Dreamer PaaS",
  ],
  authors: [{ name: "Saman Pandey", url: "https://github.com/SamanPandey-in" }],
  creator: "Saman Pandey",
  publisher: "Saman Pandey",
  applicationName: SITE_NAME,
  category: "technology",
  metadataBase: new URL(SITE_URL),
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: SITE_NAME,
    title: "Dreamer — Free Hosting, or Self-Hosted PaaS",
    description: SITE_DESCRIPTION,
    // No manual `images` entry — app/opengraph-image.tsx is a file-convention
    // route auto-injected into this metadata at build/request time. A hardcoded
    // path would 404 silently if missing on disk, and link unfurls cache that
    // broken state.
  },
  twitter: {
    card: "summary_large_image",
    title: "Dreamer — Free Hosting, or Self-Hosted PaaS",
    description: SITE_DESCRIPTION,
    creator: "@SamanPandey",
    // Same reasoning as openGraph.images above — app/twitter-image.tsx
    // auto-wires this.
  },
  icons: [{ rel: "icon", url: "/logo-dark.svg", type: "image/svg+xml" }],
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
  // Search Console / Bing verification goes here once real codes exist, e.g.
  // `verification: { google: "abc123" }` — no placeholder, since a fake value
  // fails verification silently.
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
