import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { lerConversa, textoDoZip, nomeDaConversa } from '../src/whatsapp.js';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';

const ANDROID = `16/11/2026 08:01 - As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.
16/11/2026 08:02 - Loja X: Bom dia! Preciso de uma coleta
Rua A, 100 até Rua B, 200
16/11/2026 08:03 - Speed: Fechado: motoboy a caminho
16/11/2026, 08:04 - Loja X: <Mídia oculta>`;
const IPHONE = `‎[16/11/2026, 09:10:05] Farmácia: Tem motoboy com baú?\r\n[16/11/2026, 09:11:00] Speed: Tem sim`;

// Monta um .zip mínimo (um arquivo comprimido) como o do iPhone.
function zip(nome, texto) {
  const dados = Buffer.from(texto, 'utf8');
  const comp = zlib.deflateRawSync(dados);
  const n = Buffer.from(nome);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(dados.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(dados.length, 24); central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const inicioCentral = 30 + n.length + comp.length;
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(1, 8); fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(46 + n.length, 12); fim.writeUInt32LE(inicioCentral, 16);
  return Buffer.concat([local, n, comp, central, n, fim]);
}

test('lê conversa do Android com mensagem de várias linhas e aviso do sistema', () => {
  const m = lerConversa(ANDROID);
  assert.equal(m.length, 4);
  assert.equal(m[0].autor, null);
  assert.equal(m[1].autor, 'Loja X');
  assert.equal(m[1].texto, 'Bom dia! Preciso de uma coleta\nRua A, 100 até Rua B, 200');
  assert.equal(m[2].texto, 'Fechado: motoboy a caminho', 'dois-pontos dentro do texto não quebra o autor');
  assert.equal(new Date(m[1].ts).getHours(), 8);
});

test('lê conversa do iPhone dentro do .zip', () => {
  const texto = textoDoZip(zip('_chat.txt', IPHONE));
  const m = lerConversa(texto);
  assert.deepEqual(m.map((x) => [x.autor, x.texto]), [['Farmácia', 'Tem motoboy com baú?'], ['Speed', 'Tem sim']]);
  assert.equal(new Date(m[0].ts).getSeconds(), 5);
  assert.equal(nomeDaConversa('Conversa do WhatsApp com Loja X.zip'), 'Loja X');
  assert.equal(nomeDaConversa('_chat.txt'), 'Conversa do WhatsApp');
});

test('importar no sistema: reimportar não duplica e mensagem vira demanda', () => {
  const s = criarServico({ db: abrirBanco(':memory:') });
  const b64 = Buffer.from(ANDROID).toString('base64');
  const r1 = s.importarWhatsapp({ arquivo: 'Conversa do WhatsApp com Loja X.txt', conteudo: b64 }, 'teste');
  assert.equal(r1.novas, 4);
  const r2 = s.importarWhatsapp({ arquivo: 'Conversa do WhatsApp com Loja X.txt', conteudo: b64 }, 'teste');
  assert.equal(r2.novas, 0);
  assert.throws(() => s.importarWhatsapp({ arquivo: 'x.txt', conteudo: Buffer.from('nada aqui').toString('base64') }, 'teste'), { codigo: 'sem_mensagens' });

  const [conversa] = s.listarConversas();
  assert.equal(conversa.total, 4);
  const msg = s.mensagensDaConversa(conversa.id, 'coleta')[0];
  assert.match(msg.texto, /coleta/);
  assert.equal(s.mensagensDaConversa(conversa.id, '100%').length, 0, '% na busca é texto, não curinga');
  const d = s.criarDemanda({
    cliente: 'Loja X', mensagem_id: msg.id, descricao: msg.texto,
    coleta: { endereco: 'Rua A, 100', lat: -23.55, lon: -46.65 },
    entrega: { endereco: 'Rua B, 200', lat: -23.56, lon: -46.66 },
  }, 'teste');
  assert.equal(d.origem, 'whatsapp');
  assert.equal(s.mensagensDaConversa(conversa.id, 'coleta')[0].demanda_id, d.id);
  assert.equal(s.listarConversas()[0].demandas, 1);
  s.excluirConversa(conversa.id, 'teste');
  assert.equal(s.listarConversas().length, 0);
});
