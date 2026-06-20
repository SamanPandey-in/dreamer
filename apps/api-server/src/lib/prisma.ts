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
// DATABASE_URL no longer carries `sslcert=<path>` — that told Prisma to
// read a CA cert from a FILE ON DISK, which doesn't exist in any
// container/PaaS deploy unless committed to the repo (and yours is
// gitignored, on purpose — it's fine where it lives now: an env var).
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  // ssl: { ca: env.DATABASE_CA_CERT, rejectUnauthorized: true },
  ssl: { rejectUnauthorized: false } 
});

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});