/**
 * @fileoverview Middleware de monitoramento de segurança
 * Detecta e bloqueia tentativas de ataques como XSS, SQL Injection, DDoS
 */

/**
 * Monitor de segurança para detecção de ameaças
 */
class SecurityMonitor {
  /**
     * @constructor
     * Inicializa padrões suspeitos e mapas de anomalias
     */
  constructor() {
    this.suspiciousPatterns = [
      /(<|%3C)script(>|%3E)/i,
      /(<|%3C)iframe(>|%3E)/i,
      /javascript:/i,
      /vbscript:/i,
      /(union|select|insert|update|delete|drop|create|alter)\s/i,
      /(;|%3B)(\s)*(drop|delete|update|insert)/i
    ];
    this.anomalies = new Map();
    this.blockedIPs = new Set();
  }

  /**
     * Detecta ameaças em requisições HTTP
     * @param {import('express').Request} req - Objeto de requisição
     * @param {import('express').Response} res - Objeto de resposta
     * @param {import('express').NextFunction} next - Função next
     */
  detectThreats(req, res, next) {
    const threats = [];
    const requestData = JSON.stringify(req.body) + req.url + req.get('User-Agent');

    // Verificar se IP está bloqueado
    if (this.blockedIPs.has(req.ip)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'IP temporarily blocked due to suspicious activity'
      });
    }

    // Detectar padrões maliciosos
    this.suspiciousPatterns.forEach((pattern, index) => {
      if (pattern.test(requestData)) {
        threats.push(`Suspicious pattern ${index}: ${pattern}`);
      }
    });

    // Detectar anomalias de comportamento
    const clientId = req.ip + req.get('User-Agent');
    this.detectAnomalies(clientId, req);

    // Log de segurança
    if (threats.length > 0) {
      console.warn(`🚨 Security threat detected from ${req.ip}:`, threats);

      // Bloquear temporariamente IPs suspeitos
      this.blockSuspiciousIP(req.ip);

      return res.status(403).json({
        error: 'Forbidden',
        message: 'Suspicious activity detected'
      });
    }

    next();
  }

  // ← ADICIONAR ESTE MÉTODO
  blockSuspiciousIP(ip) {
    this.blockedIPs.add(ip);
    console.warn(`🚨 IP ${ip} bloqueado temporariamente`);

    // Desbloquear após 1 hora
    setTimeout(() => {
      this.blockedIPs.delete(ip);
      console.log(`✅ IP ${ip} desbloqueado`);
    }, 60 * 60 * 1000);
  }

  detectAnomalies(clientId, req) {
    const now = Date.now();
    const timeWindow = 60000; // 1 minuto

    if (!this.anomalies.has(clientId)) {
      this.anomalies.set(clientId, []);
    }

    const requests = this.anomalies.get(clientId);
    requests.push({ timestamp: now, path: req.path });

    // Remover requests antigos
    const recentRequests = requests.filter(r => now - r.timestamp < timeWindow);
    this.anomalies.set(clientId, recentRequests);

    // Detectar padrões suspeitos
    if (recentRequests.length > 50) { // Muitas requests
      console.warn(`🚨 Possible DDoS from ${clientId}`);
      this.blockSuspiciousIP(req.ip);
    }

    // Detectar path traversal
    if (req.path.includes('../') || req.path.includes('..\\')) {
      console.warn(`🚨 Path traversal attempt from ${clientId}`);
      this.blockSuspiciousIP(req.ip);
    }
  }
}

export const securityMonitor = new SecurityMonitor();
