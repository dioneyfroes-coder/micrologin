import helmet from 'helmet';
import type { Express, Response, Request, NextFunction } from 'express';

/**
 * Aplica os headers de segurança.
 *
 * @param app - Aplicação Express
 * @param tlsEnabled - O servidor está servindo HTTPS de verdade?
 *
 * `tlsEnabled` decide o HSTS. O header declara "daqui em diante, só HTTPS" e
 * navegadores o ignoram quando chega por HTTP, então emití-lo num serviço em
 * HTTP puro não protege nada: é uma promessa que o serviço não pode cumprir.
 * Quem decide é quem sabe se há TLS no fim do processo.
 */
export default function setupSecurity(app: Express, tlsEnabled = false): void {
  // Headers de segurança obrigatórios
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ['\'self\''],
        styleSrc: ['\'self\'', '\'unsafe-inline\'', 'cdnjs.cloudflare.com'],
        scriptSrc: ['\'self\'', 'cdnjs.cloudflare.com'],
        imgSrc: ['\'self\'', 'data:', 'https:'],
        connectSrc: ['\'self\''],
        fontSrc: ['\'self\'', 'cdnjs.cloudflare.com'],
        objectSrc: ['\'none\''],
        mediaSrc: ['\'self\''],
        frameSrc: ['\'none\'']
      }
    },
    crossOriginEmbedderPolicy: false, // Para Swagger UI
    hsts: tlsEnabled
      ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
      : false
  }));

  // Headers adicionais de segurança
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
}
