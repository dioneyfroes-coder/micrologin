/**
 * Entidade User - Núcleo do negócio
 * Contém as regras de negócio puras
 */
export class UserEntity {
  constructor(id, username, password, createdAt = new Date(), updatedAt = new Date()) {
    this.id = id;
    this.username = username;
    this.password = password;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  /**
   * Valida se o usuário é válido
   */
  isValid() {
    return this.username &&
           this.username.length >= 3 &&
           this.password &&
           this.password.length >= 6;
  }

  /**
   * Atualiza os dados do usuário
   */
  update(data) {
    if (data.username) {
      this.username = data.username;
    }
    if (data.password) {
      this.password = data.password;
    }
    this.updatedAt = new Date();
  }

  /**
   * Converte para objeto simples (sem senha)
   */
  toPublicObject() {
    return {
      id: this.id,
      username: this.username,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /**
   * Converte para objeto completo (com senha)
   */
  toCompleteObject() {
    return {
      id: this.id,
      username: this.username,
      password: this.password,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  /**
   * Valida se a senha está forte
   */
  isPasswordStrong() {
    return this.password &&
           this.password.length >= 8 &&
           /[A-Z]/.test(this.password) &&
           /[a-z]/.test(this.password) &&
           /[0-9]/.test(this.password);
  }

  /**
   * Clona o usuário
   */
  clone() {
    return new UserEntity(
      this.id,
      this.username,
      this.password,
      this.createdAt,
      this.updatedAt
    );
  }
}

/**
 * Entidade Authentication - Contém dados de autenticação
 */
export class AuthEntity {
  constructor(userId, token, refreshToken, expiresAt) {
    this.userId = userId;
    this.token = token;
    this.refreshToken = refreshToken;
    this.expiresAt = expiresAt;
    this.createdAt = new Date();
  }

  /**
   * Verifica se o token está expirado
   */
  isExpired() {
    return new Date() > this.expiresAt;
  }

  /**
   * Verifica se o token está válido
   */
  isValid() {
    return this.token && this.userId && !this.isExpired();
  }

  /**
   * Converte para objeto simples
   */
  toObject() {
    return {
      userId: this.userId,
      token: this.token,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt,
      createdAt: this.createdAt
    };
  }
}
