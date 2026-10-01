// PM2 não deve duplicar o .env: os valores vêm do próprio .env (fonte da
// verdade) via dotenv. build:pm2 também exporta NODE_ENV=production, que
// tem precedência (dotenv não sobrescreve variáveis já definidas).
require('dotenv').config();

/**
 * Quantas instâncias o PM2 deve subir.
 *
 * `4` quando a variável não existe; o valor digitado quando existe, mesmo que
 * seja 0 ou negativo. A distinção é entre "não disse" e "disse 0", e `||`
 * confunde as duas.
 */
function resolveInstances(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 4;
  }

  return Number(raw);
}

/**
 * Teto de heap por processo, em MB (Fase 3.2).
 *
 * 512 MB é o número que a medição de 400 VUs sustenta (docs/metricas.md): pico
 * de heap de 66 MB com o conjunto vivo em ~60 MB, e RSS de 377 MB no `/login`,
 * dos quais ~317 MB são memória nativa do argon2. 512 + 317 fica em ~829 MB,
 * dentro do teto de 1 GiB do container -- com teto maior, um estouro de heap
 * passaria a bater no OOM killer do cgroup em vez de virar
 * `ERR_heap_out_of_memory`.
 *
 * A mesma leitura do `|| DEFAULT` que o comentário acima explica: quem não disse
 * nada leva o default medido; quem disse traz o número pedido. `NaN` cai no
 * default pelo mesmo motivo de `0` não cair.
 */
function resolveHeapMb(raw = process.env.PM2_MAX_OLD_SPACE_MB) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 512;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
}

// A INSTÂNCIA do PM2 é o único multiplicador de processos quando ele gerencia o
// app. Por isso `CLUSTER_ENABLED` é 'false' nos dois blocos de env abaixo: o
// cluster module, ligado, faria cada instância do PM2 forkar N workers — com os
// defaults, 4 × 4 = 16 processos, ~392.9 MB de RSS cada no pico do `/login`,
// contra um teto de 1 GiB. O app tem uma trava que recusa o arranque nessa
// combinação (`clusterConflict` em src/interfaces/config/appConfig.ts), e o
// teste `tests/unit/pm2-cluster-exclusivity.test.ts` segura os dois lados:
// esta configuração e o bootstrap.
module.exports = {
  apps: [{
    name: 'autenticacao',
    script: './dist/app.js',
    // `Number(...) || 4` tratava `PM2_INSTANCES=0` como ausente: o `||` come o
    // zero e o operador recebia 4 instâncias depois de pedir para desligar. O
    // valor digitado tem de chegar ao PM2 intacto — `instances` abaixo de 1 é
    // erro do PM2, e o erro precisa ser dele, não um default silencioso por
    // cima. Só quando a variável não existe é que o default entra.
    instances: resolveInstances(process.env.PM2_INSTANCES), // workers; sobrescreva com PM2_INSTANCES
    exec_mode: 'cluster', // modo cluster para múltiplos workers
    env: {
      NODE_ENV: process.env.NODE_ENV || 'development',
      PORT: process.env.PORT || 3000,
      CLUSTER_ENABLED: 'false', // PM2 já gerencia cluster; app não divide senão conflito
      // Mesmo teto de heap do caminho compose (Fase 3.2). Os dois modos
      // suportados têm de ter a mesma memória por processo: com números
      // diferentes, o PM2 mediria e o compose não, e a medição valeria para um
      // e não para o outro.
      // `node_args`, e não `env`, porque `--max-old-space-size` é opção do
      // runtime; passada por `env` ela viraria variável de ambiente e o
      // processo sairia com o teto implícito do V8.
      // Sobrevivível por `PM2_MAX_OLD_SPACE_MB` para quem mexer no teto sem
      // editar o arquivo.
      NODE_OPTIONS: `--max-old-space-size=${resolveHeapMb()}`
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      CLUSTER_ENABLED: 'false',
      NODE_OPTIONS: `--max-old-space-size=${resolveHeapMb()}`
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