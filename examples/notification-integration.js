/**
 * @fileoverview Exemplo de integração com sistema de notificações
 * Este arquivo demonstra como expandir o sistema para incluir notificações
 * automatizadas por email, Slack, e outros canais.
 */

import nodemailer from 'nodemailer';
import { WebClient } from '@slack/web-api';

const SECURITY_API_BASE = process.env.AUTH_SERVICE_URL || 'https://localhost:3000';

const fetchSecurityResource = async(path) => {
  const token = process.env.SECURITY_DASHBOARD_TOKEN;
  if (!token) {
    throw new Error('SECURITY_DASHBOARD_TOKEN não configurado');
  }

  const response = await fetch(`${SECURITY_API_BASE}${path}`, {
    headers: { 'X-Security-Token': token }
  });

  if (!response.ok) {
    throw new Error(`Falha ao consultar ${path}: HTTP ${response.status}`);
  }

  return response.json();
};

/**
 * Sistema de notificações para alertas de segurança
 */
class NotificationService {
  constructor() {
    this.emailTransporter = this.initEmailTransporter();
    this.slackClient = this.initSlackClient();
    this.webhooks = new Map();
  }

  /**
   * Inicializa transporter de email
   */
  initEmailTransporter() {
    if (!process.env.SMTP_HOST) {
      console.warn('⚠️ SMTP não configurado. Notificações por email desabilitadas.');
      return null;
    }

    return nodemailer.createTransporter({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  /**
   * Inicializa cliente Slack
   */
  initSlackClient() {
    if (!process.env.SLACK_BOT_TOKEN) {
      console.warn('⚠️ Slack não configurado. Notificações do Slack desabilitadas.');
      return null;
    }

    return new WebClient(process.env.SLACK_BOT_TOKEN);
  }

  /**
   * Registra webhook personalizado
   */
  registerWebhook(name, url, headers = {}) {
    this.webhooks.set(name, { url, headers });
  }

  /**
   * Envia notificação de evento de segurança crítico
   */
  async sendCriticalSecurityAlert(event) {
    const message = {
      title: '🚨 ALERTA CRÍTICO DE SEGURANÇA',
      description: `Evento crítico detectado: ${event.type}`,
      details: {
        ip: event.ip,
        userAgent: event.userAgent,
        timestamp: event.timestamp,
        severity: event.severity,
        description: event.description
      },
      priority: 'HIGH'
    };

    // Enviar por todos os canais configurados
    await Promise.allSettled([
      this.sendEmail(message),
      this.sendSlack(message),
      this.sendWebhooks(message)
    ]);
  }

  /**
   * Envia notificação por email
   */
  async sendEmail(message) {
    if (!this.emailTransporter) return;

    try {
      const htmlContent = this.generateEmailHTML(message);
      
      await this.emailTransporter.sendMail({
        from: process.env.SMTP_FROM || 'security@company.com',
        to: process.env.SECURITY_EMAIL_LIST || 'admin@company.com',
        subject: message.title,
        html: htmlContent
      });

      console.log('✅ Email de segurança enviado');
    } catch (error) {
      console.error('❌ Erro ao enviar email:', error.message);
    }
  }

  /**
   * Envia notificação para Slack
   */
  async sendSlack(message) {
    if (!this.slackClient) return;

    try {
      const blocks = this.generateSlackBlocks(message);
      
      await this.slackClient.chat.postMessage({
        channel: process.env.SLACK_SECURITY_CHANNEL || '#security-alerts',
        text: message.title,
        blocks
      });

      console.log('✅ Notificação Slack enviada');
    } catch (error) {
      console.error('❌ Erro ao enviar Slack:', error.message);
    }
  }

  /**
   * Envia para webhooks personalizados
   */
  async sendWebhooks(message) {
    for (const [name, webhook] of this.webhooks) {
      try {
        await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...webhook.headers
          },
          body: JSON.stringify(message)
        });

        console.log(`✅ Webhook ${name} enviado`);
      } catch (error) {
        console.error(`❌ Erro no webhook ${name}:`, error.message);
      }
    }
  }

