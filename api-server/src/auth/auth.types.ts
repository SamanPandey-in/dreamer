import { z } from 'zod';

// bcrypt truncates at 72 *bytes*, not 72 characters — multi-byte UTF-8 can
// pass a 72-char check yet silently lose entropy. Shared so setup and
// change-password apply the same rule with the same message.
const passwordByteLimit = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((val) => Buffer.byteLength(val, 'utf8') <= 72, {
    message: 'Password must be at most 72 bytes (some characters take up more than one byte)',
  });

// Creates the ONE admin account — auth.service.ts#setupAdmin refuses to
// run a second time once any user row exists.
export const setupSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
    password: passwordByteLimit,
    name: z.string().min(1).max(255).trim(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
    password: z.string().min(1, 'Password is required'),
  }),
});

export type SetupInput = z.infer<typeof setupSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];

/** Shape of a User we are safe to send to the client — never passwordHash, personalAccessToken, etc. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  hasGitToken: boolean; // whether personalAccessToken is set — never the token itself
}

export interface AccessTokenPayload {
  sub: string; // userId
  email: string;
  iat: number;
  exp: number;
}

export interface PublicSession {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().optional(),
    newPassword: passwordByteLimit,
  }),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>['body'];

// Git PAT — set/clear from Settings.
export const setGitTokenSchema = z.object({
  body: z.object({
    personalAccessToken: z.string().min(1).max(1024),
  }),
});

export type SetGitTokenInput = z.infer<typeof setGitTokenSchema>['body'];
