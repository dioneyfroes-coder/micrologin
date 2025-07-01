// src/config/secrets.js
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

class SecretManager {
  constructor() {
    this.useVault = process.env.NODE_ENV === 'production';
  }

  async getSecret(key) {
    if (this.useVault) {
      // AWS Secrets Manager / HashiCorp Vault
      return await this.getFromVault(key);
    }
    return process.env[key];
  }

  async getFromVault(secretName) {
    const client = new SecretsManager({ region: 'us-east-1' });
    const response = await client.getSecretValue({ SecretId: secretName });
    return JSON.parse(response.SecretString);
  }
}

export const secretManager = new SecretManager();
