import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
    default: "Dreamer - Self-Hosted PaaS Engine | Built by Saman Pandey",
    template: "%s | Dreamer",
  },
  description:
    "Dreamer is an open-source Platform as a Service engine built by Saman Pandey. Clone repos, auto-detect frameworks, containerize apps, provision wildcard subdomains, and scale to zero. Deploy to AWS ECS or local Docker in under 3 minutes.",
  keywords: [
    "PaaS",
    "platform as a service",
    "self-hosted",
    "open source",
    "deploy",
    "Docker",
    "ECS Fargate",
    "Next.js",
    "Vercel alternative",
    "Railway alternative",
    "scale to zero",
    "containerization",
    "CI/CD",
    "wildcard subdomains",
    "AWS",
    "Saman Pandey",
    "Dreamer PaaS",
  ],
  authors: [{ name: "Saman Pandey", url: "https://github.com/SamanPandey-in" }],
  creator: "Saman Pandey",
  publisher: "Saman Pandey",
  metadataBase: new URL("https://dreamer.samanp.xyz"),
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Dreamer",
    title: "Dreamer - Self-Hosted PaaS Engine | Built by Saman Pandey",
    description:
      "Your own Vercel & Railway, self-hosted in under 3 minutes. Open-source PaaS built by Saman Pandey that clones repos, containerizes apps, provisions routing, and scales to zero.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Dreamer — Open-Source PaaS Engine by Saman Pandey",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Dreamer — Self-Hosted PaaS Engine by Saman Pandey",
    description:
      "Open-source PaaS engine built by Saman Pandey. Deploy any framework to AWS or local Docker with auto-detection, containerization, and scale-to-zero.",
    images: ["/og.png"],
    creator: "@SamanPandey",
  },
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
    canonical: "https://dreamer.samanp.xyz",
  },
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
