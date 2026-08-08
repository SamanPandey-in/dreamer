"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  motion,
  AnimatePresence,
  MotionConfig,
  useMotionValue,
  useSpring,
  useInView,
  animate
} from "framer-motion";
import Image from "next/image";
import {
  Terminal,
  ArrowRight,
  Check,
  Copy,
  Server,
  Database,
  Lock,
  Cpu,
  Activity,
  GitBranch,
  Menu,
  X,
  Cloud,
  BookOpen
} from "lucide-react";
import { GithubIcon as Github } from "../components/icons";
import { useAuth } from "./providers";
import Link from "next/link";
import { useRouter } from "next/navigation";

// A CTA that subtly pulls toward the cursor when it's nearby — the one
// deliberately bold interactive moment on the page. Everything else stays
// restrained on purpose.
function MagneticButton({
  children,
  className,
  href
}: {
  children: React.ReactNode;
  className: string;
  href: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 200, damping: 15, mass: 0.2 });
  const springY = useSpring(y, { stiffness: 200, damping: 15, mass: 0.2 });

  const handleMouseMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const relX = e.clientX - (rect.left + rect.width / 2);
    const relY = e.clientY - (rect.top + rect.height / 2);
    x.set(relX * 0.3);
    y.set(relY * 0.4);
  };

  const handleMouseLeave = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.a
      ref={ref}
      href={href}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ x: springX, y: springY }}
      whileTap={{ scale: 0.96 }}
      className={className}
    >
      {children}
    </motion.a>
  );
}

