import { prisma } from './prisma';
import type { Prisma } from '../generated/prisma/client';

export interface AuditMeta {
  ipAddress?: string;
  userAgent?: string;
}

interface AuditOptions {
  resourceType?: string;
  resourceId?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Shared AuditLog writer for everything outside auth/ (which keeps its own
 * private copy — not migrated here, since auth.service.ts is explicitly
 * off-limits for this change). If we ever do want to de-duplicate that one
 * too, it's a drop-in swap: same signature, same table.
 */
export async function audit(
  userId: string | null,
  action: string,
  meta: AuditMeta = {},
  options: AuditOptions = {}
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      metadata: options.metadata,
    },
  });
}