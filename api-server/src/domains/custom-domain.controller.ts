import type { Request, Response } from 'express';
import * as customDomainService from './custom-domain.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function listCustomDomainsHandler(req: Request, res: Response) {
  const domains = await customDomainService.listCustomDomains(req.params.projectId as string, req.user!.id);
  res.status(200).json({ domains });
}

export async function createCustomDomainHandler(req: Request, res: Response) {
  const domain = await customDomainService.addCustomDomain(
    req.params.projectId as string,
    req.user!.id,
    req.body.domain,
    auditMeta(req)
  );
  res.status(201).json({ domain });
}

export async function verifyCustomDomainHandler(req: Request, res: Response) {
  const domain = await customDomainService.verifyCustomDomain(req.params.domainId as string, req.user!.id, auditMeta(req));
  res.status(200).json({ domain });
}

export async function deleteCustomDomainHandler(req: Request, res: Response) {
  await customDomainService.deleteCustomDomain(req.params.domainId as string, req.user!.id, auditMeta(req));
  res.status(204).send();
}
