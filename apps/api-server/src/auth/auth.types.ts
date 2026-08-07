import { z } from 'zod';

// bcrypt truncates at 72 *bytes*, not 72 characters — a string can pass a
// 72-char check and still silently lose entropy (or collide with other
// passwords) if it contains multi-byte UTF-8 (emoji, non-Latin scripts).
// Shared so changePasswordSchema and resetPasswordSchema below apply the
// same rule with the same message.
const passwordByteLimit = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine((val) => Buffer.byteLength(val, 'utf8') <= 72, {
    message: 'Password must be at most 72 bytes (some characters take up more than one byte)',
  });

export const registerSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(72, 'Password must be at most 72 characters'), // bcrypt silently truncates beyond 72 bytes
    name: z.string().min(1).max(255).trim(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
    password: z.string().min(1, 'Password is required'),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];

/** Shape of a User we are safe to send to the client — never passwordHash, githubToken, etc. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  emailVerified: boolean;
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

// Email verification / password reset

export const verifyEmailSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
  }),
});

export const resendVerificationSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.email().max(320).toLowerCase(),
  }),
});

// Reuses the same "newPassword" shape/limits as changePasswordSchema above —
// bcrypt's 72-byte truncation applies here too.
export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required'),
    newPassword: passwordByteLimit,
  }),
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>['body'];
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];