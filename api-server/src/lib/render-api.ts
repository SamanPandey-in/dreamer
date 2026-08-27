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
 * Registers a domain as a Custom Domain on the Render service hosting this
 * API — Render issues and auto-renews a Let's Encrypt certificate per
 * domain, no certbot, no cron. Only called AFTER the domain's ownership TXT
 * record has been verified: Render accepts unverified domains (it just won't
 * finish issuing until DNS points here), but verifying first avoids asking it
 * to track a domain that may not belong to this user at all.
 *
 * sslStatus moves to 'issuing' when this call succeeds and isn't polled back
 * today (see custom-domain.service.ts).
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
