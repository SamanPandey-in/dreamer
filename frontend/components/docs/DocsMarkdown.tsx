import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import Link from "next/link";
import type { DocEntry } from "@/lib/docs/docs-manifest";
import { resolveDocHref } from "@/lib/docs/docs-content";

export function DocsMarkdown({ entry, source }: { entry: DocEntry; source: string }) {
  const components: Components = {
    h1: (props) => <h1 id={props.id} className="text-3xl md:text-4xl font-extrabold text-white mt-0 mb-6 scroll-mt-24">{props.children}</h1>,
    h2: (props) => <h2 id={props.id} className="text-2xl font-bold text-white mt-12 mb-4 pb-2 border-b border-zinc-900 scroll-mt-24">{props.children}</h2>,
    h3: (props) => <h3 id={props.id} className="text-lg font-bold text-white mt-8 mb-3 scroll-mt-24">{props.children}</h3>,
    h4: (props) => <h4 id={props.id} className="text-base font-semibold text-zinc-200 mt-6 mb-2 scroll-mt-24">{props.children}</h4>,
    p: (props) => <p className="text-zinc-400 leading-relaxed mb-5 text-[15px]">{props.children}</p>,
    a: (props) => {
      const rawHref = props.href ?? "";
      const href = resolveDocHref(entry, rawHref);
      const isExternal = /^https?:\/\//.test(href);
      if (isExternal) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-500/30">
            {props.children}
          </a>
        );
      }
      return (
        <Link href={href} className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-500/30">
          {props.children}
        </Link>
      );
    },
    img: (props) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={props.src} alt={props.alt ?? ""} className="rounded-xl border border-zinc-800 my-8 w-full" />
    ),
    ul: (props) => <ul className="list-disc list-outside pl-6 mb-5 text-zinc-400 space-y-2 text-[15px]">{props.children}</ul>,
    ol: (props) => <ol className="list-decimal list-outside pl-6 mb-5 text-zinc-400 space-y-2 text-[15px]">{props.children}</ol>,
    li: (props) => <li className="leading-relaxed">{props.children}</li>,
    strong: (props) => <strong className="text-zinc-200 font-semibold">{props.children}</strong>,
    code: (props) => (
      <code className="bg-zinc-900 border border-zinc-800 text-blue-300 rounded px-1.5 py-0.5 text-[13px] font-mono">
        {props.children}
      </code>
    ),
    pre: (props) => (
      <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-[13px] font-mono text-zinc-300 mb-6 [&>code]:bg-transparent [&>code]:border-0 [&>code]:p-0">
        {props.children}
      </pre>
    ),
    blockquote: (props) => (
      <blockquote className="border-l-2 border-blue-500/40 pl-4 italic text-zinc-500 my-6">{props.children}</blockquote>
    ),
    hr: () => <hr className="border-zinc-900 my-10" />,
    table: (props) => (
      <div className="overflow-x-auto rounded-xl border border-zinc-800 my-6">
        <table className="w-full text-left border-collapse text-sm">{props.children}</table>
      </div>
    ),
    thead: (props) => <thead className="bg-zinc-900/50 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wider">{props.children}</thead>,
    tbody: (props) => <tbody className="divide-y divide-zinc-900 text-zinc-300 bg-black/50">{props.children}</tbody>,
    th: (props) => <th className="py-3 px-4">{props.children}</th>,
    td: (props) => <td className="py-3 px-4 align-top">{props.children}</td>,
  };

  return (
    <div className="docs-prose max-w-none">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
        {source}
      </Markdown>
    </div>
  );
}
