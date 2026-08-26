import { resolveTxt } from 'node:dns/promises';
import crypto from 'node:crypto';
import { env } from '../lib/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { audit, type AuditMeta } from '../lib/audit';
import { ConflictError, NotFoundError, BadRequestError } from '../lib/errors';
import { assertProjectOwnership } from '../projects/project.service';
import { isRenderTlsConfigured, registerRenderCustomDomain, deregisterRenderCustomDomain } from '../lib/render-api';
import type { CustomDomain } from '../generated/prisma/client';
import type { PublicCustomDomain } from './custom-domain.types';

const VERIFICATION_TOKEN_BYTES = 16;
const VERIFICATION_TXT_PREFIX = '_dreamer-verify';

function cnameTarget(): string {
  // Every custom domain CNAMEs to the SAME reserved host, one level under
  // BASE_DOMAIN — not to BASE_DOMAIN itself, because BASE_DOMAIN's bare
  // apex routes to the dashboard on a self-hosted install (see
  // nginx/templates/dreamer.conf.template), not to reverse-proxy.
  // `cname.${BASE_DOMAIN}` is just another label under the SAME
  // `*.${BASE_DOMAIN}` wildcard everything else already resolves through,
  // so it needs no dedicated DNS record or certificate of its own — one
  // fixed, documented target, reused by every project's custom domain.
  return `cname.${env.BASE_DOMAIN}`;
}

function toPublicCustomDomain(domain: CustomDomain): PublicCustomDomain {
  return {
    id: domain.id,
    projectId: domain.projectId,
    domain: domain.domain,
    verified: domain.verified,
    verifiedAt: domain.verifiedAt,
    sslStatus: domain.sslStatus as PublicCustomDomain['sslStatus'],
    sslIssuedAt: domain.sslIssuedAt,
    sslExpiresAt: domain.sslExpiresAt,
    createdAt: domain.createdAt,
    dns: {
      verification: domain.verified
        ? null
        : { type: 'TXT', host: `${VERIFICATION_TXT_PREFIX}.${domain.domain}`, value: domain.verificationToken },
      routing: { type: 'CNAME', host: domain.domain, value: cnameTarget() },
    },
  };
}

async function findOwnedCustomDomain(domainId: string, userId: string): Promise<CustomDomain> {
  const domain = await prisma.customDomain.findFirst({
    where: { id: domainId, project: { userId, deletedAt: null } },
  });
  if (!domain) throw new NotFoundError('Custom domain not found', 'CUSTOM_DOMAIN_NOT_FOUND');
  return domain;
}

export async function listCustomDomains(projectId: string, userId: string): Promise<PublicCustomDomain[]> {
  await assertProjectOwnership(projectId, userId);

  const domains = await prisma.customDomain.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  return domains.map(toPublicCustomDomain);
}

export async function addCustomDomain(
  projectId: string,
  userId: string,
  domainName: string,
  meta: AuditMeta
): Promise<PublicCustomDomain> {
  await assertProjectOwnership(projectId, userId);

  // A domain pointed at BASE_DOMAIN itself (or a bare `{slug}.BASE_DOMAIN`)
  // is already routable for free — accepting it as a "custom" domain would
  // let it collide with the wildcard's own routing and the reverse-proxy's
  // exact-match-first lookup (see deployment-lookup.js) in a way that has
  // no useful outcome for the user.
  if (domainName === env.BASE_DOMAIN || domainName.endsWith(`.${env.BASE_DOMAIN}`)) {
    throw new BadRequestError(
      `"${domainName}" is already served by this platform and can't be added as a custom domain`,
      'CUSTOM_DOMAIN_RESERVED'
    );
  }

  const verificationToken = crypto.randomBytes(VERIFICATION_TOKEN_BYTES).toString('hex');

  try {
    const domain = await prisma.customDomain.create({
      data: { projectId, domain: domainName, verificationToken },
    });

    await audit(userId, 'custom_domain.create', meta, {
      resourceType: 'custom_domain',
      resourceId: domain.id,
      metadata: { projectId, domain: domainName },
    });

    return toPublicCustomDomain(domain);
  } catch (err) {
    // @unique on `domain` — someone (this user or, deliberately, ANY user,
    // since domain names aren't scoped per-account) already has this exact
    // domain registered. Surfacing the generic conflict rather than "taken
    // by user X" avoids confirming to a caller which OTHER account owns a
    // given domain.
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
      throw new ConflictError(`"${domainName}" is already registered to a project`, 'CUSTOM_DOMAIN_TAKEN');
    }
    throw err;
  }
}

