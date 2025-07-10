/**
 * MIDDLEWARE DE AUTENTICAÇÃO - Adapter para verificação de tokens
 *
 * Middleware que traduz tokens HTTP em contexto de usuário.
 * Usa o TokenPort para verificação.
 */

export class AuthWebMiddleware {
  constructor(tokenAdapter, userRepository, logger) {
    this.tokenAdapter = tokenAdapter;
    this.userRepository = userRepository;
    this.logger = logger;
  }

  /**
   * Middleware para autenticação obrigatória
   */
  authenticate = async(req, res, next) => {
    try {
      // Extrair token do header
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        return res.status(401).json({
          success: false,
          message: 'Token de acesso requerido'
        });
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      // Verificar token usando o adapter
      const decoded = await this.tokenAdapter.verify(token);

      // Verificar se usuário ainda existe
      const user = await this.userRepository.findById(decoded.id);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Usuário não encontrado'
        });
      }

      // Adicionar contexto do usuário à requisição
      req.user = {
        id: decoded.id,
        username: decoded.username
      };

      next();

    } catch (error) {
      this.logger.error('Erro na autenticação', error);

      if (error.message.includes('expired')) {
        return res.status(401).json({
          success: false,
          message: 'Token expirado'
        });
      }

      if (error.message.includes('inválido')) {
        return res.status(401).json({
          success: false,
          message: 'Token inválido'
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor'
      });
    }
  };

  /**
   * Middleware para autenticação opcional
   */
  optionalAuth = async(req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        req.user = null;
        return next();
      }

      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      try {
        const decoded = await this.tokenAdapter.verify(token);
        const user = await this.userRepository.findById(decoded.id);

        req.user = user ? {
          id: decoded.id,
          username: decoded.username
        } : null;
      } catch {
        req.user = null;
      }

      next();

    } catch (error) {
      this.logger.error('Erro na autenticação opcional', error);
      req.user = null;
      next();
    }
  };
}
