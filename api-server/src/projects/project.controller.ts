import type { Request, Response } from 'express';
import * as projectService from './project.service';
import type { AuditMeta } from '../lib/audit';

function auditMeta(req: Request): AuditMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

export async function createProjectHandler(req: Request, res: Response) {
  const project = await projectService.createProject(req.user!.id, req.body, auditMeta(req));
  res.status(201).json({ project });
}

export async function listProjectsHandler(req: Request, res: Response) {
  const projects = await projectService.listProjectsForUser(req.user!.id);
  res.status(200).json({ projects });
}

export async function getProjectHandler(req: Request, res: Response) {
  const project = await projectService.getProjectById(req.params.projectId as string, req.user!.id);
  res.status(200).json({ project });
}

export async function updateProjectHandler(req: Request, res: Response) {
  const project = await projectService.updateProject(req.params.projectId as string, req.user!.id, req.body, auditMeta(req));
  res.status(200).json({ project });
}

export async function deleteProjectHandler(req: Request, res: Response) {
  await projectService.softDeleteProject(req.params.projectId as string, req.user!.id, auditMeta(req));
  res.status(204).send();
}
