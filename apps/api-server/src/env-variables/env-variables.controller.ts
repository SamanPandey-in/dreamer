import type { Request, Response } from 'express';
import * as envVariableService from './env-variables.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function listEnvVariablesHandler(req: Request, res: Response) {
  const { environment } = req.query as { environment?: 'PRODUCTION' | 'PREVIEW' | 'DEVELOPMENT' };
  const envVariables = await envVariableService.listEnvVariablesForProject(
    req.params.projectId as string,
    req.user!.id,
    environment
  );
  res.status(200).json({ envVariables });
}

export async function createEnvVariableHandler(req: Request, res: Response) {
  const envVariable = await envVariableService.createEnvVariable(
    req.params.projectId as string,
    req.user!.id,
    req.body,
    auditMeta(req)
  );
  res.status(201).json({ envVariable });
}

export async function updateEnvVariableHandler(req: Request, res: Response) {
  const envVariable = await envVariableService.updateEnvVariable(
    req.params.envVariableId as string,
    req.user!.id,
    req.body,
    auditMeta(req)
  );
  res.status(200).json({ envVariable });
}

export async function deleteEnvVariableHandler(req: Request, res: Response) {
  await envVariableService.deleteEnvVariable(req.params.envVariableId as string, req.user!.id, auditMeta(req));
  res.status(204).send();
}

export async function revealEnvVariableHandler(req: Request, res: Response) {
  const result = await envVariableService.revealEnvVariable(
    req.params.envVariableId as string,
    req.user!.id,
    auditMeta(req)
  );
  res.status(200).json(result);
}