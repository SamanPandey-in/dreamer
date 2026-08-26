import { z } from 'zod';

// One DNS label per dot-separated part, each 1-63 chars, letters/digits/hyphens,
// no leading/trailing hyphen; the whole name under 253 chars — matches the
// column's own @db.VarChar(253). Deliberately excludes a bare "localhost" or
// single-label input (a TLD-less hostname is never a real registrable domain).
const DOMAIN_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(DOMAIN_REGEX, 'Enter a valid domain, e.g. "myapp.com" or "www.myapp.com"');

export const createCustomDomainSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
  body: z.object({ domain: domainNameSchema }),
});

export const listCustomDomainsSchema = z.object({
  params: z.object({ projectId: z.uuid() }),
});

export const customDomainIdParamSchema = z.object({
  params: z.object({ domainId: z.uuid() }),
});

export type CreateCustomDomainInput = z.infer<typeof createCustomDomainSchema>['body'];

export type SslStatus = 'pending' | 'issuing' | 'active' | 'error';

/** What the client actually needs — the raw Prisma row plus the derived DNS instructions it can't compute on its own. */
export interface PublicCustomDomain {
  id: string;
  projectId: string;
  domain: string;
  verified: boolean;
  verifiedAt: Date | null;
  sslStatus: SslStatus;
  sslIssuedAt: Date | null;
  sslExpiresAt: Date | null;
  createdAt: Date;
  /** Only populated pre-verification — nothing left to prove once verified, and the token shouldn't linger in every list response after that. */
  dns: {
    verification: { type: 'TXT'; host: string; value: string } | null;
    routing: { type: 'CNAME'; host: string; value: string };
  };
}
