// Leitura da conversa exportada pelo WhatsApp ("Exportar conversa"): arquivo .txt (Android)
// ou .zip (iPhone, ou Android com mídia). Só o texto é aproveitado.
import zlib from 'node:zlib';

const TEXTO_MAX = 20 * 1024 * 1024;

// "16/11/2026 14:32 - João: oi"            (Android)
// "16/11/2026, 14:32 - João: oi"           (Android, outra versão)
// "[16/11/2026, 14:32:05] João: oi"        (iPhone)
const LINHA = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(?:-\s+)?(.*)$/;
const INVISIVEIS = /[‎‏‪-‮⁦-⁩﻿]/g;

export function lerConversa(texto) {
  const mensagens = [];
  let atual = null;
  for (const bruta of String(texto).split(/\r?\n/)) {
    const linha = bruta.replace(INVISIVEIS, '');
    const m = LINHA.exec(linha);
    if (!m) {
      if (atual) atual.texto += `\n${linha}`; // continuação de mensagem com várias linhas
      continue;
    }
    const [, d, mes, a, hh, mm, ss, resto] = m;
    const ano = a.length === 2 ? 2000 + Number(a) : Number(a);
    const ts = new Date(ano, Number(mes) - 1, Number(d), Number(hh), Number(mm), Number(ss || 0)).getTime();
    if (!Number.isFinite(ts) || Number(mes) > 12 || Number(d) > 31) {
      if (atual) atual.texto += `\n${linha}`;
      continue;
    }
    const sep = resto.indexOf(': ');
    atual = sep > 0 && sep <= 60
      ? { ts, autor: resto.slice(0, sep).trim(), texto: resto.slice(sep + 2) }
      : { ts, autor: null, texto: resto }; // aviso do sistema ("Fulano entrou", criptografia...)
    mensagens.push(atual);
  }
  for (const msg of mensagens) msg.texto = msg.texto.trim().slice(0, 4000);
  return mensagens.filter((msg) => msg.texto !== '');
}

// Lê o .zip sem biblioteca: acha o .txt da conversa pelo diretório central.
export function textoDoZip(buf) {
  let fimDir = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fimDir = i; break; }
  }
  if (fimDir < 0) throw new Error('zip inválido');
  const total = buf.readUInt16LE(fimDir + 10);
  let p = buf.readUInt32LE(fimDir + 16);
  const entradas = [];
  for (let k = 0; k < total && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip inválido');
    const metodo = buf.readUInt16LE(p + 10);
    const tamanho = buf.readUInt32LE(p + 20);
    const nomeLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const comentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + nomeLen);
    entradas.push({ nome, metodo, tamanho, local });
    p += 46 + nomeLen + extraLen + comentLen;
  }
  const txts = entradas.filter((e) => /\.txt$/i.test(e.nome) && !e.nome.startsWith('__MACOSX'));
  const e = txts.find((x) => /_chat\.txt$/i.test(x.nome)) || txts[0];
  if (!e) throw new Error('o zip não tem o .txt da conversa');
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('zip inválido');
  const inicio = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const dados = buf.subarray(inicio, inicio + e.tamanho);
  if (e.metodo === 0) return dados.toString('utf8');
  if (e.metodo === 8) return zlib.inflateRawSync(dados, { maxOutputLength: TEXTO_MAX }).toString('utf8');
  throw new Error('compactação do zip não suportada');
}

// "Conversa do WhatsApp com Loja X.txt" -> "Loja X"
export function nomeDaConversa(arquivo) {
  const base = String(arquivo || '').split(/[\\/]/).pop().replace(/\.(txt|zip)$/i, '');
  const limpo = base.replace(/^(Conversa do WhatsApp com|WhatsApp Chat with|WhatsApp Chat -|Conversa do WhatsApp -)\s*/i, '').trim();
  return (limpo && limpo !== '_chat' ? limpo : 'Conversa do WhatsApp').slice(0, 120);
}
