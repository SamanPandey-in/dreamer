export default function MaintenancePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_18%,rgba(0,145,255,0.12),transparent_36%),radial-gradient(circle_at_88%_84%,rgba(0,145,255,0.06),transparent_44%)]" />
      <div className="pointer-events-none absolute inset-0 bg-grid-pattern opacity-25" />

      <main className="relative mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-14 sm:py-16">
        <section className="w-full max-w-xl rounded-2xl border border-zinc-800/90 bg-zinc-950/70 px-7 py-8 text-center shadow-[0_14px_44px_rgba(0,0,0,0.52)] backdrop-blur-sm sm:px-9 sm:py-9">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">
            System Under Maintenance
          </p>
          <h1 className="mb-4 text-3xl font-semibold tracking-tight text-zinc-100 sm:text-4xl">
            We&apos;re working on things.
          </h1>
          <p className="mx-auto mb-5 max-w-lg text-sm leading-relaxed text-zinc-300 sm:text-base">
            The application is temporarily unavailable while we make some improvements behind the scenes.
          </p>
          <p className="mx-auto text-base font-semibold text-zinc-100 sm:text-lg">Hang tight.</p>
        </section>
      </main>
    </div>
  );
}
