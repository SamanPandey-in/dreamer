import Link from "next/link";

export default function NotFound() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(0,145,255,0.18),transparent_35%),radial-gradient(circle_at_85%_80%,rgba(0,145,255,0.12),transparent_40%)]" />
      <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-50" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-16">
        <section className="w-full max-w-2xl rounded-2xl border border-zinc-800/90 bg-zinc-950/70 p-8 text-center shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-sm sm:p-12">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-zinc-500">
            404 not found
          </p>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-zinc-100 sm:text-5xl">
            Whoops!!
          </h1>
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-zinc-100 sm:text-5xl">
            You found the void.
          </h1>
          <p className="mx-auto mb-2 max-w-xl text-base text-zinc-300 sm:text-lg">
            This page does not exist, but hey, you made it this far.
          </p>
          <p className="mx-auto mb-8 max-w-xl text-base font-semibold text-zinc-100 sm:text-lg">Respect.</p>
          <p className="mx-auto mb-10 max-w-xl text-sm text-zinc-400 sm:text-base">
            Let&apos;s get you somewhere that actually exists.
          </p>

          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-white px-7 py-3 text-sm font-semibold text-black transition-all duration-200 hover:scale-[1.02] hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
          >
            Go Home
          </Link>
        </section>
      </div>
    </div>
  );
}