/**
 * Proof of ownership BEFORE this domain can ever be used for routing —
 * without this, adding a domain nobody actually controls would be enough
 * to hijack traffic (and any cookies/auth flows) for it the moment someone
 * else's DNS happened to already point here, or once they pointed it here
 * later without knowing this project had claimed it first. `verified` is
 * exactly what deployment-lookup.js's custom-domain branch checks before
 * it will route a single request — this is the only function that ever
 * sets it to true.
 *
 * Looks up the TXT record itself (doesn't trust a client-supplied "yes I
 * added it") — DNS resolution is the actual proof; nothing else is.
 */
export async function verifyCustomDomain(domainId: string, userId: string, meta: AuditMeta): Promise<PublicCustomDomain> {
  const existing = await findOwnedCustomDomain(domainId, userId);

  if (existing.verified) return toPublicCustomDomain(existing); // idempotent — re-clicking "Verify" after success is a no-op, not an error

  const recordHost = `${VERIFICATION_TXT_PREFIX}.${existing.domain}`;
  let records: string[][];
  try {
    records = await resolveTxt(recordHost);
  } catch {
    // NXDOMAIN, no TXT records, resolver timeout — all the same outcome
    // from the caller's point of view: "not verified yet", not a 500. The
    // record commonly just hasn't propagated yet.
    throw new BadRequestError(
      `No TXT record found at ${recordHost} yet. DNS changes can take a few minutes to propagate — try again shortly.`,
      'CUSTOM_DOMAIN_NOT_VERIFIABLE'
    );
  }

  const found = records.some((chunks) => chunks.join('') === existing.verificationToken);
  if (!found) {
    throw new BadRequestError(
      `The TXT record at ${recordHost} doesn't match the expected value yet.`,
      'CUSTOM_DOMAIN_TOKEN_MISMATCH'
    );
  }

  const domain = await prisma.customDomain.update({
    where: { id: existing.id },
    data: { verified: true, verifiedAt: new Date(), sslStatus: isRenderTlsConfigured() ? 'issuing' : 'pending' },
  });

  await audit(userId, 'custom_domain.verify', meta, {
    resourceType: 'custom_domain',
    resourceId: domain.id,
    metadata: { projectId: domain.projectId, domain: domain.domain },
  });

  if (isRenderTlsConfigured()) {
    // Fire-and-log, not fire-and-forget-silently: TLS provisioning is a
    // nice-to-have layered on top of verification, not a precondition for
    // it — the domain is already correctly verified and will already
    // route traffic (over plain HTTP) even if Render's API call below
    // fails. Failing the whole verify() call over a Render hiccup would
    // incorrectly roll back a DNS fact that's already true.
    registerRenderCustomDomain(existing.domain).catch(async (err) => {
      logger.error('Render custom-domain registration failed', { domain: existing.domain, error: String(err) });
      await prisma.customDomain.update({ where: { id: existing.id }, data: { sslStatus: 'error' } }).catch(() => {});
    });
  } else {
    logger.info('RENDER_API_KEY/RENDER_SERVICE_ID not configured — leaving sslStatus as pending for verified domain', {
      domain: existing.domain,
    });
  }

  return toPublicCustomDomain(domain);
}

export async function deleteCustomDomain(domainId: string, userId: string, meta: AuditMeta): Promise<void> {
  const existing = await findOwnedCustomDomain(domainId, userId);

  await prisma.customDomain.delete({ where: { id: existing.id } });

  await audit(userId, 'custom_domain.delete', meta, {
    resourceType: 'custom_domain',
    resourceId: existing.id,
    metadata: { projectId: existing.projectId, domain: existing.domain },
  });

  if (existing.verified && isRenderTlsConfigured()) {
    deregisterRenderCustomDomain(existing.domain).catch((err) => {
      logger.warn('Render custom-domain deregistration failed (non-fatal)', { domain: existing.domain, error: String(err) });
    });
  }
}
