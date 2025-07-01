import crypto from 'crypto';
import { secretManager } from '../config/secrets.js';

class EncryptionManager {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32;
    this.ivLength = 16;
    this.tagLength = 16;
  }

  async getEncryptionKey() {
    try {
      // Usar KMS em produção
      return await secretManager.getSecret('ENCRYPTION_KEY');
    } catch {
      console.warn('⚠️ Usando chave de encrypt do .env como fallback');
      // Fallback para variável de ambiente
      return process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
    }
  }

  async encrypt(text) {
    const key = Buffer.from(await this.getEncryptionKey(), 'hex');
    const iv = crypto.randomBytes(this.ivLength);

    // ✅ USAR createCipherGCM (seguro)
    const cipher = crypto.createCipherGCM(this.algorithm, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  async decrypt(encryptedData) {
    const key = Buffer.from(await this.getEncryptionKey(), 'hex');

    // ✅ USAR createDecipherGCM (seguro)
    const decipher = crypto.createDecipherGCM(
      this.algorithm,
      key,
      Buffer.from(encryptedData.iv, 'hex')
    );

    decipher.setAuthTag(Buffer.from(encryptedData.tag, 'hex'));

    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

export const encryptionManager = new EncryptionManager();
