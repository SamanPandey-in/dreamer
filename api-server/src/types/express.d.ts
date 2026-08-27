import 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
// This is what lets req.user be type-safe (AuthenticatedUser | undefined) everywhere, instead of every controller casting req.user as any.