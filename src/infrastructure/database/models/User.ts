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
      // O campo guarda um HASH, não a senha. A política de senha em texto claro
      // (12 a 72 bytes) é do domínio, em `passwordPolicy.ts`, e vale para o que
      // o usuário digita — repeti-la aqui validava o hash como se fosse senha.
      // Com bcrypt (60 caracteres) isso passava despercebido; o hash argon2id
      // tem cerca de 100 e era recusado na gravação, o que transformava a
      // migração em erro 400 no registro.
      minlength: [32, 'Hash de senha inválido'],
      maxlength: [255, 'Hash de senha inválido']
    },
    // Rastreamento de alteração de senha
    passwordChangedAt: {
      type: Date,
      default: Date.now
    },
    // Histórico de senhas anteriores para prevenir reutilização.
    // Mantido no próprio documento (limitado pela política) para não precisar
    // de uma segunda coleção; nunca é devolvido em respostas HTTP.
    passwordHistory: {
      type: [String],
      default: [],
      select: false // Só é carregado quando a operação realmente precisa
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
