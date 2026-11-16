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
