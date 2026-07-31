import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { docsManifest, getDocBySlug } from "@/lib/docs-manifest";
import { getDocSourceText } from "@/lib/docs-content";
import { extractHeadings } from "@/lib/docs-headings";
import { DocsMarkdown } from "@/components/docs/DocsMarkdown";
import { OnThisPage } from "@/components/docs/OnThisPage";
import { CopyPageButton } from "@/components/docs/CopyPageButton";
import { Progress } from "@/components/docs/Progress";

export function generateStaticParams() {
  return docsManifest.map((doc) => ({
    slug: doc.slug ? doc.slug.split("/") : [],
  }));
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const currentSlug = slug?.join("/") ?? "";

  const entry = getDocBySlug(currentSlug);
  if (!entry) notFound();

  const source = getDocSourceText(entry);
  const headings = extractHeadings(source);
  const progressSections = headings
    .filter((h) => h.depth === 2)
    .map((h) => ({ id: h.id, label: h.label }));

  const index = docsManifest.findIndex((d) => d.slug === entry.slug);
  const prev = index > 0 ? docsManifest[index - 1] : undefined;
  const next = index < docsManifest.length - 1 ? docsManifest[index + 1] : undefined;

  return (
    <div>
      <div className="flex justify-end mb-6">
        <CopyPageButton source={source} slug={entry.slug} />
      </div>

      <div className="flex gap-12">
        <article className="flex-1 min-w-0 max-w-3xl">
          <DocsMarkdown entry={entry} source={source} />

          <div className="flex items-center justify-between gap-4 mt-16 pt-8 border-t border-zinc-900">
            {prev ? (
              <Link
                href={prev.slug ? `/docs/${prev.slug}` : "/docs"}
                className="flex items-center gap-2 px-4 py-3 rounded-xl border border-zinc-900 bg-zinc-950/60 hover:border-zinc-700 transition-colors text-sm text-zinc-400 hover:text-white"
              >
                <ArrowLeft className="w-4 h-4 shrink-0" />
                <span>
                  <span className="block text-xs text-zinc-600">Previous</span>
                  {prev.title}
                </span>
              </Link>
            ) : (
              <div />
            )}
            {next ? (
              <Link
                href={next.slug ? `/docs/${next.slug}` : "/docs"}
                className="flex items-center gap-2 px-4 py-3 rounded-xl border border-zinc-900 bg-zinc-950/60 hover:border-zinc-700 transition-colors text-sm text-zinc-400 hover:text-white text-right ml-auto"
              >
                <span>
                  <span className="block text-xs text-zinc-600">Next</span>
                  {next.title}
                </span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </Link>
            ) : (
              <div />
            )}
          </div>
        </article>

        <aside className="hidden xl:block w-56 shrink-0">
          <div className="sticky top-32">
            <OnThisPage headings={headings} />
          </div>
        </aside>
      </div>

      <Progress sections={progressSections} />
    </div>
  );
}
