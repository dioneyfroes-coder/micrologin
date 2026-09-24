// PM2 não deve duplicar o .env: os valores vêm do próprio .env (fonte da
// verdade) via dotenv. build:pm2 também exporta NODE_ENV=production, que
// tem precedência (dotenv não sobrescreve variáveis já definidas).
require('dotenv').config();

module.exports = {
  apps: [{
    name: 'autenticacao',
    script: './dist/app.js',
    instances: Number(process.env.PM2_INSTANCES) || 4, // workers; sobrescreva com PM2_INSTANCES
    exec_mode: 'cluster', // modo cluster para múltiplos workers
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: process.env.PORT || 3000,
      CLUSTER_ENABLED: 'false' // PM2 já gerencia cluster; app não divide senão conflito
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      CLUSTER_ENABLED: 'false'
    },
    // Configurações para balanceamento de carga real
    listen_timeout: 3000,
    kill_timeout: 5000,
    watch: ['dist'],
    ignore_watch: ['node_modules', 'logs', '.git'],
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '500M'
  }]
};