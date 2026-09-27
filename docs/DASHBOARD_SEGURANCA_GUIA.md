# 🛡️ GUIA PRÁTICO: DASHBOARD DE SEGURANÇA

## 📋 VISÃO GERAL

Este documento fornece um guia prático e didático para utilizar o sistema de monitoramento e dashboard de segurança implementado no microserviço de autenticação.

> 🚨 **Alertas**: o serviço não embute nem scrapeia métricas. As fontes são os logs estruturados e o manifesto de `GET /observability` (protegido por `METRICS_TOKEN`). O alerta é escrito contra essas fontes, no meio de observabilidade que você plugar em `setAuthEventSink` (`src/application/observability/authEventSink.ts`).

## Credencial do dashboard

Todos os endpoints `/security/*` exigem `SECURITY_DASHBOARD_TOKEN` no header `X-Security-Token`. Configure um valor aleatório com pelo menos 32 caracteres antes de iniciar o serviço:

```bash
export SECURITY_DASHBOARD_TOKEN="$(openssl rand -hex 32)"
```

---

## ⚠️ RESOLUÇÃO DE PROBLEMAS

### **🔧 Erro PM2 no Windows: `spawn wmic ENOENT`**

**Problema**: Quando executar `pm2 status` ou `pm2 logs`, você pode ver o erro:
```
Error: spawn wmic ENOENT
```

**Causa**: O PM2 não consegue encontrar o comando `wmic` no PATH do Windows.

**💡 SOLUÇÕES:**

#### **Solução 1: Usar PowerShell como Administrador**
```powershell
# Abrir PowerShell como administrador e executar:
pm2 update
pm2 restart all
```

#### **Solução 2: Definir Variável de Ambiente**
```powershell
# No PowerShell:
$env:PM2_SILENT = "true"
pm2 start ecosystem.config.cjs
```

#### **Solução 3: Usar CMD em vez de PowerShell**
```cmd
# No Prompt de Comando:
pm2 status
pm2 logs autentication
```

#### **Solução 4: Instalar/Reiniciar PM2**
```powershell
npm uninstall -g pm2
npm install -g pm2@latest
pm2 update
```

**📝 NOTA**: Este erro não afeta o funcionamento da aplicação, apenas a exibição de algumas informações do PM2.

---

## 🚀 INÍCIO RÁPIDO

### **1. Verificar Status do Sistema**
```bash
# Verificar se o PM2 está rodando
pm2 status

# Verificar logs em tempo real
pm2 logs autentication --lines 50

# Verificar se o servidor está respondendo
curl -k https://localhost:3000/health
```

### **2. Acessar Dashboard Principal**
```bash
# Health check básico
curl -k https://localhost:3000/health

# Documentação da API
# Abrir no navegador: https://localhost:3000/api-docs
```

---

## 📊 ENDPOINTS DO DASHBOARD DE SEGURANÇA

### **🔍 1. Estatísticas em Tempo Real**
```bash
# Obter estatísticas atuais
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/stats

# Exemplo de resposta:
{
  "timestamp": "2025-07-09T16:59:40.000Z",
  "security": {
    "totalRequests": 1847,
    "blockedRequests": 23,
    "failedLogins": 12,
    "suspiciousActivities": 8,
    "riskLevel": "MEDIUM"
  },
  "rateLimit": {
    "activeBlocks": 2,
    "recentViolations": 5
  },
  "alerts": {
    "activeAlerts": 1,
    "lastAlert": "2025-07-09T16:55:30.000Z"
  }
}
```

### **📋 2. Relatório Completo**
```bash
# Gerar relatório detalhado
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/report

# Salvar relatório em arquivo
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/report > security-report.json

# Exemplo de resposta:
{
  "timestamp": "2025-07-09T16:59:40.000Z",
  "summary": {
    "totalRequests": 1847,
    "blockedRequests": 23,
    "successRate": "98.75%"
  },
  "topAttackTypes": [
    { "type": "sql_injection_attempt", "count": 8 },
    { "type": "xss_attempt", "count": 5 },
    { "type": "path_traversal", "count": 3 }
  ],
  "topAttackIPs": [
    { "ip": "192.168.1.100", "count": 12 },
    { "ip": "::1", "count": 8 }
  ],
  "recommendations": [
    "Considere implementar CAPTCHA para IP ::1",
    "Monitore atividade do IP 192.168.1.100"
  ]
}
```

