import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from './env';

// Prisma 7 uses driver adapters: we own the actual DB driver (node-postgres /
// `pg`) and Prisma translates queries through it. One adapter, one
// PrismaClient, for the lifetime of the process — recreating the client
// per-request exhausts Postgres connections under load.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});