import { z } from 'zod';

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