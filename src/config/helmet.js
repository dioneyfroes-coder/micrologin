import helmet from 'helmet';

export default function setupSecurity(app) {
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
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }));

  // Headers adicionais de segurança
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
}
