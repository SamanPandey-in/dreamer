import type { Request, Response } from 'express';
import * as metricsService from './metrics.service';
import type { MetricsRange } from './metrics.types';

export async function getProjectMetricsHandler(req: Request, res: Response) {
  const range = (req.query.range as MetricsRange) ?? '24h';
  const metrics = await metricsService.getProjectMetrics(req.params.projectId as string, req.user!.id, range);
  res.status(200).json({ metrics });
}
