import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../shared/utils/errorHandler.js';

const TOKEN_HEADER = 'x-security-token';
const MAX_TOKEN_LENGTH = 512;

const tokenDigest = (value: string): Buffer => createHash('sha256').update(value).digest();

const tokensMatch = (expected: string, received: string): boolean =>
  timingSafeEqual(tokenDigest(expected), tokenDigest(received));

export const requireSecurityToken = (req: Request, res: Response, next: NextFunction): void => {
  const configuredToken = process.env.SECURITY_DASHBOARD_TOKEN;

  if (!configuredToken) {
    return next(new HttpError(503, 'SECURITY_TOKEN_NOT_CONFIGURED', 'Acesso ao dashboard de segurança indisponível'));
  }

  const providedToken = req.get(TOKEN_HEADER);

  if (!providedToken || providedToken.length > MAX_TOKEN_LENGTH || !tokensMatch(configuredToken, providedToken)) {
    return next(new HttpError(401, 'SECURITY_FORBIDDEN', 'Acesso não autorizado ao dashboard de segurança'));
  }

  return next();
};

export const securityTokenConfigured = (): boolean => Boolean(process.env.SECURITY_DASHBOARD_TOKEN);
