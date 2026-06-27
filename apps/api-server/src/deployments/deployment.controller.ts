import type { Request, Response } from 'express';
import * as deploymentService from './deployment.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function createDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.createDeployment(
    req.params.projectId as string,
    req.user!.id,
    req.body,
    auditMeta(req)
  );
  res.status(201).json({ deployment });
}

export async function listDeploymentsHandler(req: Request, res: Response) {
  const { cursor, limit, branch, status, environment, dateFrom, dateTo } = req.query as unknown as {
    cursor?: string;
    limit: number;
    branch?: string;
    status?: string;
    environment?: 'PRODUCTION' | 'PREVIEW';
    dateFrom?: Date;
    dateTo?: Date;
  };
  const result = await deploymentService.listDeploymentsForProject(req.params.projectId as string, req.user!.id, {
    cursor,
    limit,
    branch,
    status: status as never,
    environment,
    dateFrom,
    dateTo,
  });
  res.status(200).json(result);
}

export async function getDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.getDeploymentDetail(req.params.deploymentId as string, req.user!.id);
  res.status(200).json({ deployment });
}

export async function getDeploymentLogsHandler(req: Request, res: Response) {
  const { after, limit } = req.query as unknown as { after: number; limit: number };
  const logs = await deploymentService.listDeploymentLogs(req.params.deploymentId as string, req.user!.id, {
    after,
    limit,
  });
  res.status(200).json({ logs });
}

/**  NEW */
export async function rollbackDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.rollbackDeployment(
    req.params.deploymentId as string,
    req.user!.id,
    auditMeta(req)
  );
  res.status(201).json({ deployment });
}

/**  NEW */
export async function stopDeploymentHandler(req: Request, res: Response) {
  const deployment = await deploymentService.stopDeployment(
    req.params.deploymentId as string,
    req.user!.id,
    auditMeta(req)
  );
  res.status(200).json({ deployment });
}