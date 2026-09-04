import prometheus from 'prom-client';

// Limpar registry primeiro (importante para clustering)
prometheus.register.clear();

// Coletar métricas padrão do sistema automaticamente
prometheus.collectDefaultMetrics({
  timeout: 10000,
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
  prefix: 'nodejs_',
  register: prometheus.register // ← IMPORTANTE: especificar o registry
});

// Criar métricas customizadas
const httpRequestDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

const httpRequestTotal = new prometheus.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

// Contador de startup para garantir que há métricas
const appStartTime = new prometheus.Gauge({
  name: 'app_start_time_seconds',
  help: 'Time when the application started',
  registers: [prometheus.register] // ← IMPORTANTE: registrar explicitamente
});

// Registrar o tempo de início
appStartTime.set(Date.now() / 1000);

export const metricsMiddleware = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    try {
      const duration = (Date.now() - start) / 1000;
      const route = req.route ? req.route.path : req.path;

      // Registrar duração da requisição
      httpRequestDuration
        .labels(req.method, route, res.statusCode.toString())
        .observe(duration);

      // Contar total de requisições
      httpRequestTotal
        .labels(req.method, route, res.statusCode.toString())
        .inc();

      if (process.env.NODE_ENV === 'development') {
        console.log(`📊 Métrica registrada: ${req.method} ${route} ${res.statusCode}`);
      }
    } catch (error) {
      console.warn('⚠️ Erro ao registrar métrica:', error.message);
    }
  });

  next();
};

export { httpRequestDuration, httpRequestTotal, prometheus };
