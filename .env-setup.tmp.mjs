import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { createClient } from 'redis';

const ENV = '.env';
const raw = readFileSync(ENV, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);

// Senha do Mongo gravada no passo anterior (secrets/mongo-local.pw).
const mongoPassword = readFileSync('secrets/mongo-local.pw', 'utf8').trim();
const redisPassword = randomBytes(24).toString('base64url');
writeFileSync('secrets/redis-local.pw', redisPassword, { encoding: 'utf8', mode: 0o600 });

const values = {
  JWT_ALGORITHM: 'ES256',
  JWT_ES256_KID: '2026-q4',
  JWT_ES256_PRIVATE_KEY_PATH: './keys/jwt-es256-private.pem',
  JWT_ES256_PUBLIC_KEY_PATH: './keys/jwt-es256-public.pem',
  SECURITY_DASHBOARD_TOKEN: randomBytes(32).toString('base64url'),
  DEPENDENCY_NETWORK_ISOLATED: 'true',
  MONGODB_USER: 'micrologin_local',
  MONGODB_PASSWORD_PATH: './secrets/mongo-local.pw',
  REDIS_USERNAME: 'micrologin_local',
  REDIS_PASSWORD_PATH: './secrets/redis-local.pw'
};

for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

// `REDIS_PASSWORD=` vazio no .env continuaria sendo lido como "não definido",
// mas a linha vazia só gera confusão de leitura: quem abrir o .env vê uma
// senha em branco ao lado de REDIS_PASSWORD_PATH.
writeFileSync(
  ENV,
  lines
    .map((line) => (/^\s*REDIS_PASSWORD\s*=\s*$/.test(line) ? '#REDIS_PASSWORD (use REDIS_PASSWORD_PATH)' : line))
    .join(eol),
  'utf8'
);

// ACL persistente: o redis local sobe com `--aclfile` (ver
// scripts/start-local-redis.mjs). Um `ACL SETUSER` em memória morria no
// próximo restart do servidor e o arranque voltava a logar "Redis Error".
writeFileSync(
  'secrets/redis-local.acl',
  `user default off\r\nuser ${values.REDIS_USERNAME} on >${redisPassword} ~* &* +@all\r\n`,
  { encoding: 'ascii', mode: 0o600 }
);

const app = createClient({
  username: values.REDIS_USERNAME,
  password: redisPassword,
  socket: { reconnectStrategy: () => false }
});
app.on('error', () => {});

try {
  await app.connect();
  const pong = await app.ping();
  await app.quit();
  console.log('redis AUTH:', pong);
} catch (error) {
  console.log(`redis não autenticou (${error.message})`);
  console.log('reinicie o redis local para carregar secrets/redis-local.acl: npm run redis:start');
  process.exit(1);
}
console.log('mongo senha presente:', mongoPassword.length > 0);
console.log('.env de producao gravado');
