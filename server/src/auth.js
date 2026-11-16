// Senhas (scrypt) e tokens de sessão. Nada de senha ou token em texto puro no banco.
import crypto from 'node:crypto';

const N = 16384;
const TAM = 32;

export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), sal, TAM, { N });
  return `scrypt$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function verificarSenha(senha, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
  const sal = Buffer.from(partes[1], 'base64');
  const esperado = Buffer.from(partes[2], 'base64');
  if (esperado.length !== TAM) return false;
  const h = crypto.scryptSync(String(senha), sal, TAM, { N });
  return crypto.timingSafeEqual(h, esperado);
}

// Usado quando o usuário não existe, para o tempo de resposta não revelar isso.
export const HASH_FALSO = hashSenha(crypto.randomBytes(12).toString('hex'));

export function novoToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function senhaAleatoria() {
  return crypto.randomBytes(12).toString('base64url');
}
