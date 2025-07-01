import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { validationResult } from 'express-validator';
import User from '../models/User.js';

/**
 * Controller para operações de autenticação
 */
export class AuthController {
  /**
     * Realiza login do usuário
     */
  static login = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { user, password } = req.body;
    console.log('Requisição de login recebida:', { user, password: password ? '***' : undefined });

    passport.authenticate('local', { session: false }, (err, userObj, info) => {
      if (err) {
        console.error('Erro no passport.authenticate:', err);
        return next(err);
      }
      if (!userObj) {
        console.log('Falha na autenticação:', info);
        return res.status(401).json({ message: 'Usuário ou senha incorretos' });
      }

      const token = jwt.sign(
        { id: userObj._id, user: userObj.user },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES }
      );

      console.log('Login bem-sucedido. Token gerado:', token);
      res.json({ token });
    })(req, res, next);
  };

  /**
     * Registra novo usuário
     */
  static register = async(req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { user, password } = req.body;
    console.log('Requisição de cadastro recebida:', { user, password: password ? '***' : undefined });

    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new User({ user, password: hashedPassword });
      await newUser.save();
      console.log('Novo usuário cadastrado:', user);
      res.status(201).json({ message: 'Usuário registrado com sucesso' });
    } catch (error) {
      if (error.code === 11000) {
        console.log('Usuário já existe:', user);
        return res.status(409).json({ message: 'Usuário já existe.' });
      }
      console.error('Erro ao registrar usuário:', error);
      res.status(500).json({ message: 'Erro interno do servidor.' });
    }
  };

  /**
     * Obtém perfil do usuário autenticado
     */
  static getProfile = async(req, res) => {
    try {
      const user = await User.findById(req.user.id).select('-password');
      if (!user) {
        return res.status(404).json({ message: 'Usuário não encontrado' });
      }
      res.json({ user: user.user });
    } catch (error) {
      res.status(500).json({ message: 'Erro ao buscar perfil', error: error.message });
    }
  };

  /**
     * Atualiza dados do usuário autenticado
     */
  static updateProfile = async(req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { user, password } = req.body;
    try {
      const updateData = {};
      if (user) {
        updateData.user = user;
      }
      if (password) {
        updateData.password = await bcrypt.hash(password, 10);
      }

      const updatedUser = await User.findByIdAndUpdate(
        req.user.id,
        { $set: updateData },
        { new: true, runValidators: true }
      ).select('-password');

      if (!updatedUser) {
        return res.status(404).json({ message: 'Usuário não encontrado' });
      }
      res.json({ message: 'Usuário atualizado com sucesso', user: updatedUser.user });
    } catch (error) {
      if (error.code === 11000) {
        return res.status(409).json({ message: 'Nome de usuário já existe.' });
      }
      res.status(500).json({ message: 'Erro ao atualizar usuário', error: error.message });
    }
  };

  /**
     * Remove usuário autenticado
     */
  static deleteProfile = async(req, res) => {
    try {
      const deleted = await User.findByIdAndDelete(req.user.id);
      if (!deleted) {
        return res.status(404).json({ message: 'Usuário não encontrado' });
      }
      res.json({ message: 'Usuário removido com sucesso' });
    } catch (error) {
      res.status(500).json({ message: 'Erro ao remover usuário', error: error.message });
    }
  };
}
