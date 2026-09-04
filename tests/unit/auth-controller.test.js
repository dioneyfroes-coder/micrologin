import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { AuthWebController } from '../../src/application/controllers/AuthController.js';

describe('AuthWebController - HTTP contract', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.resetModules();
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn()
    };
    next = jest.fn();
    req = {
      body: {},
      ip: '203.0.113.5',
      get: jest.fn().mockReturnValue('jest-agent')
    };
  });

  const buildController = (authService) => new AuthWebController(authService);

  it('returns 201 with the user on successful registration', async() => {
    const service = {
      registerUser: jest.fn().mockResolvedValue({
        success: true,
        user: { id: 'u-1', username: 'alice' }
      })
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

  it('returns tokens and user on successful login', async() => {
    const service = {
      authenticateUser: jest.fn().mockResolvedValue({
        success: true,
        user: { id: 'u-1', username: 'alice' },
        token: {
          accessToken: 'at',
          refreshToken: 'rt',
          type: 'Bearer',
          expiresIn: 900000
        }
      })
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).login(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        tokenType: 'Bearer'
      })
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns authentication failure with 401 on wrong credentials', async() => {
    const service = {
      authenticateUser: jest.fn().mockResolvedValue({
        success: false,
        error: 'Senha incorreta'
      })
    };
    req.body = { user: 'alice', password: 'WrongPass123!' };

    await buildController(service).login(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: 'AUTHENTICATION_FAILED'
    }));
  });

  it('returns the user profile on GET profile', async() => {
    req.user = { id: 'u-1' };
    const service = {
      getUserProfile: jest.fn().mockResolvedValue({
        success: true,
        user: { id: 'u-1', username: 'alice' }
      })
    };

    await buildController(service).getProfile(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { user: { id: 'u-1', username: 'alice' } }
    }));
  });

  it('returns 404 when the profile does not exist', async() => {
    req.user = { id: 'missing' };
    const service = {
      getUserProfile: jest.fn().mockResolvedValue({ success: false, error: 'Usuário não encontrado' })
    };

    await buildController(service).getProfile(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 404,
      code: 'USER_NOT_FOUND'
    }));
  });

  it('updates a profile successfully', async() => {
    req.user = { id: 'u-1' };
    req.body = { user: 'alice2' };
    const service = {
      updateUserProfile: jest.fn().mockResolvedValue({
        success: true,
        user: { id: 'u-1', username: 'alice2' }
      })
    };

    await buildController(service).updateProfile(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'Perfil atualizado com sucesso'
    }));
  });

  it('deletes a profile successfully', async() => {
    req.user = { id: 'u-1' };
    const service = {
      deleteUser: jest.fn().mockResolvedValue({ success: true })
    };

    await buildController(service).deleteProfile(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'Perfil deletado com sucesso'
    }));
  });

  it('forwards unexpected errors to the error handler', async() => {
    const unexpected = new Error('boom');
    const service = {
      authenticateUser: jest.fn().mockRejectedValue(unexpected)
    };
    req.body = { user: 'alice', password: 'StrongPass123!' };

    await buildController(service).login(req, res, next);

    expect(next).toHaveBeenCalledWith(unexpected);
  });

  it('returns a new token pair on a valid refresh token', async() => {
    const service = {
      refreshUserTokens: jest.fn().mockResolvedValue({
        success: true,
        token: {
          accessToken: 'new-at',
          refreshToken: 'new-rt',
          type: 'Bearer',
          expiresIn: 900000
        }
      })
    };
    req.body = { refreshToken: 'valid-rt' };

    await buildController(service).refresh(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        accessToken: 'new-at',
        refreshToken: 'new-rt'
      })
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the refresh token is revoked or invalid', async() => {
    const service = {
      refreshUserTokens: jest.fn().mockResolvedValue({
        success: false,
        error: 'Refresh token inválido',
        code: 'REFRESH_TOKEN_INVALID'
      })
    };
    req.body = { refreshToken: 'expired-rt' };

    await buildController(service).refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      code: 'REFRESH_TOKEN_INVALID'
    }));
  });

  it('returns 400 when the refresh token is missing', async() => {
    const service = {};
    req.body = {};

    await buildController(service).refresh(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      code: 'REFRESH_TOKEN_REQUIRED'
    }));
  });

  it('revokes access and refresh tokens on logout', async() => {
    req.user = { id: 'u-1' };
    req.headers = { authorization: 'Bearer some-access-token' };
    req.body = { refreshToken: 'some-refresh-token' };
    const service = {
      revokeToken: jest.fn().mockResolvedValue({ success: true }),
      revokeUserTokens: jest.fn().mockResolvedValue({ success: true })
    };

    await buildController(service).logout(req, res, next);

    expect(service.revokeToken).toHaveBeenCalledTimes(2);
    expect(service.revokeUserTokens).toHaveBeenCalledWith('u-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'Logout realizado com sucesso'
    }));
  });

  it('fails logout when no token is revocable', async() => {
    req.user = null;
    req.headers = {};
    req.body = {};
    const service = {
      revokeToken: jest.fn().mockResolvedValue({ success: false }),
      revokeUserTokens: jest.fn().mockResolvedValue({ success: false })
    };

    await buildController(service).logout(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 400,
      code: 'REVOCATION_FAILED'
    }));
  });
});
