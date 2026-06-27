"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  ArrowRight,
  Check,
  Copy,
  Server,
  Zap,
  Database,
  Lock,
  Shield,
  Cpu,
  Layers,
  Activity,
  ChevronDown,
  Moon,
  Play,
  RefreshCw,
  Search,
  Menu,
  X,
  Cloud,
  Settings,
  AlertTriangle
} from "lucide-react";
import { GithubIcon as Github } from "../components/icons";
import { useAuth } from "./providers";
import { useRouter } from "next/navigation";

const GodRays = dynamic(
  () =>
    import("@paper-design/shaders-react").then((mod) => {
      return mod.GodRays;
    }),
  { ssr: false }
);

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("https://github.com/SamanPandey-in/dreamer");
  const [deployStep, setDeployStep] = useState<number>(-1);
  const [isDeploying, setIsDeploying] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [activeArchTab, setActiveArchTab] = useState<"deploy" | "scale">("deploy");
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [activeFaq, setActiveFaq] = useState<number | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const router = useRouter();
  const { user, loading } = useAuth();

  const goToConsole = () => {
    setMobileMenuOpen(false);
    router.push(loading ? "/login" : user ? "/dashboard" : "/login");
  };

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [terminalLogs]);

  const handleDeploy = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDeploying) return;
    setIsDeploying(true);
    setDeployStep(0);
    setTerminalLogs([]);

    const steps = [
      { text: "⏳ Initializing build worker...", delay: 600 },
      { text: "✔ Worker allocated (concurrency slot 1/3)", delay: 800 },
      { text: "🛰 Cloning repository: " + repoUrl, delay: 1000 },
      { text: "📂 Git clone complete. Commits fetched: 42", delay: 600 },
      { text: "🔍 Analyzing framework configuration...", delay: 800 },
      { text: "⚡ Detected Next.js project with SSR configurations.", delay: 800 },
      { text: "🛠 Launching ephemeral build runner on ECS Fargate...", delay: 1000 },
      { text: "📦 Running: npm run build", delay: 1200 },
      { text: "🐳 Creating multi-stage Docker build (Builder -> Runner)...", delay: 1200 },
      { text: "🔼 Tagging and pushing image: dreamer-app-latest to ECR...", delay: 1000 },
      { text: "🔒 Decrypting secrets (AES-256-GCM) for container injection...", delay: 800 },
      { text: "🚀 Updating ECS Service: scaling desiredCount to 1...", delay: 1000 },
      { text: "🧬 Registering ALB Listener Rule for custom host routing...", delay: 800 },
      { text: "🌐 ALB host bound: https://dreamer-app.dreamer.samanp.xyz", delay: 600 },
      { text: "📈 Running health check... PASS (HTTP 200)", delay: 1000 },
      { text: "✨ DEPLOYMENT SUCCESSFUL! Status: RUNNING (Ready in 2.8 minutes)", delay: 0 }
    ];

    let currentStep = 0;
    const runNextStep = () => {
      if (currentStep < steps.length) {
        setTerminalLogs(prev => [...prev, steps[currentStep].text]);
        setDeployStep(currentStep);
        setTimeout(() => {
          currentStep++;
          runNextStep();
        }, steps[currentStep].delay);
      } else {
        setIsDeploying(false);
      }
    };

    runNextStep();
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const toggleFaq = (index: number) => {
    setActiveFaq(activeFaq === index ? null : index);
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

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-sans selection:bg-blue-500/30 selection:text-blue-200">

      {/* Dynamic Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-black/40 backdrop-blur-md border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
              <Zap className="w-4 h-4 text-white animate-pulse" />
            </div>
            <span className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-blue-100 to-indigo-200">
              Dreamer
            </span>
          </div>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-zinc-400 hover:text-white transition-colors">Features</a>
            <a href="#architecture" className="text-sm text-zinc-400 hover:text-white transition-colors">Architecture</a>
            <a href="#tech-stack" className="text-sm text-zinc-400 hover:text-white transition-colors">Tech Stack</a>
            <a href="#self-hosting" className="text-sm text-zinc-400 hover:text-white transition-colors">Self-Hosting</a>
            <a href="#faq" className="text-sm text-zinc-400 hover:text-white transition-colors">FAQ</a>
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
            <button className="relative group overflow-hidden rounded-full p-[1px] focus:outline-none" onClick={goToConsole}>
              <span className="absolute inset-0 bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full group-hover:opacity-100 transition duration-500"></span>
              <span className="relative block px-4 py-1.5 bg-black rounded-full text-sm font-medium text-white transition duration-200 group-hover:bg-transparent">
                Launch Console
              </span>
            </button>
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
              <a href="#architecture" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>Architecture</a>
              <a href="#tech-stack" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>Tech Stack</a>
              <a href="#self-hosting" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>Self-Hosting</a>
              <a href="#faq" className="text-zinc-300 hover:text-white transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>FAQ</a>
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
                <button className="w-full py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 font-medium text-white shadow-lg shadow-blue-500/20" onClick={goToConsole}>
                  Launch Console
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-[90vh] md:min-h-screen flex items-center justify-center pt-24 overflow-hidden bg-black">
        <div className="absolute inset-0 w-full h-[650px] md:h-full z-0 overflow-hidden pointer-events-none opacity-90">
          <GodRays
            width="100%"
            height="100%"
            colors={["#002c856e", "#0091fff0", "#ffffff"]}
            colorBack="#000000"
            colorBloom="#0000ff"
            bloom={0.4}
            intensity={0.8}
            density={0.3}
            spotty={0.3}
            midSize={0.2}
            midIntensity={0.4}
            speed={0.75}
            offsetY={-0.55}
            fit="cover"
          />
        </div>

        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-black z-10 pointer-events-none" />

        <div className="max-w-7xl mx-auto px-6 relative z-20 w-full text-center flex flex-col items-center">

          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="mb-6 inline-flex items-center gap-2 px-3 py-1 rounded-full border border-blue-500/35 bg-blue-500/10 text-blue-300 text-xs font-medium tracking-wide shadow-inner shadow-blue-500/10"
          >
            <Zap className="w-3.5 h-3.5 text-blue-400" />
            <span>Open Source PaaS Engine</span>
          </motion.div>

          {/* Heading */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="text-4xl md:text-7xl font-extrabold tracking-tight max-w-5xl leading-none mb-6"
          >
            <span className="bg-clip-text text-transparent bg-gradient-to-b from-white via-zinc-100 to-zinc-400">
              Your Own Vercel & Railway,
            </span>
            <br />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-white">
              Self-Hosted In Under 3 Mins
            </span>
          </motion.h1>

          {/* Subheading */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="text-lg md:text-xl text-zinc-400 max-w-3xl leading-relaxed mb-10"
          >
            Clones your repositories, auto-detects frameworks, containerizes applications, provisions wildcard routing subdomains, streams build logs, and scales to zero when idle. AWS or local Docker.
          </motion.p>

          {/* Actions */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.5 }}
            className="flex flex-col sm:flex-row items-center gap-4 mb-16 w-full max-w-md sm:max-w-none justify-center"
          >
            <a
              href="#self-hosting"
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium rounded-full shadow-lg shadow-blue-500/25 transition-all transform hover:scale-[1.02]"
            >
              Get Started Free
              <ArrowRight className="w-4 h-4" />
            </a>
            <a
              href="#architecture"
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3.5 bg-white/5 hover:bg-white/10 text-white font-medium rounded-full border border-white/10 hover:border-white/20 transition-all"
            >
              <Cpu className="w-4 h-4 text-blue-400" />
              Explore Architecture
            </a>
          </motion.div>

          {/* Interactive Deploy Simulator Card */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            className="w-full max-w-3xl bg-zinc-950/80 backdrop-blur-md rounded-2xl border border-zinc-800 shadow-2xl shadow-blue-500/5 p-6 md:p-8 text-left relative overflow-hidden"
          >
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl -z-10" />
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl -z-10" />

            <div className="flex items-center justify-between mb-6 pb-4 border-b border-zinc-800/80">
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-full bg-red-500/80" />
                <span className="w-3.5 h-3.5 rounded-full bg-yellow-500/80" />
                <span className="w-3.5 h-3.5 rounded-full bg-green-500/80" />
                <span className="text-xs font-mono text-zinc-500 ml-2">git-deploy-worker-01</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                <span>PaaS Engine Online</span>
              </div>
            </div>

            <form onSubmit={handleDeploy} className="flex flex-col md:flex-row gap-3 mb-6">
              <div className="relative flex-1">
                <Github className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/username/repository"
                  disabled={isDeploying}
                  className="w-full pl-12 pr-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-60"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={isDeploying}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-blue-500/10 transition-colors disabled:opacity-60"
              >
                {isDeploying ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Deploy Project
                  </>
                )}
              </button>
            </form>

            {/* Simulated Log Output Terminal */}
            <div className="bg-black/90 border border-zinc-800/60 rounded-xl p-4 font-mono text-xs text-zinc-400 min-h-[180px] max-h-[260px] overflow-y-auto flex flex-col gap-1.5 scrollbar-thin">
              {terminalLogs.length === 0 ? (
                <div className="text-zinc-600 flex flex-col items-center justify-center h-[160px] text-center">
                  <Terminal className="w-8 h-8 mb-2 opacity-50" />
                  <p>Paste a GitHub URL above and click Deploy to view the deployment trace.</p>
                </div>
              ) : (
                <>
                  {terminalLogs.map((log, index) => {
                    const isSuccess = log.includes("SUCCESSFUL");
                    const isWarning = log.includes("Detected") || log.includes("Decrypting");
                    return (
                      <div
                        key={index}
                        className={`transition-all duration-300 ${isSuccess
                          ? "text-emerald-400 font-bold bg-emerald-950/20 px-2 py-1 rounded"
                          : isWarning
                            ? "text-blue-300"
                            : "text-zinc-300"
                          }`}
                      >
                        {log}
                      </div>
                    );
                  })}
                  {isDeploying && (
                    <div className="flex items-center gap-2 text-blue-400 mt-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                      <span>Processing...</span>
                    </div>
                  )}
                  <div ref={terminalEndRef} />
                </>
              )}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Bento Grid Features Section */}
      <section id="features" className="py-24 relative bg-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Core Engine Capabilities</h2>
            <p className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Engineered for absolute efficiency
            </p>
            <p className="text-zinc-500 mt-4 max-w-xl mx-auto">
              Dreamer goes beyond standard tutorials to deliver complex mechanisms built for real, self-hosted workloads.
            </p>
          </div>

          <motion.div
            variants={containerVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-100px" }}
            className="grid grid-cols-1 md:grid-cols-3 gap-6"
          >
            {/* Bento Card 1: Scale-to-Zero */}
            <motion.div
              variants={fadeInUpVariants}
              className="md:col-span-2 group relative overflow-hidden bg-zinc-950/40 border border-zinc-800/80 rounded-2xl p-8 hover:border-blue-500/30 transition-all duration-300"
            >
              <div className="absolute top-0 right-0 w-80 h-80 bg-blue-500/5 rounded-full blur-3xl -z-10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
                <Moon className="w-6 h-6 text-blue-400" />
              </div>
              <h3 className="text-xl font-bold mb-3 group-hover:text-blue-300 transition-colors">Smart Scale-to-Zero</h3>
              <p className="text-zinc-400 text-sm leading-relaxed mb-4">
                Dynamic app deployments receiving no traffic for 15 minutes scale automatically to <code className="text-blue-300 bg-blue-950/30 px-1 py-0.5 rounded text-xs">desiredCount: 0</code> on ECS, halting active charges. Wakes up in seconds on subsequent requests using a distributed lock to prevent cold-start bottlenecks.
              </p>
              <div className="flex flex-wrap gap-2 text-xs font-mono text-zinc-500">
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">Redis SET NX Dedup</span>
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">3s Browser Polling</span>
                <span className="bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">API 503 fallback</span>
              </div>
            </motion.div>

            {/* Bento Card 2: Dual Execution */}
            <motion.div
              variants={fadeInUpVariants}
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

      {/* Architecture Interactive Section */}
      <section id="architecture" className="py-24 border-t border-zinc-900 bg-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Internal Mechanics</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              System Architecture Under the Hood
            </h3>
            <p className="text-zinc-500 mt-4 max-w-xl mx-auto">
              Compare the mechanics of project deployments versus scale-to-zero wake loops.
            </p>
          </div>

          <div className="flex justify-center mb-10">
            <div className="flex bg-zinc-900/80 p-1 rounded-xl border border-zinc-800">
              <button
                onClick={() => setActiveArchTab("deploy")}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeArchTab === "deploy"
                  ? "bg-blue-600 text-white shadow"
                  : "text-zinc-400 hover:text-white"
                  }`}
              >
                1. Deployment Pipeline
              </button>
              <button
                onClick={() => setActiveArchTab("scale")}
                className={`px-5 py-2.5 rounded-lg text-sm font-semibold transition-all ${activeArchTab === "scale"
                  ? "bg-blue-600 text-white shadow"
                  : "text-zinc-400 hover:text-white"
                  }`}
              >
                2. Scale-To-Zero Loop
              </button>
            </div>
          </div>

          <div className="bg-zinc-950/60 border border-zinc-900 rounded-2xl p-6 md:p-10 relative overflow-hidden">
            <div className="absolute inset-0 bg-grid-pattern opacity-30 pointer-events-none" />

            <AnimatePresence mode="wait">
              {activeArchTab === "deploy" ? (
                <motion.div
                  key="deploy"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.3 }}
                  className="relative z-10"
                >
                  <div className="text-left mb-8">
                    <h4 className="text-lg font-bold text-white mb-2">Deploy pipeline workflow</h4>
                    <p className="text-zinc-400 text-sm">
                      When a new deploy job is triggered, the request is immediately enqueued on BullMQ and returns a response in under 5ms, processing the build pipeline asynchronously.
                    </p>
                  </div>

                  {/* Deploy Pipeline Flow Diagram */}
                  <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-center">
                    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center mb-3">
                        <Terminal className="w-5 h-5 text-blue-400" />
                      </div>
                      <span className="text-xs font-mono text-blue-300 mb-1">API Server</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Receives request, verifies HMAC, queues job in &lt;5ms</p>
                    </div>

                    <div className="flex justify-center text-zinc-700 font-bold rotate-90 lg:rotate-0">
                      <ArrowRight className="w-6 h-6 animate-pulse text-blue-500" />
                    </div>

                    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mb-3">
                        <Database className="w-5 h-5 text-indigo-400" />
                      </div>
                      <span className="text-xs font-mono text-indigo-300 mb-1">BullMQ + Redis</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Manages concurrency limiting (max 3 runs) and retries</p>
                    </div>

                    <div className="flex justify-center text-zinc-700 font-bold rotate-90 lg:rotate-0">
                      <ArrowRight className="w-6 h-6 animate-pulse text-indigo-500" />
                    </div>

                    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-blue-500/10 border border-blue-500/30 flex items-center justify-center mb-3">
                        <Cpu className="w-5 h-5 text-blue-400" />
                      </div>
                      <span className="text-xs font-mono text-blue-300 mb-1">Build Worker</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Clones repo, detects framework, builds static or Docker build</p>
                    </div>

                    <div className="lg:col-span-5 flex justify-center py-2 rotate-90 lg:rotate-0">
                      <ArrowRight className="w-6 h-6 text-zinc-700 hidden lg:block rotate-90" />
                    </div>

                    {/* Dual branch split */}
                    <div className="lg:col-span-2 p-5 bg-zinc-900/60 border border-zinc-800/80 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-3">
                        <Cloud className="w-5 h-5 text-emerald-400" />
                      </div>
                      <span className="text-xs font-mono text-emerald-300 mb-1">Static Path</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Uploads build artifacts directly to Amazon S3 for proxy streaming</p>
                    </div>

                    <div className="lg:col-span-1 text-center text-zinc-600 text-xs font-mono">
                      OR
                    </div>

                    <div className="lg:col-span-2 p-5 bg-zinc-900/60 border border-zinc-800/80 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mb-3">
                        <Layers className="w-5 h-5 text-indigo-400" />
                      </div>
                      <span className="text-xs font-mono text-indigo-300 mb-1">Dynamic Path</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Pushes image to ECR ➔ Updates ECS Service ➔ Configures ALB routing rule</p>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="scale"
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  transition={{ duration: 0.3 }}
                  className="relative z-10"
                >
                  <div className="text-left mb-8">
                    <h4 className="text-lg font-bold text-white mb-2">Idle detection & scale loop</h4>
                    <p className="text-zinc-400 text-sm">
                      Dreamer scales dynamic containers down to zero when idle to save resources, waking them on the next inbound request.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-center">
                    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center mb-3">
                        <Search className="w-5 h-5 text-yellow-400" />
                      </div>
                      <span className="text-xs font-mono text-yellow-300 mb-1">1. Idle Detector</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Scans DB every 60s for containers running with 15 mins no traffic</p>
                    </div>

                    <div className="flex justify-center text-zinc-700 font-bold rotate-90 lg:rotate-0">
                      <ArrowRight className="w-6 h-6 text-yellow-500" />
                    </div>

                    <div className="p-5 bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col items-center justify-center text-center">
                      <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mb-3">
                        <Moon className="w-5 h-5 text-red-400" />
                      </div>
                      <span className="text-xs font-mono text-red-300 mb-1">2. Sleep Worker</span>
                      <p className="text-[11px] text-zinc-500 leading-normal">Updates state in Redis to <code className="text-[10px] text-red-300">sleeping</code>, scales ECS desired count to 0</p>
                    </div>

                    <div className="flex justify-center text-zinc-700 font-bold rotate-90 lg:rotate-0">
                      <ArrowRight className="w-6 h-6 text-red-500" />
                    </div>

                    <div className="lg:col-span-4 p-4 bg-zinc-900/60 border border-zinc-800 rounded-xl">
                      <h5 className="text-xs font-bold text-white mb-2 font-mono">Inbound Traffic Event (Cold Start)</h5>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-left">
                        <div className="p-3 bg-black/60 rounded border border-zinc-800 text-[11px] text-zinc-400">
                          <strong className="text-white block mb-1">Proxy Lookup</strong>
                          Proxy checks Redis state. If sleeping, intercepts and serves a loading page.
                        </div>
                        <div className="p-3 bg-black/60 rounded border border-zinc-800 text-[11px] text-zinc-400">
                          <strong className="text-white block mb-1">Mutex Lock</strong>
                          Enqueues wake job in BullMQ using Redis <code className="text-blue-300 text-[10px]">SET NX</code> to deduplicate requests.
                        </div>
                        <div className="p-3 bg-black/60 rounded border border-zinc-800 text-[11px] text-zinc-400">
                          <strong className="text-white block mb-1">Scale & Route</strong>
                          ECS scales to 1, proxy polls health endpoint, then redirects all requests.
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </section>

      {/* Tech Stack Layer Table */}
      <section id="tech-stack" className="py-24 border-t border-zinc-900 bg-black">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Architectural Foundation</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Technology Stack Decoded
            </h3>
            <p className="text-zinc-500 mt-4 max-w-xl mx-auto">
              A carefully selected set of tools optimized for reliability, isolation, and cost structure.
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-zinc-800">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-zinc-900/50 border-b border-zinc-800 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                  <th className="py-5 px-6">System Layer</th>
                  <th className="py-5 px-6">Technology</th>
                  <th className="py-5 px-6">Design Decision rationale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900 text-sm text-zinc-300 bg-black/50">
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">API Server</td>
                  <td className="py-4 px-6 font-mono text-blue-400">Node.js, Express, TypeScript</td>
                  <td className="py-4 px-6 text-zinc-400">Familiar ecosystem, fast iteration, native AWS SDK v3 integration.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">Task Queue</td>
                  <td className="py-4 px-6 font-mono text-blue-400">BullMQ + Redis</td>
                  <td className="py-4 px-6 text-zinc-400">Persistent job handling, retry logic, concurrency limit, and Bull Board UI dashboard.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">Database</td>
                  <td className="py-4 px-6 font-mono text-blue-400">PostgreSQL 16 + Prisma</td>
                  <td className="py-4 px-6 text-zinc-400">Append-only deployment log persistence, full-text tsvector search index, DB triggers.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">Build Runner</td>
                  <td className="py-4 px-6 font-mono text-blue-400">ECS Fargate (RunTask)</td>
                  <td className="py-4 px-6 text-zinc-400">Completely isolated VM environments per build to guarantee security and zero crosstalk.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">App Runtime</td>
                  <td className="py-4 px-6 font-mono text-blue-400">ECS Service + ALB</td>
                  <td className="py-4 px-6 text-zinc-400">Dynamic app instances behind host-based listener rules, supporting seamless routing.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">Log Pipeline</td>
                  <td className="py-4 px-6 font-mono text-blue-400">SSE + Redis Pub/Sub</td>
                  <td className="py-4 px-6 text-zinc-400">SSE requires no client-side socket dependencies (~40KB bundle saved) and supports auto-reconnection.</td>
                </tr>
                <tr className="hover:bg-zinc-900/30 transition-colors">
                  <td className="py-4 px-6 font-semibold text-white">Encrypted Secrets</td>
                  <td className="py-4 px-6 font-mono text-blue-400">AES-256-GCM</td>
                  <td className="py-4 px-6 text-zinc-400">Authenticated encryption prevent cipher tampering. A unique IV per value blocks dictionary attacks.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Self Hosting CLI Center */}
      <section id="self-hosting" className="py-24 border-t border-zinc-900 bg-black relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[350px] bg-blue-500/5 rounded-full blur-3xl -z-10 pointer-events-none" />

        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Get Started</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Host Your Own Platform
            </h3>
            <p className="text-zinc-500 mt-4">
              Deploy Dreamer locally on your machine or deploy the CDK infrastructure to your AWS account.
            </p>
          </div>

          <div className="flex flex-col gap-8">
            {/* Step 1 */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-6 relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-xs font-semibold flex items-center justify-center font-mono">1</span>
                  <span className="font-bold text-white text-sm">Clone & Install Dependencies</span>
                </div>
                <button
                  onClick={() => handleCopy("git clone https://github.com/SamanPandey-in/dreamer.git\ncd dreamer\npnpm install", "step1")}
                  className="p-2 text-zinc-400 hover:text-white transition-colors hover:bg-white/5 rounded-lg"
                  aria-label="Copy code block"
                >
                  {copiedText === "step1" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-xs font-mono text-zinc-300">
                <code>{`git clone https://github.com/SamanPandey-in/dreamer.git
cd dreamer
pnpm install`}</code>
              </pre>
            </div>

            {/* Step 2 */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-6 relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-xs font-semibold flex items-center justify-center font-mono">2</span>
                  <span className="font-bold text-white text-sm">Setup Env Configuration</span>
                </div>
                <button
                  onClick={() => handleCopy("cp apps/api/.env.example apps/api/.env\ncp apps/build-engine/.env.example apps/build-engine/.env\ncp apps/reverse-proxy/.env.example apps/reverse-proxy/.env\ncp apps/frontend/.env.example apps/frontend/.env.local", "step2")}
                  className="p-2 text-zinc-400 hover:text-white transition-colors hover:bg-white/5 rounded-lg"
                  aria-label="Copy code block"
                >
                  {copiedText === "step2" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-xs font-mono text-zinc-300">
                <code>{`cp apps/api/.env.example apps/api/.env
cp apps/build-engine/.env.example apps/build-engine/.env
cp apps/reverse-proxy/.env.example apps/reverse-proxy/.env
cp apps/frontend/.env.example apps/frontend/.env.local`}</code>
              </pre>
            </div>

            {/* Step 3 */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-6 relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-xs font-semibold flex items-center justify-center font-mono">3</span>
                  <span className="font-bold text-white text-sm">Start Local Infrastructure & DB</span>
                </div>
                <button
                  onClick={() => handleCopy("docker compose up -d\ncd apps/api\npnpm prisma migrate deploy\npnpm prisma generate", "step3")}
                  className="p-2 text-zinc-400 hover:text-white transition-colors hover:bg-white/5 rounded-lg"
                  aria-label="Copy code block"
                >
                  {copiedText === "step3" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-xs font-mono text-zinc-300">
                <code>{`docker compose up -d
cd apps/api
pnpm prisma migrate deploy
pnpm prisma generate`}</code>
              </pre>
            </div>

            {/* Step 4 */}
            <div className="bg-zinc-950/80 border border-zinc-900 rounded-2xl p-6 relative">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-lg bg-blue-600/10 border border-blue-500/20 text-blue-400 text-xs font-semibold flex items-center justify-center font-mono">4</span>
                  <span className="font-bold text-white text-sm">Run Dev Mode</span>
                </div>
                <button
                  onClick={() => handleCopy("pnpm dev", "step4")}
                  className="p-2 text-zinc-400 hover:text-white transition-colors hover:bg-white/5 rounded-lg"
                  aria-label="Copy code block"
                >
                  {copiedText === "step4" ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <pre className="bg-black border border-zinc-900 rounded-xl p-4 overflow-x-auto text-xs font-mono text-zinc-300">
                <code>{`# Run local development with bare-metal Docker engine
pnpm dev`}</code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Accordion Section */}
      <section id="faq" className="py-24 border-t border-zinc-900 bg-black">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-xs font-semibold tracking-wider text-blue-400 uppercase mb-3">Objections Answered</h2>
            <h3 className="text-3xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-b from-white to-zinc-400">
              Frequently Asked Questions
            </h3>
          </div>

          <div className="flex flex-col gap-4">
            {[
              {
                q: "Why BullMQ instead of Amazon SQS?",
                a: "SQS is highly scalable but introduces network request overhead and lacks advanced features natively. BullMQ provides per-job retry configurations, priority queues, exact concurrency limiting, rate limiting, and a live tracking UI (Bull Board) without adding cloud costs or IAM complexity. For single-region PaaS systems, Redis is an ideal and faster dependency."
              },
              {
                q: "Why Server-Sent Events (SSE) instead of WebSockets for log streaming?",
                a: "Log streaming is fundamentally unidirectional (server to client). SSE handles this natively over HTTP/1.1 without socket upgrade headers, automatically handles client reconnections, works seamlessly through standard reverse proxies, and saves ~40KB of client JS bundles by avoiding heavyweight WebSocket clients."
              },
              {
                q: "Why PostgreSQL tsvector instead of Elasticsearch for log search?",
                a: "At the scale of a self-hosted platform, Postgres tsvector with a GIN index queries logs in milliseconds without the resource footprint of Elasticsearch. Avoiding Elasticsearch removes operational complexity and virtual memory constraints from hosting another cluster."
              },
              {
                q: "Why AES-256-GCM with per-value IV instead of single column key?",
                a: "GCM is an authenticated encryption scheme—if encrypted data is tampered with, decryption fails explicitly rather than outputting garbage data. Using a unique initialization vector (IV) per database row guarantees that identical environment variables yield different ciphertexts, preventing dictionary matching attacks."
              },
              {
                q: "Why are deployment state transitions enforced by database triggers?",
                a: "Application-level state validation fails under high-concurrency race conditions. For example, two workers retrying a failed deployment could both read status 'QUEUED' and attempt to run. A database trigger acts as an atomic lock, either succeeding or failing the operation immediately at the storage level."
              },
              {
                q: "What is the scale-to-zero wake-up cold start latency?",
                a: "Waking the reverse proxy and querying container states takes under 10ms. The primary cold start bottleneck is AWS Fargate VM provisioning and image pulling, taking between 15–30 seconds. Small, optimized Alpine Docker images built using Dreamer compile faster, reducing cold start times to ~15s."
              }
            ].map((item, idx) => (
              <div
                key={idx}
                className="bg-zinc-950 border border-zinc-900 rounded-xl overflow-hidden transition-colors"
              >
                <button
                  onClick={() => toggleFaq(idx)}
                  className="w-full px-6 py-5 flex items-center justify-between text-left font-semibold text-white hover:text-blue-300 transition-colors"
                >
                  <span>{item.q}</span>
                  <ChevronDown
                    className={`w-5 h-5 text-zinc-400 transition-transform duration-300 ${activeFaq === idx ? "rotate-180 text-blue-400" : ""
                      }`}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {activeFaq === idx && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeInOut" }}
                    >
                      <div className="px-6 pb-6 pt-1 text-sm text-zinc-400 leading-relaxed border-t border-zinc-900 bg-zinc-950/40">
                        {item.a}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA Banner */}
      <section className="py-24 border-t border-zinc-900 bg-black relative">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <h2 className="text-3xl md:text-5xl font-extrabold mb-6">
            Take Control of Your Deployments
          </h2>
          <p className="text-zinc-400 text-lg max-w-xl mx-auto mb-10">
            Set up your own platform in under 3 minutes. Free yourself from restrictive plans and high cloud bills.
          </p>
          <a
            href="#self-hosting"
            className="inline-flex items-center gap-2 px-8 py-4 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-colors shadow-xl"
          >
            Deploy Your PaaS
            <ArrowRight className="w-5 h-5" />
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-black py-12 text-center text-xs text-zinc-500">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="font-bold text-white">Dreamer PaaS</span>
          </div>

          <div className="flex flex-wrap justify-center gap-6">
            <a href="https://github.com/SamanPandey-in/dreamer" className="hover:text-white transition-colors">GitHub Repository</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#architecture" className="hover:text-white transition-colors">System Architecture</a>
            <a href="#faq" className="hover:text-white transition-colors">FAQ Answers</a>
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
  );
}
