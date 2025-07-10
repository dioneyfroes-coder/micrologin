import mongoose from 'mongoose';

/**
 * @typedef {Object} User
 * @property {string} user - Nome de usuário
 * @property {string} password - Senha criptografada
 */
const UserSchema = new mongoose.Schema({
  user: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Usuário deve ter pelo menos 3 caracteres']
  },
  password: {
    type: String,
    required: true,
    minlength: [6, 'Senha deve ter pelo menos 6 caracteres']
  }
}, {
  timestamps: true // Adiciona createdAt e updatedAt automaticamente
});

const UserModel = mongoose.model('User', UserSchema);

// Export default para passport.js
export default UserModel;

// Export named para adapters
export const getUserModel = () => UserModel;
