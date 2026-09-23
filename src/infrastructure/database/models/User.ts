import { Schema, model, Document } from 'mongoose';

/**
 * Interface do documento MongoDB (perfil persistido).
 * Nota: o banco usa `user`/`password`; o domínio usa `username`/`hashedPassword`.
 * Os adapters fazem o mapeamento entre os dois mundos.
 */
export interface IUser {
  user: string;
  password: string;
  passwordChangedAt: Date;
  passwordExpired: boolean;
  passwordHistory: string[];
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = IUser & Document;

const UserSchema = new Schema<IUser>(
  {
    user: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: [3, 'Usuário deve ter pelo menos 3 caracteres'],
      maxlength: [30, 'Usuário não pode ter mais de 30 caracteres'],
      match: [/^[a-zA-Z0-9_-]+$/, 'Usuário deve conter apenas letras, números, underscores e hífens']
    },
    password: {
      type: String,
      required: true,
      minlength: [12, 'Senha deve ter pelo menos 12 caracteres (política de segurança)']
    },
    // Rastreamento de alteração de senha
    passwordChangedAt: {
      type: Date,
      default: Date.now
    },
    // Flag para indicar expiração de senha
    passwordExpired: {
      type: Boolean,
      default: false
    },
    // Histórico de senhas anteriores para prevenir reutilização
    // (em produção, considere usar um serviço separado)
    passwordHistory: {
      type: [String],
      default: [],
      select: false // Não retorna por padrão
    }
  },
  {
    timestamps: true // Adiciona createdAt e updatedAt automaticamente
  }
);

const UserModel = model<IUser>('User', UserSchema);

// Export default para compatibilidade
export default UserModel;

// Export named para adapters
export const getUserModel = () => UserModel;
