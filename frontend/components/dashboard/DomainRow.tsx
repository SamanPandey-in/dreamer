"use client";

import { useState } from "react";
import { Copy, Loader2, Trash2, RefreshCw, CheckCircle2, Circle } from "lucide-react";
import { verifyCustomDomain, describeApiError } from "@/lib/dashboard-api";
import type { CustomDomain } from "@/lib/dashboard-types";

const SSL_LABEL: Record<CustomDomain["sslStatus"], string> = {
  pending: "SSL pending",
  issuing: "SSL issuing…",
  active: "SSL active",
  error: "SSL error",
};

const SSL_CLASS: Record<CustomDomain["sslStatus"], string> = {
  pending: "bg-zinc-800 text-zinc-400",
  issuing: "bg-amber-500/10 text-amber-400",
  active: "bg-emerald-500/10 text-emerald-400",
  error: "bg-red-500/10 text-red-400",
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 bg-zinc-900/80 border border-zinc-800 rounded-lg px-3 py-2">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
        <p className="text-sm font-mono text-zinc-200 truncate">{value}</p>
      </div>
      <button
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 p-1.5 text-zinc-500 hover:text-zinc-200 transition-colors"
        aria-label={`Copy ${label}`}
      >
        {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}

export function DomainRow({
  domain,
  onVerified,
  onDelete,
}: {
  domain: CustomDomain;
  onVerified: (updated: CustomDomain) => void;
  onDelete: () => Promise<void>;
}) {
  const [verifying, setVerifying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      const updated = await verifyCustomDomain(domain.id);
      onVerified(updated);
    } catch (err) {
      setError(describeApiError(err, "Verification failed. Please try again."));
    } finally {
      setVerifying(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {domain.verified ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <Circle className="w-4 h-4 text-zinc-600 shrink-0" />
          )}
          <p className="text-sm font-mono text-zinc-200 truncate">{domain.domain}</p>
          {domain.verified && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${SSL_CLASS[domain.sslStatus]}`}>
              {SSL_LABEL[domain.sslStatus]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {!domain.verified && <VerifyButton onClick={handleVerify} verifying={verifying} />}
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
            aria-label="Remove domain"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {!domain.verified && domain.dns.verification && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-zinc-500">
            Add these DNS records at your domain registrar, then click Verify. Propagation can take a few minutes.
          </p>
          <CopyField label={`TXT · ${domain.dns.verification.host}`} value={domain.dns.verification.value} />
          <CopyField label={`CNAME · ${domain.domain}`} value={domain.dns.routing.value} />
          <p className="text-xs text-zinc-600">
            For an apex domain (no &quot;www&quot;), use your registrar&apos;s ALIAS/ANAME/CNAME-flattening option instead of a literal CNAME.
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

function VerifyButton({ onClick, verifying }: { onClick: () => void; verifying: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={verifying}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-800 transition-colors disabled:opacity-50"
    >
      {verifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
      Verify
    </button>
  );
}
