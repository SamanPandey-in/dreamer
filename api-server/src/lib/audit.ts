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
 * Shared AuditLog writer for everything outside auth/ (auth.service.ts keeps
 * its own private copy — same signature, same table).
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