// Animates a number from 0 to its target once it scrolls into view. Used
// sparingly, for real numbers already stated elsewhere on the page.
function StatCounter({
  value,
  suffix = "",
  prefix = ""
}: {
  value: number;
  suffix?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(0, value, {
      duration: 1.4,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v))
    });
    return () => controls.stop();
  }, [inView, value]);

  return (
    <span ref={ref}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const router = useRouter();
  const { user, loading } = useAuth();

  const goToConsole = () => {
    setMobileMenuOpen(false);
    router.push(loading ? "/login" : user ? "/dashboard" : "/login");
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const fadeInUpVariants = {
    hidden: { opacity: 0, y: 30 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" as const } }
  };

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
        delayChildren: 0.1
      }
    }
  };

  const headlineContainer = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.12, delayChildren: 0.15 } }
  };

  const headlineLine = {
    hidden: { opacity: 0, y: 24, filter: "blur(6px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const }
    }
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-blue-500/30 selection:text-blue-200">

      {/* Dynamic Header */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 border-b transition-colors duration-300 ${
          scrolled
            ? "bg-black/70 backdrop-blur-md border-white/10"
            : "bg-transparent backdrop-blur-none border-transparent"
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/logo-dark.svg" alt="Dreamer" width={32} height={32} className="w-8 h-8" />
            <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
              Dreamer
            </span>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-zinc-400 hover:text-white transition-colors">Features</a>
            <Link href="/docs" className="text-sm text-zinc-400 hover:text-white transition-colors">Docs</Link>
          </nav>

          <div className="hidden md:flex items-center gap-4">
            <a
              href="https://github.com/SamanPandey-in/dreamer"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-sm text-zinc-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              <Github className="w-4 h-4" />
              <span>Star</span>
            </a>
            <button
              className="text-sm text-zinc-300 hover:text-white transition-colors px-3 py-1.5"
              onClick={goToConsole}
            >
              Log in
            </button>
            <a
              href="/register"
              className="relative group overflow-hidden rounded-full p-[1px] focus:outline-none inline-block"
            >
              <span className="absolute inset-0 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full group-hover:opacity-100 transition duration-500"></span>
              <span className="relative block px-4 py-1.5 bg-black rounded-full text-sm font-medium text-white transition duration-200 group-hover:bg-transparent">
                Sign up
              </span>
            </a>
          </div>

          {/* Mobile Menu Button */}
          <button className="md:hidden text-zinc-400 hover:text-white" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Navigation Drawer */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="md:hidden border-t border-white/10 bg-black/95 backdrop-blur-lg px-6 py-6 flex flex-col gap-4"
            >
              <a href="#features" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>Features</a>
              <Link href="/docs" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>Docs</Link>
              <div className="h-[1px] bg-white/10 my-2" />
              <div className="flex flex-col gap-3">
                <a
                  href="https://github.com/SamanPandey-in/dreamer"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 py-2.5 rounded-lg border border-white/10 bg-white/5 text-zinc-300"
                >
                  <Github className="w-5 h-5" />
                  <span>Star on GitHub</span>
                </a>
                <button
                  className="w-full py-2.5 rounded-lg border border-white/10 bg-white/5 text-zinc-300"
                  onClick={goToConsole}
                >
                  Log in
                </button>
                <a
                  href="/register"
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-lg shadow-blue-500/20 text-center"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Sign up
                </a>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-[90vh] md:min-h-screen flex items-center justify-center pt-24 overflow-hidden bg-black">
        <div className="absolute inset-0 z-0 pointer-events-none">
          <Image src="/hero.svg" alt="" fill sizes="100vw" className="object-cover" />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-black z-10 pointer-events-none" />

        <div className="max-w-7xl mx-auto px-6 relative z-20 w-full text-center flex flex-col items-center">

          {/* Badge */}
          {/* <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mb-4 inline-flex items-center gap-2 px-3 py-1 rounded-full border border-blue-500/35 bg-blue-500/10 text-blue-300 text-xs font-medium tracking-wide shadow-inner shadow-blue-500/10"
          >
            <span>Open Source PaaS Engine</span>
          </motion.div> */}
          {/* Lifetime-free line — deliberately small and separate from the
              badge above, so it reads as an urgent aside, not a rebrand. */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mb-4 text-xs font-semibold text-emerald-400 tracking-wide"
          >
            Lifetime free for first 50 users
          </motion.div>

          {/* Heading */}
          <motion.h1
            variants={headlineContainer}
            initial="hidden"
            animate="visible"
            className="text-4xl md:text-7xl font-extrabold tracking-tight max-w-5xl leading-none mb-6"
          >
            <motion.span variants={headlineLine} className="block bg-clip-text text-transparent bg-gradient-to-b from-white via-zinc-100 to-zinc-400">
              Your Own Vercel,
            </motion.span>
            <motion.span variants={headlineLine} className="block bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-white">
              Deploy free or self-host.
            </motion.span>
          </motion.h1>

          {/* Subheading */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="text-lg md:text-xl text-zinc-400 max-w-3xl leading-relaxed mb-10"
          >
            Connect a GitHub repo and get a live URL in minutes — hosted free on our cloud, or run the whole platform yourself. Auto-detects your framework, builds static or dynamic apps, and redeploys automatically on every push.
          </motion.p>

          {/* Actions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
            className="flex flex-col sm:flex-row items-center gap-4 mb-16 w-full max-w-md sm:max-w-none justify-center"
          >
            <MagneticButton
              href="/register"
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium rounded-full shadow-lg shadow-blue-500/25 transition-colors"
            >
              Get Started
              <ArrowRight className="w-4 h-4" />
            </MagneticButton>
            <Link
              href="/docs/self-hosting"
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 bg-white/5 hover:bg-white/10 text-white font-medium rounded-full border border-white/10 hover:border-white/20 transition-all"
            >
              <Server className="w-4 h-4 text-blue-400" />
              Self host?
            </Link>
          </motion.div>


        </div>
      </section>

      {/* At a glance — real numbers pulled from the mechanisms described below */}
      <motion.section
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="border-y border-zinc-900 bg-black py-12"
      >
        <div className="max-w-4xl mx-auto px-6 grid grid-cols-3 divide-x divide-zinc-900">
          <div className="text-center px-4">
            <div className="text-3xl md:text-4xl font-extrabold text-white tabular-nums">
              &lt;<StatCounter value={3} />
              <span className="text-blue-400">m</span>
            </div>
            <p className="text-xs text-zinc-500 mt-2">repo to running deployment</p>
          </div>
          <div className="text-center px-4">
            <div className="text-3xl md:text-4xl font-extrabold text-white tabular-nums">
              &lt;<StatCounter value={1} />
              <span className="text-blue-400">m</span>
            </div>
            <p className="text-xs text-zinc-500 mt-2">push to live redeploy</p>
          </div>
          <div className="text-center px-4">
            <div className="text-3xl md:text-4xl font-extrabold text-white tabular-nums">
              ~<StatCounter value={50} />
              <span className="text-blue-400">MB</span>
            </div>
            <p className="text-xs text-zinc-500 mt-2">final container image size</p>
          </div>
        </div>
      </motion.section>

      {/* Bento Grid Features Section */}
      <section id="features" className="py-24 relative bg-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Core Engine Capabilities</h2>
            <p className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Engineered for absolute efficiency
            </p>
            <p className="text-zinc-500 mt-4 max-w-xl mx-auto">
              Dreamer goes beyond standard tutorials to deliver complex mechanisms built for real production workloads — hosted for you, or self-hosted on your own infrastructure.
            </p>
          </div>

          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6"
          >
            {/* Bento Card 1: Static + Dynamic Builds, Auto-Deploy on Commit */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="md:col-span-2 group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/5 rounded-full blur-3xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
                <GitBranch className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-blue-300 transition-colors">Static & Dynamic Builds, Auto-Deployed on Every Commit</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Ship a static site or a full server-rendered app — Dreamer detects which one your repo needs and builds accordingly. Push to your production branch and that exact commit redeploys automatically, no manual trigger required.
              </p>
              <div className="flex flex-wrap gap-2 text-xs font-mono text-zinc-500">
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">Static + Dynamic</span>
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">GitHub Webhook</span>
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">Pinned to commit SHA</span>
              </div>
            </motion.div>

            {/* Bento Card 2: Dual Execution */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-2xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
                <Server className="w-6 h-6 text-indigo-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-indigo-300 transition-colors">Dual Engine Abstraction</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Deploy to ECS Fargate for cloud orchestration, or route to local Docker containers and NGINX on bare-metal. The worker interacts with a unified execution interface.
              </p>
              <span className="text-xs font-mono bg-zinc-900 border border-zinc-800 px-2 py-1 rounded text-zinc-500">
                DEPLOYMENT_ENVIRONMENT=cloud|bare_metal
              </span>
            </motion.div>

            {/* Bento Card 3: Real-Time Log Pipeline */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-2xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
                <Activity className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-blue-300 transition-colors">Real-Time Log Pipeline</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Build logs stream in real-time from the ECS build container using Redis Pub/Sub directly to Server-Sent Events (SSE). Concurrently saves to PostgreSQL with sequence numbers for gapless history.
              </p>
              <span className="text-xs font-mono bg-zinc-900 border border-zinc-800 px-2 py-1 rounded text-zinc-500">
                SSE + Redis Pub/Sub + PG GIN index
              </span>
            </motion.div>

            {/* Bento Card 4: Framework Detection */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="md:col-span-2 group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-500/5 rounded-full blur-3xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
                <Cpu className="w-6 h-6 text-indigo-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-indigo-300 transition-colors">Zero-Config Framework Detection</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Scans package configuration to identify Next.js (SSR vs export), React, Vue, Svelte, Express, or static HTML. Auto-generates high-performance multi-stage Dockerfiles (~50MB final images) to speed up pulls and deployments.
              </p>
              <div className="flex gap-4 items-center">
                <span className="text-xs font-mono text-zinc-500 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">No configs needed</span>
                <div className="flex gap-3 text-zinc-600 text-sm font-semibold">
                  <span className="hover:text-white transition-colors cursor-default">Next.js</span>
                  <span className="hover:text-white transition-colors cursor-default">Vite</span>
                  <span className="hover:text-white transition-colors cursor-default">Express</span>
                  <span className="hover:text-white transition-colors cursor-default">HTML</span>
                </div>
              </div>
            </motion.div>

            {/* Bento Card 5: Postgres Trigger State Machine */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="md:col-span-2 group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/5 rounded-full blur-3xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
                <Database className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-blue-300 transition-colors">Postgres State Machine Trigger</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Application-layer status updates can fail under heavy race conditions or double worker pick-ups. Dreamer enforces strict state machine transitions directly inside the database via PostgreSQL triggers, preventing concurrent updates or double-queues.
              </p>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                <span className="text-xs font-mono text-zinc-400">Enforced: QUEUED ➔ BUILDING ➔ UPLOADING/STARTING ➔ RUNNING</span>
              </div>
            </motion.div>

            {/* Bento Card 6: Security */}
            <motion.div
              variants={fadeInUpVariants}
              whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
              className="group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-2xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
                <Lock className="w-6 h-6 text-indigo-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-indigo-300 transition-colors">AES-256-GCM Secure Env Storage</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Variables and keys are encrypted using AES-256-GCM with a unique initialization vector (IV) per value. Decrypted dynamically only at container initialization inside Fargate.
              </p>
              <span className="text-xs font-mono bg-zinc-900 border border-zinc-800 px-2 py-1 rounded text-zinc-500">
                IV per value + Audit Log
              </span>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Quick Start + Docs Teaser */}
      <section id="get-started" className="py-24 border-t border-zinc-900 bg-black relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[350px] bg-blue-500/5 rounded-full blur-3xl -z-10 pointer-events-none" />

        <div className="max-w-5xl mx-auto px-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="text-center mb-14"
          >
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Get Started</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Host Your Own Platform
            </h3>
            <p className="text-zinc-500 mt-4 max-w-xl mx-auto">
              Clone the repo and you&apos;re running locally in a few minutes. Architecture,
              self-hosting, and AWS setup guides live in the docs.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}
            className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-6 mb-12 relative max-w-2xl mx-auto"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Terminal className="w-4 h-4 text-blue-400" />
                <span className="font-bold text-white text-sm">Quick Start</span>
              </div>
              <button
                onClick={() =>
                  handleCopy(
                    "git clone https://github.com/SamanPandey-in/dreamer.git\ncd dreamer\npnpm install\npnpm dev",
                    "quickstart"
                  )
                }
                className="p-2 text-zinc-400 hover:text-white transition-colors hover:bg-white/5 rounded-lg"
                aria-label="Copy code block"
              >
                {copiedText === "quickstart" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-xs font-mono text-zinc-300">
              <code>{`git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer
pnpm install
pnpm run setup
pnpm dev`}</code>
            </pre>
          </motion.div>

          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-80px" }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6"
          >
            {[
              {
                icon: Cpu,
                title: "Architecture Overview",
                desc: "Every service, how they talk to each other, and the full request lifecycle.",
                href: "/docs/architecture"
              },
              {
                icon: Database,
                title: "Self-Hosting Guide",
                desc: "Run the platform itself \u2014 dashboard, API, reverse proxy \u2014 on a VPS/EC2 box.",
                href: "/docs/self-hosting"
              },
              {
                icon: Cloud,
                title: "AWS Console Setup",
                desc: "Provisioning ECS, ECR, and Lambda IAM that deployments need.",
                href: "/docs/aws-setup"
              }
            ].map((item) => (
              <motion.a
                key={item.href}
                href={item.href}
                variants={fadeInUpVariants}
                whileHover={{ y: -6, transition: { duration: 0.2, ease: "easeOut" } }}
                className="group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-6 hover:border-blue-500/30 transition-colors duration-300 flex flex-col"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-4">
                  <item.icon className="w-5 h-5 text-blue-400" />
                </div>
                <h4 className="font-bold text-white mb-2 group-hover:text-blue-300 transition-colors">{item.title}</h4>
                <p className="text-zinc-500 text-sm leading-relaxed mb-4 flex-1">{item.desc}</p>
                <span className="text-xs font-semibold text-blue-400 flex items-center gap-1">
                  Read docs <ArrowRight className="w-3.5 h-3.5" />
                </span>
              </motion.a>
            ))}
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-center mt-12"
          >
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white/5 hover:bg-white/10 text-white font-medium rounded-full border border-white/10 hover:border-white/20 transition-all"
            >
              <BookOpen className="w-4 h-4 text-blue-400" />
              Browse Full Documentation
            </Link>
          </motion.div>
        </div>
      </section>


      {/* Final CTA Banner */}
      <section className="py-24 border-t border-zinc-900 bg-black relative">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="max-w-5xl mx-auto px-6 text-center"
        >
          <h2 className="text-3xl md:text-5xl font-extrabold mb-6">
            Take Control of Your Deployments
          </h2>
          <p className="text-zinc-400 text-lg max-w-xl mx-auto mb-10">
            Set up your own platform in under 3 minutes. Free yourself from restrictive plans and high cloud bills.
          </p>
          <MagneticButton
            href="/docs/self-hosting"
            className="inline-flex items-center gap-2 px-8 py-4 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-colors shadow-xl"
          >
            Deploy Your PaaS
            <ArrowRight className="w-5 h-5" />
          </MagneticButton>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-black py-12 text-center text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <Image src="/logo-dark.svg" alt="" width={24} height={24} className="w-6 h-6" />
            <span className="font-bold text-white">Dreamer PaaS</span>
          </div>

          <div className="flex flex-wrap justify-center gap-6">
            <a href="https://github.com/SamanPandey-in/dreamer" className="hover:text-white transition-colors">GitHub Repository</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <Link href="/docs" className="hover:text-white transition-colors">Documentation</Link>
          </div>

          <div className="flex items-center gap-1">
            <span>Built by</span>
            <a
              href="https://github.com/SamanPandey-in"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-300 hover:text-white transition-colors font-semibold"
            >
              Saman Pandey
            </a>
          </div>
        </div>
      </footer>

    </div>
    </MotionConfig>
  );
}
