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
  // Every custom domain CNAMEs to the SAME reserved host one level under
  // BASE_DOMAIN — not the apex itself, which routes to the dashboard. It
  // rides the same *.BASE_DOMAIN wildcard everything else resolves through,
  // so it needs no dedicated DNS record or certificate of its own.
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

  // A domain under BASE_DOMAIN is already routable for free — accepting it
  // as "custom" would collide with the wildcard's own routing.
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
    // @unique on `domain` — P2002 means anyone already registered it (any
    // user: domains aren't scoped per-account). The generic conflict avoids
    // confirming to a caller which OTHER account owns a domain.
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
      throw new ConflictError(`"${domainName}" is already registered to a project`, 'CUSTOM_DOMAIN_TAKEN');
    }
    throw err;
  }
}

/**
 * SECURITY: proof of ownership BEFORE the domain can ever be used for
 * routing — only VERIFIED domains are routed, so claiming a domain nobody
 * controls can't hijack its traffic. Looks up the TXT record itself rather
 * than trusting a client-supplied "yes I added it" — DNS resolution is the
 * actual proof.
 */
export async function verifyCustomDomain(domainId: string, userId: string, meta: AuditMeta): Promise<PublicCustomDomain> {
  const existing = await findOwnedCustomDomain(domainId, userId);

  if (existing.verified) return toPublicCustomDomain(existing); // idempotent — re-clicking "Verify" after success is a no-op, not an error

  const recordHost = `${VERIFICATION_TXT_PREFIX}.${existing.domain}`;
  let records: string[][];
  try {
    records = await resolveTxt(recordHost);
  } catch {
    // NXDOMAIN, no TXT records, resolver timeout — all mean "not verified
    // yet" (the record usually just hasn't propagated), not a server error.
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
    // nice-to-have layered on top of verification — the domain is already
    // verified and will route traffic even if this call fails. Failing the
    // whole verify() would incorrectly roll back a DNS fact that's true.
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
