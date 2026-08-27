import { DocsHeader } from "@/components/docs/DocsHeader";
import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { buildDocsSearchIndex } from "@/lib/docs/docs-search-index";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const searchIndex = buildDocsSearchIndex();

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans">
      <DocsHeader searchIndex={searchIndex} />
      <div className="max-w-[1400px] mx-auto px-6 pt-16 flex gap-12">
        <aside className="hidden md:block w-64 shrink-0 py-10 sticky top-16 self-start max-h-[calc(100vh-4rem)] overflow-y-auto">
          <DocsSidebar />
        </aside>
        <main className="flex-1 min-w-0 py-10">{children}</main>
      </div>
    </div>
  );
}
