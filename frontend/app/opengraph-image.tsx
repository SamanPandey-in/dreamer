import { ImageResponse } from "next/og";
import { OgCard, OG_IMAGE_SIZE } from "@/components/seo/og-card";

// File-convention route: Next.js injects this image into every page's
// openGraph.images unless the page declares its own (see layout.tsx).
export const alt = "Dreamer — Your Own Vercel, Deployed in Seconds, Owned Forever";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<OgCard />, size);
}
