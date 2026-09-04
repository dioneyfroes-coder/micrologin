import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { SecurityAuditLogger } from '../../src/application/middleware/securityAudit.js';

describe('SecurityAuditLogger - security event audit', () => {
  let logger;

  beforeEach(() => {
    logger = new SecurityAuditLogger();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers login attempts and updates failed-login counter', () => {
    logger.logLoginAttempt('alice', '203.0.113.10', 'jest-agent', false);

    expect(logger.getSecurityStats().failedLogins).toBe(1);
    expect(logger.getSecurityStats().totalRequests).toBe(1);
  });

  it('registers IP blocks with severity warning', () => {
    logger.logIPBlock('203.0.113.10', 'force attack', 300);

    const stats = logger.getSecurityStats();
    expect(stats.blockedRequests).toBe(1);
  });

  it('registers rate limit violations', () => {
    logger.logRateLimitViolation('203.0.113.10', '/login', 'jest-agent', 5);

    expect(logger.getSecurityStats().blockedRequests).toBe(1);
  });

  it('registers security attacks and truncates long payloads', () => {
    const longPayload = 'x'.repeat(500);
    logger.logSecurityAttack('XSS', '203.0.113.10', 'jest-agent', longPayload);

    const events = logger.events;
    expect(events).toHaveLength(1);
    expect(events[0].details.payload.length).toBeLessThanOrEqual(200);
  });

  it('returns meaningful security recommendations based on stats', () => {
    for (let i = 0; i < 60; i++) {
      logger.logLoginAttempt('user', 'ip', 'ua', false);
    }

    const report = logger.generateSecurityReport();
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.stats.failedLogins).toBe(60);
  });

  it('maintains only the most recent 1000 events', () => {
    for (let i = 0; i < 1100; i++) {
      logger.logLoginAttempt(`user${i}`, 'ip', 'ua', true);
    }

    expect(logger.events.length).toBe(1000);
  });

  it('calculates risk levels correctly', () => {
    expect(logger.calculateRiskLevel([])).toBe('MINIMAL');
  });

  it('logs suspicious activity', () => {
    logger.logSuspiciousActivity('203.0.113.10', 'jest-agent', 'path-traversal', '../etc/passwd');

    const events = logger.events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('suspicious_activity');
    expect(events[0].severity).toBe('warning');
  });

  it('tracks top attack types and IPs', () => {
    logger.logSecurityAttack('XSS', '203.0.113.10', 'ua', '<script>');
    logger.logSecurityAttack('XSS', '203.0.113.10', 'ua', '<script>');
    logger.logSecurityAttack('SQLi', '198.51.100.5', 'ua', '1\' OR 1=1');

    const report = logger.generateSecurityReport();
    expect(report.topAttackTypes[0].type).toBe('XSS');
    expect(report.topAttackIPs[0].ip).toBe('203.0.113.10');
  });
});
