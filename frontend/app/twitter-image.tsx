import { ImageResponse } from "next/og";
import { OgCard, OG_IMAGE_SIZE } from "@/components/seo/og-card";

// Injected into twitter.images. Without this file X would fall back to
// opengraph-image.tsx, but its crawler is picky enough about card rendering
// to warrant an explicit copy.
export const alt = "Dreamer — Your Own Vercel, Deployed in Seconds, Owned Forever";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(<OgCard />, size);
}
