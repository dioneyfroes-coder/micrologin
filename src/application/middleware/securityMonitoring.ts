/**
 * @fileoverview Middleware de Monitoramento de Segurança (AUXILIAR)
 *
 * ⚠️ IMPORTANTE: Este é um MONITOR AUXILIAR, não o mecanismo principal de segurança!
 *
 * Responsabilidades:
 * - ✅ LOG de eventos suspeitos
 * - ✅ ALERTA de padrões maliciosos
 * - ✅ AUDITORIA de atividades
 *
 * NÃO responsável por:
 * - ❌ Bloquear IPs (usar rate limiting)
 * - ❌ Negar requisições (usar WAF ou rate limiting)
 * - ❌ Tomar decisões de segurança críticas
 *
 * O bloqueio de IPs é feito pelo Rate Limiter (advancedRateLimit.js)
 *
 * 📌 POLÍTICA DE REGEX: as expressões regulares abaixo são usadas
 * EXCLUSIVAMENTE para DETECÇÃO/ALERTA de padrões suspeitos (monitoramento
 * auxiliar). Nenhuma decisão de proteção/bloqueio depende delas; a proteção
 * principal de entrada é feita por validação e sanitização determinísticas.
 */

import type { NextFunction, Request, Response } from 'express';
import { securityAuditLogger } from './securityAudit.js';
import { logger } from '../../shared/utils/logger.js';

/**
 * Padrões de entrada suspeita.
 *
 * Constante de módulo e não campo de instância: a lista é a mesma para todos os
 * processos e não muda em runtime, então guardá-la em `this` só dava uma
 * plausibilidade falsa de estado configurável.
 */
const SUSPICIOUS_PATTERNS: readonly RegExp[] = [
  /(<|%3C)script(>|%3E)/i,
  /(<|%3C)iframe(>|%3E)/i,
  /javascript:/i,
  /vbscript:/i,
  /(union|select|insert|update|delete|drop|create|alter)\s/i,
  /(;|%3B)(\s)*(drop|delete|update|insert)/i
];

/**
 * Monitor de segurança PASSIVO - apenas LOG e ALERTA
 */
class SecurityMonitor {
  /**
   * Monitor de ameaças - APENAS LOGGING
   * ✅ Detecta padrões maliciosos
   * ❌ NÃO bloqueia (rate limiter é responsável)
   */
  detectThreats = (req: Request, res: Response, next: NextFunction): void => {
    const threats: string[] = [];
    const requestData = JSON.stringify(req.body) + req.url + (req.get('User-Agent') || '');

    // Detectar padrões maliciosos
    SUSPICIOUS_PATTERNS.forEach((pattern, index) => {
      if (pattern.test(requestData)) {
        threats.push(`Pattern ${index}: ${pattern.toString()}`);
      }
    });

    // Detectar path traversal
    if (req.path.includes('../') || req.path.includes('..\\')) {
      threats.push('Path traversal detected');
    }

    // LOG: Registrar eventos suspeitos
    if (threats.length > 0) {
      logger.warn(`⚠️ [SECURITY MONITOR] Suspicious pattern detected from ${req.ip}`, { threats });

      // ⚠️ IMPORTANTE: NÃO bloqueamos aqui
      // A decisão de bloquear é feita pelo Rate Limiter se necessário
      // Este middleware é apenas um MONITOR/ALERTA
      //
      // O registro vai para o `securityAuditLogger`, que é o buffer único do
      // processo: é dele que `/security/*` e o manifesto de observabilidade leem.
      // Guardar uma segunda cópia aqui criaria dois históricos do mesmo evento
      // com formatos de timestamp diferentes, e nada leria a segunda.
      securityAuditLogger.logSecurityEvent('suspicious_pattern_detected', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
        patterns: threats
      }, 'warning');
    }

    next();
  };
}

export const securityMonitor = new SecurityMonitor();
