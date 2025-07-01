module.exports = {
  apps: [{
    name: 'autenticacao',
    script: './src/app.js',
    instances: 1, // ← REDUZIR para 1 durante testes
    exec_mode: 'fork', // ← MUDAR para fork (não cluster)
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    watch: ['src'],
    ignore_watch: ['node_modules', 'logs', '.git'],
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '500M'
  }]
};