import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from './env';

// Prisma 7 dropped the bundled Rust query engine in favour of "driver adapters" —
// you now own the actual DB driver (node-postgres / `pg`) and Prisma just
// translates queries through it. One adapter, one PrismaClient, for the
// lifetime of the process. Re-creating PrismaClient per-request (a real bug
// fixed earlier in the PolyGlot iterations) exhausts Postgres connections
// under load.
// const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});