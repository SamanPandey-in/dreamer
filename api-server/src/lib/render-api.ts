import { env } from './env';
import { logger } from './logger';

const RENDER_API_BASE = 'https://api.render.com/v1';

/**
 * Whether TLS can be auto-provisioned for verified custom domains at all.
 * Both RENDER_API_KEY and RENDER_SERVICE_ID are optional (see env.ts) —
 * neither is set on local dev or a self-hosted nginx/certbot deploy, and
 * this is the one call site that needs to know that before trying.
 */
export function isRenderTlsConfigured(): boolean {
  return Boolean(env.RENDER_API_KEY && env.RENDER_SERVICE_ID);
}

/**
 * Registers a domain as a Custom Domain on this api-server's own Render
 * service. This is the SAME automation
 * docs/reverse-proxy/wildcard-domains.md's worked example already relies
 * on for `*.singularitydev.xyz` — Render issues and auto-renews a
 * Let's-Encrypt-backed certificate per domain with no certbot, no cron, no
 * further action here. The caller (custom-domain.service.ts) only calls
 * this AFTER the domain's ownership TXT record has already been verified —
 * Render will happily accept a domain whose DNS doesn't point here yet, it
 * just won't finish issuing until it does, so there's no ordering hazard
 * either way, but verifying first keeps us from asking Render to track a
 * domain that turns out not to belong to this user at all.
 *
 * Render's own dashboard shows subsequent verification/certificate status
 * for whatever gets registered here; this platform doesn't poll or mirror
 * that back into sslStatus today (see custom-domain.service.ts) — sslStatus
 * moves to 'issuing' the moment this call succeeds and stays there until a
 * human checks Render's dashboard or a future webhook/poll is added.
 */
export async function registerRenderCustomDomain(domain: string): Promise<void> {
  const response = await fetch(`${RENDER_API_BASE}/services/${env.RENDER_SERVICE_ID}/custom-domains`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RENDER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: domain }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Render custom-domain registration failed (${response.status}): ${body}`);
  }
}

/** Mirror of registerRenderCustomDomain — called on delete so a removed domain doesn't keep sitting in Render's dashboard (and keep consuming a slot) after Dreamer no longer knows about it. */
export async function deregisterRenderCustomDomain(domain: string): Promise<void> {
  // Render's API addresses a custom domain by its own generated id, not by
  // name — one extra lookup call to resolve name -> id before the delete.
  const listResponse = await fetch(
    `${RENDER_API_BASE}/services/${env.RENDER_SERVICE_ID}/custom-domains?domain=${encodeURIComponent(domain)}`,
    { headers: { Authorization: `Bearer ${env.RENDER_API_KEY}` } }
  );

  if (!listResponse.ok) {
    logger.warn('Could not look up Render custom domain for deregistration', { domain, status: listResponse.status });
    return;
  }

  const results = (await listResponse.json()) as { customDomain: { id: string; name: string } }[];
  const match = results.find((r) => r.customDomain.name === domain);
  if (!match) return; // already gone, or never made it to Render (e.g. RENDER_API_KEY was added after this domain was created)

  const deleteResponse = await fetch(
    `${RENDER_API_BASE}/services/${env.RENDER_SERVICE_ID}/custom-domains/${match.customDomain.id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.RENDER_API_KEY}` } }
  );

  if (!deleteResponse.ok) {
    logger.warn('Failed to deregister Render custom domain', { domain, status: deleteResponse.status });
  }
}
