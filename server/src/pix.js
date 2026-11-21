// Pix direto na conta da empresa, sem intermediário: monta o "Pix copia e cola" (BR Code)
// com a chave, o valor e o número do pedido. A confirmação do pagamento é manual (comprovante).

export const TIPOS_CHAVE = ['cnpj', 'cpf', 'telefone', 'email', 'aleatoria'];

const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

// Chave no formato que os bancos esperam. Devolve '' se não for válida para o tipo.
export function normalizarChave(tipo, bruta) {
  const texto = String(bruta ?? '').trim();
  const digitos = texto.replace(/\D/g, '');
  if (tipo === 'cnpj') return digitos.length === 14 ? digitos : '';
  if (tipo === 'cpf') return digitos.length === 11 ? digitos : '';
  if (tipo === 'telefone') {
    const nacional = digitos.length >= 12 && digitos.startsWith('55') ? digitos.slice(2) : digitos;
    return nacional.length === 10 || nacional.length === 11 ? `+55${nacional}` : '';
  }
  if (tipo === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto) && texto.length <= 77 ? texto.toLowerCase() : '';
  if (tipo === 'aleatoria') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(texto) ? texto.toLowerCase() : '';
  return '';
}

// Chave Pix digitada pelo motoboy (sem tipo): descobre o tipo e normaliza. 11 dígitos: CPF se o
// dígito verificador bater e não tiver cara de celular (DDD + 9); senão telefone.
const cpfValido = (d) => {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};
const DDDS = new Set('11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '));
export function chaveDoMotoboy(bruta) {
  const texto = String(bruta ?? '').trim();
  if (texto.includes('@')) { const c = normalizarChave('email', texto); return c ? { tipo: 'email', chave: c } : null; }
  const aleatoria = normalizarChave('aleatoria', texto);
  if (aleatoria) return { tipo: 'aleatoria', chave: aleatoria };
  let d = texto.replace(/\D/g, '');
  if (d.length === 14) return { tipo: 'cnpj', chave: d };
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  const formatoCpf = /^\d{3}\.\d{3}\.\d{3}-?\d{2}$/.test(texto);
  const celular = d.length === 11 && d[2] === '9' && DDDS.has(d.slice(0, 2));
  if (d.length === 11 && cpfValido(d) && (formatoCpf || !celular)) return { tipo: 'cpf', chave: d };
  if (d.length === 10 || celular) return { tipo: 'telefone', chave: `+55${d}`, duvida: d.length === 11 && cpfValido(d) };
  return null;
}

// CRC16-CCITT (polinômio 0x1021, início 0xFFFF), exigido no fim do código.
export function crc16(texto) {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function brCode({ chave, nome, cidade, valor, txid }) {
  const recebedor = semAcento(nome).replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, 25) || 'RECEBEDOR';
  const local = semAcento(cidade).replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, 15) || 'BRASIL';
  const id = String(txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const corpo = [
    campo('00', '01'),
    campo('26', campo('00', 'br.gov.bcb.pix') + campo('01', chave)),
    campo('52', '0000'),
    campo('53', '986'),
    valor != null ? campo('54', Number(valor).toFixed(2)) : '',
    campo('58', 'BR'),
    campo('59', recebedor),
    campo('60', local),
    campo('62', campo('05', id)),
    '6304',
  ].join('');
  return corpo + crc16(corpo);
}