### **📝 3. Eventos Recentes**
```bash
# Últimos eventos de segurança
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/events

# Filtrar por tipo de evento
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" "https://localhost:3000/security/events?type=failed_login"

# Filtrar por IP específico
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" "https://localhost:3000/security/events?ip=192.168.1.100"

# Exemplo de resposta:
{
  "events": [
    {
      "timestamp": "2025-07-09T16:59:37.000Z",
      "type": "BLOCKED_IP_ACCESS",
      "ip": "::1",
      "userAgent": "node",
      "path": "/api/auth/login",
      "reason": "IP temporarily blocked due to suspicious activity"
    },
    {
      "timestamp": "2025-07-09T16:58:15.000Z",
      "type": "FAILED_LOGIN",
      "ip": "192.168.1.100",
      "username": "admin",
      "reason": "Invalid credentials"
    }
  ]
}
```

### **🚨 4. Análise de Ameaças**
```bash
# Análise detalhada de ameaças
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/threats

# Exemplo de resposta:
{
  "threats": {
    "activeBruteForce": 2,
    "suspiciousIPs": ["::1", "192.168.1.100"],
    "patternMatches": [
      {
        "pattern": "SQL Injection",
        "count": 8,
        "lastOccurrence": "2025-07-09T16:59:37.000Z"
      }
    ]
  },
  "riskAssessment": {
    "level": "MEDIUM",
    "score": 65,
    "factors": [
      "Multiple failed login attempts",
      "SQL injection patterns detected"
    ]
  }
}
```

### **🏥 5. Health Check de Segurança**
```bash
# Status geral do sistema de segurança
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/health

# Exemplo de resposta:
{
  "status": "healthy",
  "components": {
    "rateLimit": "operational",
    "securityMonitoring": "operational",
    "auditLogging": "operational",
    "threatDetection": "operational"
  },
  "metrics": {
    "uptime": "2h 15m",
    "processedRequests": 1847,
    "alertsGenerated": 3
  }
}
```

---

## 🔧 EXEMPLOS PRÁTICOS DE USO

### **📊 Monitoramento Contínuo**
```bash
# Script para monitoramento contínuo (PowerShell)
# Salvar como: monitor-security.ps1

while ($true) {
    $stats = Invoke-RestMethod -Uri "https://localhost:3000/security/stats" -Headers @{ 'X-Security-Token' = $env:SECURITY_DASHBOARD_TOKEN } -SkipCertificateCheck
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    
    Write-Host "[$timestamp] Risk Level: $($stats.security.riskLevel)"
    Write-Host "  - Total Requests: $($stats.security.totalRequests)"
    Write-Host "  - Blocked: $($stats.security.blockedRequests)"
    Write-Host "  - Failed Logins: $($stats.security.failedLogins)"
    Write-Host ""
    
    Start-Sleep -Seconds 30
}
```

### **🚨 Sistema de Alertas Personalizado**
```bash
# Script para verificar alertas críticos
# Salvar como: check-alerts.ps1

$report = Invoke-RestMethod -Uri "https://localhost:3000/security/report" -Headers @{ 'X-Security-Token' = $env:SECURITY_DASHBOARD_TOKEN } -SkipCertificateCheck

if ($report.summary.blockedRequests -gt 50) {
    Write-Warning "ALERTA: Muitas requisições bloqueadas ($($report.summary.blockedRequests))"
}

if ($report.riskAssessment.level -eq "HIGH") {
    Write-Error "ALERTA CRÍTICO: Nível de risco ALTO!"
}

foreach ($recommendation in $report.recommendations) {
    Write-Host "💡 Recomendação: $recommendation"
}
```

