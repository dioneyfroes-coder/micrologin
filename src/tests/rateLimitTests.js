/**
 * @fileoverview Testes de Rate Limiting
 *
 * Verifica se o rate limiting está funcionando corretamente
 * para proteger contra abuso e ataques DDoS
 */

import request from 'supertest';

/**
 * Suite de testes para Rate Limiting
 */
export class RateLimitTests {
  constructor(app, testConfig = {}) {
    this.app = app;
    this.testConfig = {
      baseUrl: '/api',
      loginEndpoint: '/login',
      maxRequests: 50, // Configurar conforme seu limite
      timeWindow: 60000, // 1 minuto em ms
      ...testConfig
    };
  }

  /**
   * Teste 1: Verificar se rate limiting bloqueia requisições excessivas
   */
  async testRateLimitBloooking() {
    console.log('\n🧪 Teste 1: Rate Limiting - Bloqueio por excesso de requisições');

    const testData = {
      user: 'testuser',
      password: 'TestPassword123!'
    };

    const requests = [];
    let successCount = 0;
    let blockedCount = 0;

    // Fazer muitas requisições
    for (let i = 0; i < this.testConfig.maxRequests + 10; i++) {
      try {
        const response = await request(this.app)
          .post(`${this.testConfig.baseUrl}${this.testConfig.loginEndpoint}`)
          .send(testData);

        requests.push({
          status: response.status,
          blocked: response.status === 429,
          timestamp: Date.now()
        });

        if (response.status === 429) {
          blockedCount++;
        } else {
          successCount++;
        }

        // Log a cada 10 requisições
        if ((i + 1) % 10 === 0) {
          console.log(`  📊 Requisições enviadas: ${i + 1}`);
        }
      } catch (error) {
        console.error(`  ❌ Erro na requisição ${i + 1}:`, error.message);
      }
    }

    const result = {
      passed: blockedCount > 0,
      successCount,
      blockedCount,
      details: {
        message: blockedCount > 0
          ? '✅ Rate limiting funcionando - requisições foram bloqueadas'
          : '❌ Rate limiting NÃO funcionou - nenhuma requisição foi bloqueada'
      }
    };

    console.log(`\n  Resultado: ${result.details.message}`);
    console.log(`  Requisições bem-sucedidas: ${successCount}`);
    console.log(`  Requisições bloqueadas (429): ${blockedCount}`);

    return result;
  }

  /**
   * Teste 2: Verificar se diferentes IPs não compartilham limite
   */
  async testRateLimitPerIP() {
    console.log('\n🧪 Teste 2: Rate Limiting - Limite por IP');

    const testData = {
      user: 'testuser',
      password: 'TestPassword123!'
    };

    const ips = ['192.168.1.1', '192.168.1.2', '192.168.1.3'];
    const results = {};

    for (const ip of ips) {
      let successCount = 0;

      // Fazer algumas requisições por IP
      for (let i = 0; i < 10; i++) {
        try {
          const response = await request(this.app)
            .post(`${this.testConfig.baseUrl}${this.testConfig.loginEndpoint}`)
            .set('X-Forwarded-For', ip)
            .send(testData);

          if (response.status !== 429) {
            successCount++;
          }
        } catch {
          // Ignorar erros
        }
      }

      results[ip] = { successCount };
    }

    const allSuccessful = Object.values(results).every(r => r.successCount > 0);

    console.log(`\n  Resultado: ${allSuccessful ? '✅ IPs isolados' : '❌ Problema de isolamento'}`);
    Object.entries(results).forEach(([ip, data]) => {
      console.log(`  IP ${ip}: ${data.successCount} requisições bem-sucedidas`);
    });

    return { passed: allSuccessful, results };
  }

  /**
   * Teste 3: Verificar se limite de login é mais restritivo
   */
  async testLoginRateLimit() {
    console.log('\n🧪 Teste 3: Rate Limiting - Limite específico para LOGIN');

    const testData = {
      user: 'testuser',
      password: 'WrongPassword123!'
    };

    let blockedAfterN = -1;

    // Tentar login múltiplas vezes
    for (let i = 0; i < 20; i++) {
      try {
        const response = await request(this.app)
          .post(`${this.testConfig.baseUrl}${this.testConfig.loginEndpoint}`)
          .send(testData);

        if (response.status === 429 && blockedAfterN === -1) {
          blockedAfterN = i + 1;
          console.log(`  🚫 Bloqueado na tentativa #${blockedAfterN}`);
        }
      } catch {
        // Ignorar
      }
    }

    const result = {
      passed: blockedAfterN > 0 && blockedAfterN <= 10,
      blockedAfterN,
      details: {
        message: blockedAfterN > 0
          ? `✅ Login rate limiting funcionando (bloqueado após ${blockedAfterN} tentativas)`
          : '❌ Login rate limiting NÃO está funcionando'
      }
    };

    console.log(`\n  ${result.details.message}`);
    return result;
  }

  /**
   * Teste 4: Verificar headers de rate limit nas respostas
   */
  async testRateLimitHeaders() {
    console.log('\n🧪 Teste 4: Rate Limiting - Headers nas respostas');

    const testData = {
      user: 'testuser',
      password: 'TestPassword123!'
    };

    try {
      const response = await request(this.app)
        .post(`${this.testConfig.baseUrl}${this.testConfig.loginEndpoint}`)
        .send(testData);

      const hasLimitHeaders =
        response.headers['x-ratelimit-limit'] ||
        response.headers['x-ratelimit-remaining'] ||
        response.headers['ratelimit-limit'];

      console.log(`\n  Headers presentes: ${hasLimitHeaders ? '✅ Sim' : '❌ Não'}`);

      if (hasLimitHeaders) {
        console.log(`  Limite: ${response.headers['x-ratelimit-limit']}`);
        console.log(`  Restante: ${response.headers['x-ratelimit-remaining']}`);
      }

      return { passed: hasLimitHeaders, headers: response.headers };
    } catch (error) {
      console.error(`  ❌ Erro ao verificar headers: ${error.message}`);
      return { passed: false, error: error.message };
    }
  }

  /**
   * Executar todos os testes
   */
  async runAllTests() {
    console.log('\n' + '='.repeat(60));
    console.log('🔍 SUITE DE TESTES - RATE LIMITING');
    console.log('='.repeat(60));

    const results = {
      blocking: await this.testRateLimitBloooking(),
      perIP: await this.testRateLimitPerIP(),
      loginLimit: await this.testLoginRateLimit(),
      headers: await this.testRateLimitHeaders()
    };

    const allPassed = Object.values(results).every(r => r.passed);

    console.log('\n' + '='.repeat(60));
    console.log(`📊 RESULTADO FINAL: ${allPassed ? '✅ TODOS OS TESTES PASSARAM' : '❌ ALGUNS TESTES FALHARAM'}`);
    console.log('='.repeat(60) + '\n');

    return results;
  }
}

/**
 * Helper para executar testes de rate limiting
 * @param {Object} app - Express app
 * @param {Object} config - Configuração dos testes
 */
export async function runRateLimitTests(app, config = {}) {
  const tester = new RateLimitTests(app, config);
  return tester.runAllTests();
}
