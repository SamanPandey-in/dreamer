import { ImageResponse } from "next/og";
import { OgCard, OG_IMAGE_SIZE } from "@/components/seo/og-card";

// Next.js auto-detects this file and injects its output into twitter.images
// — falls back to opengraph-image.tsx if this file didn't exist, but X's
// crawler is picky enough about card rendering that it gets its own
// explicit copy rather than relying on the OG fallback.
export const alt = "Dreamer — Your Own Vercel, Deployed in Seconds, Owned Forever";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<OgCard />, size);
}
