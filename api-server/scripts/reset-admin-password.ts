/**
 * Resets the single admin's password directly against the database —
 * local-engine's answer to "I forgot my password," in place of an
 * email-based reset flow. See
 * docs/architecture/local-engine-auth-and-networking.md Decision 1 for why
 * this is a CLI/DB step rather than email: local-engine has no email
 * provider configured at all (nothing else sends email either), and
 * running this requires the same host access every other admin operation
 * on this box already assumes — it isn't a weaker trust boundary than an
 * email link would be, and it doesn't need one more external account
 * (Resend) just to recover a login.
 *
 * Usage (from api-server/, inside the running api-server container):
 *   docker compose --env-file ../.env.deploy exec api-server \
 *     npx tsx scripts/reset-admin-password.ts new-password-here
 *
 * Requires at least 8 characters. Revokes every existing session for the
 * account, same as auth.service.ts#changePassword does when the password
 * changes through the normal in-app flow — a password reset should sign
 * out anything using the old one.
 */
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/auth/auth.tokens';

async function main() {
  const newPassword = process.argv[2];

  if (!newPassword) {
    console.error('Usage: npx tsx scripts/reset-admin-password.ts <new-password>');
    process.exit(1);
  }
  if (Buffer.byteLength(newPassword, 'utf8') < 8 || Buffer.byteLength(newPassword, 'utf8') > 72) {
    // Same bcrypt-byte-limit reasoning as auth.types.ts's passwordByteLimit
    // — kept in sync by hand here since this script runs outside the zod
    // schema that normally enforces it.
    console.error('Password must be between 8 and 72 bytes.');
    process.exit(1);
  }

  // Single-admin install: there's exactly one User row in normal
  // operation (see auth.service.ts#setupAdmin) — orderBy just picks the
  // oldest deterministically in the unlikely case more than one exists.
  const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!user) {
    console.error('No admin account exists yet — run setup from the dashboard first (see README Section 5).');
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  await prisma.userSession.deleteMany({ where: { userId: user.id } });

  console.log(`Password reset for ${user.email}. All existing sessions for this account have been signed out.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
