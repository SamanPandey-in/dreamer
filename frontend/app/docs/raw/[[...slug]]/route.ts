import { NextResponse } from "next/server";
import { getDocBySlug } from "@/lib/docs/docs-manifest";
import { getDocSourceText } from "@/lib/docs/docs-content";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> }
) {
  const { slug } = await params;
  const currentSlug = slug?.join("/") ?? "";

  const entry = getDocBySlug(currentSlug);
  if (!entry) {
    return new NextResponse("Not found", { status: 404 });
  }

  const source = getDocSourceText(entry);
  return new NextResponse(source, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
