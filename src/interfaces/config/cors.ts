/**
 * @fileoverview Configuração de CORS em fonte única
 *
 * O app e os testes leem a mesma configuração. Antes as opções viviam inline no
 * `app.ts`, o que fazia "CORS conforme configuração" uma afirmação sem forma de
 * verificá-la: mudar `ALLOWED_ORIGINS` não alterava nenhum teste.
 */
import type { CorsOptions } from 'cors';
import { securityConfig } from './appConfig.js';

export const buildCorsOptions = (): CorsOptions => ({
  origin: securityConfig.cors.origins,
  credentials: securityConfig.cors.credentials,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Security-Token']
});
