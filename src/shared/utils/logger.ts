/**
 * LOGGER UNIFICADO
 *
 * Único ponto de emissão de logs da aplicação.
 * Respeita LOG_LEVEL (debug|info|warn|error) e LOG_FORMAT (console|structured).
 *
 * Lê as variáveis diretamente do environment para não depender de
 * appConfig (evita dependência circular em arquivos de bootstrap).
 */

export const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LOG_LEVELS;

// Lidos sob demanda (a cada chamada) para permitir que o dotenv carregue
// LOG_LEVEL/LOG_FORMAT depois da avaliação deste módulo (env.ts roda antes).
const currentLevel = (): LogLevel => (process.env.LOG_LEVEL as LogLevel) || 'info';
const isStructured = (): boolean => (process.env.LOG_FORMAT || 'console') === 'structured';

export const shouldLog = (level: LogLevel): boolean => {
  const configuredLevel = currentLevel();
  const minLevel = LOG_LEVELS[configuredLevel as LogLevel] ?? LOG_LEVELS.info;
  return (LOG_LEVELS[level] ?? LOG_LEVELS.info) >= minLevel;
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  pid: number;
  message: string;
  [key: string]: unknown;
}

/**
 * Serializa um `Error` para o log.
 *
 * Existe porque `Error.message` e `Error.stack` não são propriedades enumeráveis:
 * espalhar o erro com `{...error}` — o caminho óbvio — produz `{}` e some com o
 * diagnóstico inteiro. Foi assim que uma falha de assinatura ES256 apareceu no
 * log como "Erro na autenticação" sem uma linha sequer de motivo, enquanto o
 * cliente recebia 401 de credencial inválida. `code` entra junto porque é ele
 * que separa, por exemplo, indisponibilidade de revogação de erro de token.
 */
const serializeError = (error: Error): Record<string, unknown> => {
  const code = (error as Error & { code?: unknown }).code;

  return {
    error: {
      name: error.name,
      message: error.message,
      // `code` costuma vir de `Object.assign(new Error(...), { code })` ou de
      // erro de biblioteca, e vive em campo próprio enumerável.
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.stack ? { stack: error.stack } : {})
    }
  };
};

const write = (level: LogLevel, message: string, meta?: unknown): void => {
  if (!shouldLog(level)) {
    return;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(meta instanceof Error
      ? serializeError(meta)
      : meta && typeof meta === 'object'
        ? meta as Record<string, unknown>
        : meta !== undefined ? { error: String(meta) } : {})
  };

  // No formato console o detalhe do erro entra na própria linha: o modo console
  // é o padrão e é onde a pessoa olha primeiro quando o serviço falha.
  const output = isStructured()
    ? JSON.stringify(entry)
    : [
      `[${entry.timestamp}] ${level.toUpperCase()} ${entry.pid} ${message}`,
      ...(meta instanceof Error
        ? [
          `  ↳ ${meta.name}: ${meta.message}`,
          ...(meta.stack ? meta.stack.split('\n').slice(1).map(line => `    ${line.trim()}`) : [])
        ]
        : [])
    ].join('\n');

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
};

export const logger = {
  debug: (message: string, meta?: unknown): void => write('debug', message, meta),
  info: (message: string, meta?: unknown): void => write('info', message, meta),
  warn: (message: string, meta?: unknown): void => write('warn', message, meta),
  error: (message: string, error?: unknown): void => write('error', message, error)
};