  /**
   * Gera HTML para email
   */
  generateEmailHTML(message) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; }
          .alert { background: #ff4444; color: white; padding: 10px; }
          .details { background: #f5f5f5; padding: 15px; margin: 10px 0; }
          .detail-item { margin: 5px 0; }
        </style>
      </head>
      <body>
        <div class="alert">
          <h2>${message.title}</h2>
          <p>${message.description}</p>
        </div>
        
        <div class="details">
          <h3>Detalhes do Evento:</h3>
          ${Object.entries(message.details).map(([key, value]) => 
            `<div class="detail-item"><strong>${key}:</strong> ${value}</div>`
          ).join('')}
        </div>
        
        <p>
          <strong>Ação Recomendada:</strong> Verifique o dashboard de segurança imediatamente.<br>
          <a href="https://localhost:3000/security/stats">Dashboard de Segurança</a>
        </p>
      </body>
      </html>
    `;
  }

  /**
   * Gera blocos do Slack
   */
  generateSlackBlocks(message) {
    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: message.title
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message.description
        }
      },
      {
        type: 'section',
        fields: Object.entries(message.details).map(([key, value]) => ({
          type: 'mrkdwn',
          text: `*${key}:*\n${value}`
        }))
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Ver Dashboard'
            },
            url: 'https://localhost:3000/security/stats',
            style: 'danger'
          }
        ]
      }
    ];
  }

  /**
   * Envia relatório diário de segurança
   */
  async sendDailySecurityReport() {
    try {
      // Buscar estatísticas do dia
      const stats = await fetchSecurityResource('/security/stats');
      const events = await fetchSecurityResource('/security/events?period=24h');

      const report = {
        title: '📊 Relatório Diário de Segurança',
        description: 'Resumo das atividades de segurança das últimas 24 horas',
        details: {
          'Total de Requisições': stats.security.totalRequests,
          'Requisições Bloqueadas': stats.security.blockedRequests,
          'Tentativas de Login Falhadas': stats.security.failedLogins,
          'Atividades Suspeitas': stats.security.suspiciousActivities,
          'Nível de Risco': stats.security.riskLevel,
          'Eventos Críticos': events.events.filter(e => e.severity === 'critical').length
        },
        priority: 'NORMAL'
      };

      await this.sendEmail(report);
      console.log('✅ Relatório diário enviado');
    } catch (error) {
      console.error('❌ Erro ao enviar relatório diário:', error.message);
    }
  }

  /**
   * Configura alertas automáticos
   */
  setupAutomaticAlerts() {
    // Relatório diário às 8h
    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 8 && now.getMinutes() === 0) {
        this.sendDailySecurityReport();
      }
    }, 60000); // Verifica a cada minuto

    console.log('✅ Alertas automáticos configurados');
  }
}

/**
 * Integração com sistema de auditoria existente
 */
class SecurityNotificationIntegration {
  constructor() {
    this.notificationService = new NotificationService();
    this.setupIntegration();
  }

  setupIntegration() {
    // Configurar webhooks personalizados se necessário
    if (process.env.SIEM_WEBHOOK_URL) {
      this.notificationService.registerWebhook('siem', process.env.SIEM_WEBHOOK_URL, {
        'Authorization': `Bearer ${process.env.SIEM_API_KEY}`
      });
    }

    // Configurar alertas automáticos
    this.notificationService.setupAutomaticAlerts();
  }

  /**
   * Método para ser chamado pelo sistema de auditoria
   */
  async handleSecurityEvent(event) {
    // Apenas eventos críticos geram notificações imediatas
    if (event.severity === 'critical' || event.severity === 'high') {
      await this.notificationService.sendCriticalSecurityAlert(event);
    }

    // Log para monitoramento
    console.log(`📧 Notificação processada para evento: ${event.type}`);
  }
}

// Exemplo de uso
export default SecurityNotificationIntegration;

// Configuração de exemplo no .env
/*
# Configurações de Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=security@yourcompany.com
SECURITY_EMAIL_LIST=admin@company.com,security@company.com

# Configurações do Slack
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_SECURITY_CHANNEL=#security-alerts

# Webhooks personalizados
SIEM_WEBHOOK_URL=https://your-siem.com/api/events
SIEM_API_KEY=your-siem-api-key
*/

// Exemplo de integração no middleware de auditoria
/*
import SecurityNotificationIntegration from './path/to/this/file.js';

const notificationIntegration = new SecurityNotificationIntegration();

// No middleware de auditoria, adicionar:
if (event.severity === 'critical') {
  await notificationIntegration.handleSecurityEvent(event);
}
*/
