import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AuthWebController } from '../../src/application/controllers/AuthController.js';
import { HttpError } from '../../src/shared/utils/errorHandler.js';

describe('AuthWebController - contrato HTTP', () => {
  let req: Record<string, any>;
  let res: Record<string, any>;
  let next: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn()
    };
    next = jest.fn();
    req = {
      body: {},
      ip: '203.0.113.5',
      get: jest.fn().mockReturnValue('jest-agent'),
      headers: {}
    };
  });

  const buildController = (authService: Record<string, any>) => new AuthWebController(authService as never);

  it('registra usuário com 201 e os dados do usuário', async() => {
    const service = {
      registerUser: jest.fn().mockResolvedValue({ success: true, user: { id: 'u-1', username: 'alice' } })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).register(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { user: { id: 'u-1', username: 'alice' } }
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('responde 400 quando o registro falha', async() => {
    const service = {
      registerUser: jest.fn().mockResolvedValue({ success: false, error: 'Usuário já existe' })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(HttpError));
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('REGISTRATION_FAILED');
    expect(err.message).toBe('Não foi possível criar a conta');
  });

  it('faz login com sucesso devolvendo tokens e usuário', async() => {
    const service = {
      authenticateUser: jest.fn().mockResolvedValue({
        success: true,
        user: { id: 'u-1', username: 'alice' },
        token: { accessToken: 'at', refreshToken: 'rt', type: 'Bearer', expiresIn: 900000 }
      })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).login(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ accessToken: 'at', refreshToken: 'rt' })
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('responde 401 quando o login falha', async() => {
    const service = {
      authenticateUser: jest.fn().mockResolvedValue({ success: false, error: 'Senha incorreta' })
    };
    req.body = { user: 'alice', password: 'WrongPass123!' };

    await buildController(service).login(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('AUTHENTICATION_FAILED');
    expect(err.message).toBe('Credenciais inválidas');
  });

  it.each([
    'Usuário não encontrado',
    'Senha incorreta',
    'Não foi possível autenticar o usuário'
  ])('normaliza a mensagem pública de falha %s', async(error) => {
    const service = {
      authenticateUser: jest.fn().mockResolvedValue({ success: false, error })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).login(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.message).toBe('Credenciais inválidas');
  });

  it.each([
    'Usuário já existe',
    'Não foi possível registrar o usuário'
  ])('normaliza a mensagem pública de registro %s', async(error) => {
    const service = {
      registerUser: jest.fn().mockResolvedValue({ success: false, error })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).register(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.message).toBe('Não foi possível criar a conta');
  });

  it('responde 400 quando a validação HTTP falha no refresh', async() => {
    const service = { refreshUserTokens: jest.fn() };
    req.body = {};

    await buildController(service).refresh(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('REFRESH_TOKEN_REQUIRED');
  });

  it('renova os tokens com sucesso', async() => {
    const service = {
      refreshUserTokens: jest.fn().mockResolvedValue({
        success: true,
        token: { accessToken: 'at2', refreshToken: 'rt2', type: 'Bearer', expiresIn: 900000 }
      })
    };
    req.body = { refreshToken: 'rt' };

    await buildController(service).refresh(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('responde 401 para refresh token inválido/expirado', async() => {
    const service = {
      refreshUserTokens: jest.fn().mockResolvedValue({ success: false, code: 'REFRESH_TOKEN_EXPIRED', error: 'expirado' })
    };
    req.body = { refreshToken: 'rt' };

    await buildController(service).refresh(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });

  it('faz logout revogando access e refresh tokens', async() => {
    const service = {
      revokeToken: jest.fn().mockResolvedValue({ success: true }),
      revokeUserTokens: jest.fn().mockResolvedValue({ success: true })
    };
    req.headers.authorization = 'Bearer access-token';
    req.body = { refreshToken: 'refresh-token' };

    await buildController(service).logout(req, res, next);

    expect(service.revokeToken).toHaveBeenCalledWith('access-token');
    expect(service.revokeToken).toHaveBeenCalledWith('refresh-token');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('responde 400 no logout quando nada pôde ser revogado', async() => {
    const service = {
      revokeToken: jest.fn().mockResolvedValue({ success: false }),
      revokeUserTokens: jest.fn().mockResolvedValue({ success: false })
    };

    await buildController(service).logout(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('REVOCATION_FAILED');
  });

  it('obtém perfil autenticado', async() => {
    const service = {
      getUserProfile: jest.fn().mockResolvedValue({ success: true, user: { id: 'u-1', username: 'alice' } })
    };
    req.user = { id: 'u-1', username: 'alice' };

    await buildController(service).getProfile(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('responde 404 quando o perfil não existe', async() => {
    const service = {
      getUserProfile: jest.fn().mockResolvedValue({ success: false, error: 'Usuário não encontrado' })
    };
    req.user = { id: 'missing', username: 'x' };

    await buildController(service).getProfile(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('USER_NOT_FOUND');
  });

  it('atualiza o perfil com sucesso', async() => {
    const service = {
      updateUserProfile: jest.fn().mockResolvedValue({ success: true, user: { id: 'u-1', username: 'alice2' } })
    };
    req.user = { id: 'u-1', username: 'alice' };
    req.body = { user: 'alice2' };

    await buildController(service).updateProfile(req, res, next);

    expect(service.updateUserProfile).toHaveBeenCalledWith('u-1', 'alice2', undefined);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('deleta o perfil com sucesso', async() => {
    const service = {
      deleteUser: jest.fn().mockResolvedValue({ success: true })
    };
    req.user = { id: 'u-1', username: 'alice' };

    await buildController(service).deleteProfile(req, res, next);

    expect(service.deleteUser).toHaveBeenCalledWith('u-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
