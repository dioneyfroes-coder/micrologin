import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcrypt';
import User from '../models/User.js';

/**
 * Configura a estratégia de autenticação local do Passport
 */
export const configurePassport = () => {
  passport.use(new LocalStrategy(
    { usernameField: 'user', passwordField: 'password' },
    async(user, password, done) => {
      console.log('Tentando autenticar usuário:', user);
      try {
        const foundUser = await User.findOne({ user });
        if (!foundUser) {
          console.log('Usuário não encontrado:', user);
          return done(null, false, { message: 'Usuário ou senha incorretos' });
        }

        const valid = await bcrypt.compare(password, foundUser.password);
        if (!valid) {
          console.log('Senha inválida para usuário:', user);
          return done(null, false, { message: 'Usuário ou senha incorretos' });
        }

        console.log('Usuário autenticado com sucesso:', user);
        return done(null, foundUser);
      } catch (error) {
        console.error('Erro na autenticação:', error);
        return done(error);
      }
    }
  ));
};
