import { ImageResponse } from "next/og";
import { OgCard, OG_IMAGE_SIZE } from "@/components/seo/og-card";

// Next.js auto-detects this file and injects its output into every page's
// openGraph.images metadata that doesn't declare its own — see layout.tsx's
// comment on why openGraph.images was deliberately left unset there.
export const alt = "Dreamer — Your Own Vercel, Deployed in Seconds, Owned Forever";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<OgCard />, size);
}
