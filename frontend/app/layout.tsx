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
    // No manual `images` entry here on purpose — app/opengraph-image.tsx
    // below is a Next.js file-convention route that generates this image
    // dynamically and gets auto-injected into this metadata at build/
    // request time. A hardcoded `/og.png` path is a silent 404 the moment
    // that file doesn't exist on disk (which it didn't, before this
    // change) — link unfurls on Slack/Discord/iMessage/LinkedIn all cache
    // that broken state, sometimes for weeks. Generating it in code means
    // it can never drift out of sync with what's actually on disk.
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
  // Search Console / Bing Webmaster verification codes go here once you
  // have real ones, e.g. `verification: { google: "abc123" }` — deliberately
  // left out rather than filled with a placeholder, since a fake value
  // sitting in committed code is easy to forget and ship, and Search
  // Console will just fail to verify against it silently.
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