### **📈 Relatório Periódico**
```bash
# Script para gerar relatório diário
# Salvar como: daily-report.ps1

$date = Get-Date -Format "yyyy-MM-dd"
$report = Invoke-RestMethod -Uri "https://localhost:3000/security/report" -Headers @{ 'X-Security-Token' = $env:SECURITY_DASHBOARD_TOKEN } -SkipCertificateCheck

# Salvar relatório
$report | ConvertTo-Json -Depth 10 | Out-File "security-report-$date.json"

# Enviar por email (opcional)
# Send-MailMessage -To "admin@company.com" -Subject "Security Report $date" -Body "Relatório em anexo" -Attachments "security-report-$date.json"
```

---

## 🛠️ INTEGRAÇÃO COM FERRAMENTAS EXTERNAS

### **📧 Integração com Email (PowerShell)**
```powershell
# Função para enviar alertas por email
function Send-SecurityAlert {
    param([string]$Message, [string]$Level)
    
    $smtpServer = "smtp.company.com"
    $from = "security@company.com"
    $to = "admin@company.com"
    
    Send-MailMessage -SmtpServer $smtpServer -From $from -To $to `
        -Subject "[$Level] Security Alert" -Body $Message
}

# Verificar e alertar
$stats = Invoke-RestMethod -Uri "https://localhost:3000/security/stats" -Headers @{ 'X-Security-Token' = $env:SECURITY_DASHBOARD_TOKEN } -SkipCertificateCheck
if ($stats.security.riskLevel -eq "HIGH") {
    Send-SecurityAlert "Nível de risco ALTO detectado!" "CRITICAL"
}
```

### **💬 Integração com Slack**
```bash
# Webhook do Slack
SLACK_WEBHOOK="https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"

# Função para enviar mensagem
send_slack_alert() {
    local message="$1"
    local level="$2"
    
    curl -X POST -H 'Content-type: application/json' \
        --data "{\"text\":\"🚨 [$level] $message\"}" \
        $SLACK_WEBHOOK
}

# Verificar e alertar
STATS=$(curl -s -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/stats)
RISK_LEVEL=$(echo $STATS | jq -r '.security.riskLevel')

if [ "$RISK_LEVEL" = "HIGH" ]; then
    send_slack_alert "Nível de risco ALTO no microserviço de auth!" "CRITICAL"
fi
```

---

## 🔍 ANÁLISE DE LOGS

### **📋 Logs Estruturados**
```bash
# Ver logs de segurança em tempo real
pm2 logs autentication | grep "SECURITY"

# Filtrar por tipo de evento
pm2 logs autentication | grep "FAILED_LOGIN"
pm2 logs autentication | grep "BLOCKED_IP"
pm2 logs autentication | grep "SUSPICIOUS_ACTIVITY"

# Analisar padrões específicos
pm2 logs autentication | grep "SQL injection"
pm2 logs autentication | grep "XSS attempt"
```

### **📊 Análise com PowerShell**
```powershell
# Analisar logs de erro
$errorLogs = Get-Content "logs\error-*.log" | Where-Object { $_ -match "SECURITY" }
$errorLogs | Group-Object { ($_ -split " ")[2] } | Sort-Object Count -Descending

# Contar eventos por IP
$securityEvents = Get-Content "logs\out-*.log" | Where-Object { $_ -match "SECURITY" }
$ipEvents = $securityEvents | Where-Object { $_ -match "IP: (.+?) \|" } | 
    ForEach-Object { [regex]::Match($_, "IP: (.+?) \|").Groups[1].Value }
$ipEvents | Group-Object | Sort-Object Count -Descending
```

---

## ⚠️ RESOLUÇÃO DO WARNING PM2

### **🔧 Warning: spawn wmic ENOENT**

**Problema:** PM2 não consegue encontrar o comando `wmic` no Windows.

**Soluções:**

#### **Opção 1: Instalar Windows Management Tools**
```powershell
# Verificar se wmic está disponível
wmic /?

# Se não estiver, instalar Windows Management Framework
# Baixar de: https://docs.microsoft.com/en-us/powershell/wmf/overview
```

#### **Opção 2: Adicionar wmic ao PATH**
```powershell
# Encontrar wmic
Get-ChildItem C:\ -Name "wmic.exe" -Recurse -ErrorAction SilentlyContinue

