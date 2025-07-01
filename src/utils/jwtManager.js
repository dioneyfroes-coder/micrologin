import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { secretManager } from '../config/secrets.js';

class JWTManager {
  constructor() {
    this.keyRotationInterval = 24 * 60 * 60 * 1000; // 24h
    this.blacklistedTokens = new Set();
    this.currentKeyId = this.generateKeyId();
    this.keys = new Map();
    this.loadKeys();
  }

  generateKeyId() {
    return crypto.randomBytes(8).toString('hex');
  }

  async loadKeys() {
    try {
      // Carregar chaves do vault/secrets manager
      const primaryKey = await secretManager.getSecret('JWT_PRIMARY_KEY');
      const secondaryKey = await secretManager.getSecret('JWT_SECONDARY_KEY');

      this.keys.set(this.currentKeyId, primaryKey);
      this.keys.set('backup', secondaryKey);
    } catch {
      console.warn('⚠️ Usando JWT_SECRET do .env como fallback');
      // Fallback para JWT_SECRET do .env
      this.keys.set(this.currentKeyId, process.env.JWT_SECRET);
      this.keys.set('backup', process.env.JWT_SECRET);
    }
  }

  signToken(payload) {
    const now = Math.floor(Date.now() / 1000);
    const tokenPayload = {
      ...payload,
      iat: now,
      exp: now + (6 * 60 * 60), // 6h
      jti: crypto.randomUUID(), // Token ID único
      kid: this.currentKeyId, // Key ID
      iss: 'auth-service', // Issuer
      aud: 'api-gateway' // Audience
    };

    return jwt.sign(tokenPayload, this.keys.get(this.currentKeyId), {
      algorithm: 'HS256',
      header: { kid: this.currentKeyId }
    });
  }

  verifyToken(token) {
    try {
      const decoded = jwt.decode(token, { complete: true });
      const keyId = decoded.header.kid;

      // Verificar se token está na blacklist
      if (this.blacklistedTokens.has(decoded.payload.jti)) {
        throw new Error('Token revogado');
      }

      // Verificar com a chave correta
      const key = this.keys.get(keyId) || this.keys.get('backup');
      if (!key) {
        throw new Error('Chave não encontrada');
      }

      return jwt.verify(token, key);
    } catch (error) {
      throw new Error('Token inválido: ' + error.message);
    }
  }

  revokeToken(jti) {
    this.blacklistedTokens.add(jti);
    // TODO: Persistir em Redis com TTL
    console.log(`🔒 Token ${jti} adicionado à blacklist`);
  }

  rotateKeys() {
    // Rotacionar chaves de assinatura
    const newKeyId = this.generateKeyId();
    const oldKey = this.keys.get(this.currentKeyId);

    // Mover chave atual para backup
    this.keys.set('backup', oldKey);

    // Gerar nova chave primária
    this.currentKeyId = newKeyId;
    this.keys.set(this.currentKeyId, process.env.JWT_SECRET);

    console.log(`🔄 Chaves JWT rotacionadas. Nova ID: ${newKeyId}`);
  }
}

export default JWTManager;
export const jwtManager = new JWTManager();
