module.exports = {
  apps: [{
    name: 'autenticacao',
    script: './src/app.js',
    instances: 4, // 4 workers para teste
    exec_mode: 'cluster', // modo cluster para múltiplos workers
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      CLUSTER_ENABLED: 'false' // Desabilita clustering interno quando PM2 gerencia
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      CLUSTER_ENABLED: 'false' // Desabilita clustering interno quando PM2 gerencia
    },
    // Configurações para balanceamento de carga real
    listen_timeout: 3000,
    kill_timeout: 5000,
    watch: ['src'],
    ignore_watch: ['node_modules', 'logs', '.git'],
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '500M'
  }]
};