# Adicionar ao PATH (exemplo)
$env:PATH += ";C:\Windows\System32\wbem"
```

#### **Opção 3: Usar PM2 com monitoramento simplificado**
```javascript
// No ecosystem.config.cjs, adicionar:
module.exports = {
  apps: [{
    name: 'autentication',
    script: 'src/app.js',
    instances: 4,
    exec_mode: 'cluster',
    // Desabilitar monitoramento avançado
    pmx: false,
    monitoring: false
  }]
}
```

#### **Opção 4: Ignorar o warning (recomendado)**
Este warning **NÃO afeta o funcionamento** do microserviço. É apenas um problema de monitoramento interno do PM2.

---

## 📝 RESUMO DOS COMANDOS ESSENCIAIS

```bash
# 🔍 Verificações básicas
curl -k https://localhost:3000/health
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/stats

# 📊 Monitoramento
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/report
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/events

# 🚨 Análise de ameaças
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/threats
curl -k -H "X-Security-Token: $SECURITY_DASHBOARD_TOKEN" https://localhost:3000/security/health

# 📋 Logs
pm2 logs autentication --lines 100
pm2 logs autentication | grep "SECURITY"

# 🔧 Gerenciamento PM2
pm2 status
pm2 restart autentication
pm2 reload autentication
```

---

## 🎯 PRÓXIMOS PASSOS

A lista abaixo é o que realmente **não** está feito. O que já existe está no
README e no restante deste guia; repetir aqui só tornaria a lista um indicador
de quanto falta em vez de quanto existe.

### **De verdade pendente:**
1. **Notificação externa de alerta** — hoje o alerta é um log. O ponto de
   extensão é `setAuthEventSink` (`src/application/observability/authEventSink.ts`),
   não um `if` pendurado no logger de auditoria.
2. **Retenção de eventos de segurança** — o buffer é de 1000 eventos **por
   processo**, em memória. Um worker que reinicia perde o histórico, e em PM2 com
   N workers cada um tem o seu. Quem precisa de histórico além da janela precisa
   de destino externo.
3. **Integração com SIEM** — não existe; depende de ambiente externo.
4. **Alertas por regra** — o manifesto de `GET /observability` expõe volume,
   P50/P95/P99, taxa de erro, health e risco, mas quem lê é humano ou script.
   Nada dispara alerta de "P95 acima de X" hoje.

### **Descartado, com motivo:**
- **Rotação de logs** — já configurada (`max-size: 10m`, `max-file: 3` nos
  compose de dev e prod).
- **Documentação OpenAPI** — já existe em `/api-docs` (swagger-jsdoc).
- **Dashboard web** — `examples/security-dashboard.html` consome `GET /security/*`.
- **Testes automatizados do dashboard** — existem (`tests/unit/security-audit.test.ts`,
  `security-config`, `security-monitoring`, `security-token`).
- **Scripts de automação** — `scripts/` tem deploy, rollback, smoke test e
  monitoramento, e a CI (`.github/workflows/ci-cd.yml`) roda quality, testes,
  build, scanning e deploy.

---

## ✅ VALIDAÇÃO DO SISTEMA

**O que está verificado:**
- Detecção de padrões suspeitos wired no `app.ts` (`securityMonitor.detectThreats`)
- Buffer de auditoria único por processo, com janela de 5 minutos para alertas
  e cap de 1000 eventos
- Rate limiting por IP **e** por conta, com o resultado em resposta explícita
- Testes automatizados cobrindo auditoria, normalização de entrada, token
  (incluindo reuso de refresh) e a superfície de observabilidade

**Limites conhecidos, ditos aqui em vez de escondidos:**
- O histórico de segurança é **por processo e em memória**. Com PM2 em cluster,
  são N históricos, não um.
- Os alertas são logs: nada é enviado para fora do processo.
- A detecção de padrões é auxiliar e **não bloqueia** — quem bloqueia é o rate
  limiter. Os padrões em `securityMonitoring.ts` servem para sinalizar, e a
  proteção de entrada é a validação determinística de `validation.ts`.
