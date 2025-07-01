// src/utils/refreshToken.js

import crypto from 'crypto';

class RefreshTokenManager {
  constructor() {
    this.tokenStore = new Map(); // Use Redis em produção
  }

  generateRefreshToken(userId) {
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

    this.tokenStore.set(refreshToken, {
      userId,
      expires,
      used: false
    });

    return refreshToken;
  }

  validateRefreshToken(refreshToken) {
    const tokenData = this.tokenStore.get(refreshToken);

    if (!tokenData || tokenData.used || tokenData.expires < new Date()) {
      throw new Error('Refresh token inválido ou expirado');
    }

    // Marcar como usado (one-time use)
    tokenData.used = true;
    this.tokenStore.set(refreshToken, tokenData);

    return tokenData.userId;
  }
};

export const refreshTokenManager = new RefreshTokenManager();
