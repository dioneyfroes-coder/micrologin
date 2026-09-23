import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
      } | null;
      validationDetails?: unknown;
    }
  }
}

export {};
