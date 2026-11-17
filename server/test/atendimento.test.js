import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';
import { criarAtendimento } from '../src/atendimento.js';
import { criarApp } from '../src/app.js';
import crypto from 'node:crypto';
import { interpretar, normalizarTelefone, destinoDe, enviar, assinaturaMetaConfere } from '../src/mensageiro.js';
import { brCode, crc16, normalizarChave } from '../src/pix.js';
import { criarIA } from '../src/ia.js';

process.env.TZ = 'America/Sao_Paulo'; // mesmo fuso do servidor em produção

const MIN = 60_000;
const P = (km) => ({ lat: -23.55, lon: -46.65 + km * 0.0098 });
const MAPA = { 'rua da coleta, 10, centro': P(0), 'rua da entrega, 20, centro': P(3) };

function montar(config = {}) {
  const relogio = { t: new Date('2026-03-10T09:00:00-03:00').getTime() };
  const db = abrirBanco(':memory:');
  const s = criarServico({ db, agora: () => relogio.t });
  const enviadas = [];
  const geocodificar = async (texto) => {
    const p = MAPA[texto.toLowerCase()];
    return p ? [{ nome: `${texto} (mapa)`, ...p }] : [];
  };
  // Mercado Pago de mentira: guarda as cobranças e deixa o teste dizer quando foi paga.
  const banco = { cobrancas: [], pagos: new Set(), falhar: false };
  const pagamentos = {
    criarPix: async (token, dados) => {
      if (banco.falhar) throw new Error('fora do ar');
      banco.cobrancas.push({ token, ...dados });
      return { id: `mp${banco.cobrancas.length}`, codigo: `PIX-${dados.referencia}`, qr: 'QUJD' };
    },
    consultar: async (token, id) => {
      const c = banco.cobrancas[Number(id.slice(2)) - 1];
      return { status: banco.pagos.has(id) ? 'approved' : 'pending', referencia: c.referencia, valor: c.valor };
    },
  };
  // IA de mentira: o teste escolhe a resposta; guarda o que foi enviado a ela.
  const iaFalsa = { resposta: null, pedidos: [], analise: null, analises: [] };
  const ia = {
    conferir: async (cfg, pedido) => { iaFalsa.pedidos.push(pedido); return iaFalsa.resposta && { ...iaFalsa.resposta }; },
    analisar: async (cfg, entrada) => {
      iaFalsa.analises.push(entrada);
      if (!iaFalsa.analise) throw new Error('IA fora do ar');
      return structuredClone(iaFalsa.analise);
    },
    ultimoErro: () => '',
  };
  const a = criarAtendimento({
    servico: s, geocodificar, pagamentos, ia,
    enviar: async (cfg, destino, texto) => { enviadas.push({ destino, texto }); },
  });
  s.salvarConfig({
    whats_provedor: 'webhook', whats_url: 'http://robo.local/enviar', url_publica: 'https://speed.exemplo',
    admin_telefone: '11988880000', preco_base: 8, preco_km_incluso: 2, preco_km: 2, ...config,
  }, 'teste');
  const cliente = async (texto, extra = {}) => {
    await a.despacharSaida();
    enviadas.length = 0;
    await a.receber({ telefone: '5511977770001', nome: 'Carla Souza', texto, ...extra });
    return enviadas.map((m) => m.texto).join('\n---\n');
  };
  const motoboyEmTurno = (extra = {}, km = 0) => {
    const m = { nome: 'Ana Lima', telefone: '11999990001', pin: '123456', veiculo: 'moto', tem_bag: true, ...extra };
    const id = s.criarMotoboy(m, 'teste');
    if (m.tipo !== 'avulso') s.convocar(id, 'teste');
    const { token } = s.loginMotoboy({ telefone: m.telefone, pin: '123456', aceito_termo: true, dispositivo: 'a', origem: 'app' }, 'ip');
    s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...P(km), ts: relogio.t, precisao: 10 }], gps_ligado: true });
    return { id, token };
  };
  const estadoDe = (token) => s.estadoMotoboy(s.autenticarMotoboy(token));
  // Aceita a primeira oferta aberta do motoboy.
  const aceitar = (token) => s.responderOferta(s.autenticarMotoboy(token), { oferta_id: estadoDe(token).ofertas[0].id, acao: 'aceitar' });
  const demandas = () => s.estadoAdmin().demandas;
  // Envia o que estava na fila e zera a lista, para conferir só o que vier depois.
  const limpar = async () => { await a.despacharSaida(); enviadas.length = 0; };
  return { s, a, db, relogio, enviadas, cliente, motoboyEmTurno, demandas, limpar, banco, estadoDe, aceitar, iaFalsa };
}

test('telefones: normaliza DDI, nono dígito e ids do WhatsApp', () => {
  assert.equal(normalizarTelefone('5511977770001@s.whatsapp.net'), '11977770001');
  assert.equal(normalizarTelefone('(11) 97777-0001'), '11977770001');
  assert.equal(normalizarTelefone('553188887777'), '31988887777', 'celular sem o nono dígito');
  assert.equal(normalizarTelefone('1133334444'), '1133334444', 'fixo fica como está');
  assert.equal(normalizarTelefone('123'), '');
  assert.equal(destinoDe('11977770001'), '5511977770001');
});

test('webhooks: Meta (mensagens e ecos do app) e genérico; Evolution não existe mais', () => {
  const meta = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field, value }] }] });
  const r = interpretar('meta', meta('messages', {
    contacts: [{ wa_id: '5511977770001', profile: { name: 'Carla' } }],
    messages: [
      { from: '5511977770001', id: 'wamid.A', type: 'text', text: { body: 'quero um motoboy' } },
      { from: '5511977770001', id: 'wamid.B', type: 'location', location: { latitude: -20.33, longitude: -40.29 } },
      { from: '5511977770001', id: 'wamid.C', type: 'reaction', reaction: { emoji: '👍' } },
    ],
  }));
  assert.deepEqual(r.map((m) => [m.telefone, m.nome, m.texto, m.lat]), [['11977770001', 'Carla', 'quero um motoboy', null], ['11977770001', 'Carla', '', -20.33]]);
  assert.equal(interpretar('meta', meta('messages', { statuses: [{ id: 'wamid.X', status: 'delivered' }] })).length, 0, 'status de entrega não vira mensagem');
  assert.equal(interpretar('meta', meta('smb_app_state_sync', { state_sync: [] })).length, 0);
  assert.equal(interpretar('meta', meta('history', { history: [] })).length, 0);
  // Coexistência: o que a empresa manda pelo app chega como eco (from = empresa, to = cliente).
  const eco = interpretar('meta', meta('smb_message_echoes', {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '5527999165959', phone_number_id: '123' },
    message_echoes: [
      { from: '5527999165959', to: '5511977770001', id: 'wamid.E1', timestamp: '1700255121', type: 'text', text: { body: 'Oi Carla, já vou ver' } },
      { from: '5527999165959', to: '5511977770001', id: 'wamid.E2', timestamp: '1700255122', type: 'image', image: { id: '99' } },
    ],
  }));
  assert.deepEqual(eco.map((m) => [m.eco, m.id, m.telefone, m.destino, m.texto]), [
    [true, 'wamid.E1', '11977770001', '5511977770001', 'Oi Carla, já vou ver'],
    [true, 'wamid.E2', '11977770001', '5511977770001', '(image enviada pelo app)'],
  ]);
  assert.equal(interpretar('meta', { object: 'page', entry: [] }).length, 0);
  assert.equal(interpretar('evolution', { event: 'messages.upsert', data: { key: { remoteJid: '5511977770001@s.whatsapp.net' }, message: { conversation: 'oi' } } }).length, 0);
  assert.deepEqual(interpretar('webhook', { telefone: '5511977770001', nome: 'Carla', texto: 'oi' }).map((m) => m.texto), ['oi']);
});

test('assinatura da Meta: HMAC-SHA256 do corpo original com o App Secret', () => {
  const corpo = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const certa = `sha256=${crypto.createHmac('sha256', 'segredo-do-app').update(corpo).digest('hex')}`;
  assert.equal(assinaturaMetaConfere('segredo-do-app', corpo, certa), true);
  assert.equal(assinaturaMetaConfere('outro', corpo, certa), false);
  assert.equal(assinaturaMetaConfere('segredo-do-app', Buffer.from('{"object":"x"}'), certa), false, 'corpo alterado');
  assert.equal(assinaturaMetaConfere('segredo-do-app', corpo, ''), false);
  assert.equal(assinaturaMetaConfere('', corpo, certa), false);
});

test('envio: Meta devolve o id; fora da janela de 24 h é erro definitivo; Evolution não envia', async () => {
  const chamadas = [];
  const ok = async (url, opcoes) => { chamadas.push({ url, ...opcoes, body: JSON.parse(opcoes.body) }); return { ok: true, text: async () => '{"messages":[{"id":"wamid.OK"}]}' }; };
  assert.equal(await enviar({ whats_provedor: 'meta', whats_url: '', whats_instancia: '999', whats_token: 't' }, '5511977770001', 'oi', ok), 'wamid.OK');
  assert.match(chamadas[0].url, /graph\.facebook\.com\/v[\d.]+\/999\/messages$/);
  assert.equal(chamadas[0].headers.Authorization, 'Bearer t');
  assert.deepEqual([chamadas[0].body.to, chamadas[0].body.type, chamadas[0].body.text.body], ['5511977770001', 'text', 'oi']);
  const janela = async () => ({ ok: false, status: 400, text: async () => '{"error":{"code":131047,"message":"Re-engagement message"}}' });
  await assert.rejects(enviar({ whats_provedor: 'meta', whats_instancia: '9', whats_token: 't' }, '55', 'oi', janela), (e) => e.definitivo === true && /24 h/.test(e.message));
  await assert.rejects(enviar({ whats_provedor: 'meta', whats_instancia: '9', whats_token: '' }, '55', 'oi', ok), /token/);
  await assert.rejects(enviar({ whats_provedor: 'webhook', whats_url: 'http://x' }, '55', 'oi', async () => ({ ok: false, status: 500, text: async () => 'caiu' })), (e) => /500/.test(e.message) && !e.definitivo);
  await assert.rejects(enviar({ whats_provedor: 'evolution', whats_url: 'http://evo' }, '55', 'oi', ok), /desligado/);
});

test('coexistência: resposta pelo app cala o robô naquele contato; eco do próprio sistema é ignorado', async () => {
  const relogio = { t: Date.parse('2026-03-10T09:00:00-03:00') };
  const s = criarServico({ db: abrirBanco(':memory:'), agora: () => relogio.t });
  const enviadas = [];
  let n = 0;
  const a = criarAtendimento({ servico: s, enviar: async (c, destino, texto) => { enviadas.push({ destino, texto }); return `wamid.S${++n}`; } });
  s.salvarConfig({ whats_provedor: 'meta', whats_instancia: '123', whats_token: 'token', admin_telefone: '11988880000', robo_pausa_horas: 2 }, 'teste');
  const meta = (field, value) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field, value }] }] });
  const doCliente = (texto) => a.receber(meta('messages', { contacts: [{ wa_id: '5511977770001', profile: { name: 'Carla' } }], messages: [{ from: '5511977770001', type: 'text', text: { body: texto } }] }));
  const doApp = (id, texto) => a.receber(meta('smb_message_echoes', { message_echoes: [{ from: '5527999165959', to: '5511977770001', id, type: 'text', text: { body: texto } }] }));

  await doCliente('oi');
  assert.match(enviadas.at(-1).texto, /Pedir um motoboy/, 'sem ninguém no app, o robô atende');
  // O eco da resposta que o próprio robô mandou (mesmo id) não pausa nada.
  await doApp('wamid.S1', 'texto do robô');
  const conversa = () => s.listarConversas()[0];
  assert.equal(conversa().pausa_ate, null);

  // Luan responde pelo celular: fica registrado e o robô se cala.
  enviadas.length = 0;
  await doApp('wamid.APP1', 'Oi Carla, aqui é o Luan');
  assert.equal(enviadas.length, 0, 'eco nunca gera resposta');
  assert.equal(conversa().pausa_ate, relogio.t + 2 * 3_600_000);
  const msgs = s.mensagensDaConversa(conversa().id);
  assert.deepEqual([msgs[0].autor, msgs[0].texto, msgs[0].direcao], ['Empresa (app)', 'Oi Carla, aqui é o Luan', 'saida']);
  await doCliente('1');
  await doCliente('menu');
  assert.equal(enviadas.length, 0, 'enquanto o Luan atende pelo app, o robô não responde nem a "menu"');
  assert.equal(conversa().pendente, 0, 'não vira pendência no painel: ele já está atendendo');

  // Passou o tempo da pausa: o robô volta.
  relogio.t += 2 * 3_600_000 + 1;
  await doCliente('oi');
  assert.match(enviadas.at(-1).texto, /Pedir um motoboy/);

  // "Devolver ao robô" no painel também tira a pausa na hora.
  await doApp('wamid.APP2', 'Mais alguma coisa?');
  a.modoConversa(conversa().id, false);
  enviadas.length = 0;
  await doCliente('oi');
  assert.equal(enviadas.length, 1);
});

test('fila: erro definitivo da Meta (janela de 24 h) não é repetido', async () => {
  const relogio = { t: Date.parse('2026-03-10T09:00:00-03:00') };
  const s = criarServico({ db: abrirBanco(':memory:'), agora: () => relogio.t });
  let chamadas = 0;
  const a = criarAtendimento({ servico: s, enviar: async () => { chamadas++; throw Object.assign(new Error('Fora da janela de 24 h'), { definitivo: true }); } });
  s.salvarConfig({ whats_provedor: 'meta', whats_instancia: '1', whats_token: 't', admin_telefone: '11988880000' }, 'teste');
  s.convocar(s.criarMotoboy({ nome: 'Ana', telefone: '11999990001', pin: '123456', veiculo: 'moto' }, 'teste'), 'teste');
  await a.despacharSaida();
  relogio.t += 60 * 60_000;
  await a.despacharSaida();
  assert.equal(chamadas, 1);
  assert.match(a.resumo().whatsapp.ultimo_erro, /24 h/);
});

test('HTTP: com App Secret, o webhook só aceita aviso assinado pela Meta', async (t) => {
  const servico = criarServico({ db: abrirBanco(':memory:') });
  const enviadas = [];
  const atendimento = criarAtendimento({ servico, enviar: async (c, d, texto) => { enviadas.push(texto); return 'wamid.1'; } });
  const app = criarApp({ servico, atendimento, geocodificar: null });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  t.after(() => app.close());
  servico.salvarConfig({ whats_provedor: 'meta', whats_instancia: '1', whats_token: 't', whats_app_secret: 'segredo-do-app' }, 'teste');
  assert.equal(servico.lerConfig().whats_app_secret, undefined, 'App Secret nunca volta para o navegador');
  assert.equal(servico.lerConfig().whats_app_secret_definido, true);
  const base = `http://127.0.0.1:${app.address().port}/api/whatsapp/webhook`;
  const corpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '5511977770001', type: 'text', text: { body: 'oi' } }] } }] }] });
  const assinar = (texto) => `sha256=${crypto.createHmac('sha256', 'segredo-do-app').update(texto).digest('hex')}`;
  const segredo = servico.lerConfig().whats_segredo;
  const post = (headers) => fetch(`${base}?s=${segredo}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: corpo });
  assert.equal((await post({})).status, 403, 'segredo do endereço sozinho não basta com App Secret salvo');
  assert.equal((await post({ 'X-Hub-Signature-256': assinar(corpo + ' ') })).status, 403);
  assert.equal((await post({ 'X-Hub-Signature-256': assinar(corpo) })).status, 200);
  for (let i = 0; i < 50 && !enviadas.length; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.match(enviadas[0], /Pedir um motoboy/);
  const verificacao = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=${segredo}&hub.challenge=777`);
  assert.equal(await verificacao.text(), '777');
});

test('banco: quem estava ligado na Evolution fica desligado ao atualizar', () => {
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'speed-')), 'speed.db');
  const db = abrirBanco(arquivo);
  db.prepare("UPDATE config SET valor = 'evolution' WHERE chave = 'whats_provedor'").run();
  db.close();
  const db2 = abrirBanco(arquivo);
  assert.equal(db2.prepare("SELECT valor FROM config WHERE chave = 'whats_provedor'").get().valor, '');
  const s2 = criarServico({ db: db2 });
  assert.throws(() => s2.salvarConfig({ whats_provedor: 'evolution' }, 'teste'), { codigo: 'config_invalida' });
  db2.close();
});

test('robô: conversa completa vira pedido, despacha e avisa cliente a cada etapa', async () => {
  const { s, cliente, motoboyEmTurno, demandas, enviadas, a } = montar();
  const { token } = motoboyEmTurno();
  assert.match(await cliente('oi'), /Olá, Carla![\s\S]*1\* - Pedir um motoboy/);
  assert.match(await cliente('1'), /endereço de \*COLETA\*/);
  assert.match(await cliente('Rua da Coleta, 10, Centro'), /Achei no mapa[\s\S]*Está certo/);
  assert.match(await cliente('sim'), /endereço de \*ENTREGA\*/);
  assert.match(await cliente('Rua Que Nao Existe 999'), /Não achei esse endereço/);
  assert.match(await cliente('Rua da Entrega, 20, Centro'), /Achei no mapa/);
  assert.match(await cliente('1'), /Que tipo de serviço[\s\S]*1\* - Entrega de documento[\s\S]*3\* - Cartório/);
  assert.match(await cliente('9'), /Que tipo de serviço/, 'opção que não existe repete a lista');
  assert.match(await cliente('3'), /Descreva o que precisa/);
  const resumo = await cliente('Caixa grande, precisa de baú. Entregar para João');
  assert.match(resumo, /Confira o pedido[\s\S]*Rua da Coleta[\s\S]*Rua da Entrega[\s\S]*Cartório ou protocolo[\s\S]*R\$\s12,00/);
  assert.equal(demandas().length, 0, 'nada criado antes de confirmar');

  const fim = await cliente('1');
  assert.match(fim, /Pedido #1 confirmado[\s\S]*https:\/\/speed\.exemplo\/acompanhar\/\?c=/);
  const [d] = demandas();
  assert.equal(d.origem, 'robo');
  assert.equal(d.cliente, 'Carla Souza');
  assert.equal(d.cliente_telefone, '11977770001');
  assert.equal(d.requisito, 'bau');
  assert.equal(d.urgente, 1);
  assert.equal(d.servico, 'Cartório ou protocolo');
  assert.equal(d.repasse, 15, '60% de R$ 12 daria R$ 7,20: vale o mínimo de R$ 15');
  assert.equal(d.valor, 12, '8 de base + 2 km a mais x R$ 2 (3 km x 1,35 = 4,1 km)');
  assert.equal(d.status, 'aguardando', 'a motoboy em turno não tem baú');

  // Admin escolhe a motoboy mesmo sem baú: cliente recebe o aviso com o link.
  enviadas.length = 0;
  s.reatribuir(d.id, s.estadoAdmin().motoboys[0].id, 'teste');
  await a.despacharSaida();
  assert.match(enviadas.at(-1).texto, /Pedido #1: Ana está a caminho da coleta[\s\S]*acompanhar/);
  assert.equal(enviadas.at(-1).destino, '5511977770001');

  const turno = () => s.autenticarMotoboy(token);
  s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'coleta', justificativa: '' });
  s.registrarPosicoes(turno(), { pontos: [{ ...P(3), ts: Date.parse('2026-03-10T09:00:30-03:00'), precisao: 10 }] });
  s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'entrega', recebedor: 'João' });
  enviadas.length = 0;
  await a.despacharSaida();
  assert.deepEqual(enviadas.map((m) => m.texto.split(/[!.]/)[0]), ['📦 Pedido #1 coletado', '✅ Pedido #1 entregue para João às 09:00']);

  // Cliente que volta: o robô oferece o mesmo endereço de coleta.
  await cliente('oi');
  assert.match(await cliente('1'), /mesmo endereço da última vez[\s\S]*Rua da Coleta, 10, Centro/);
  assert.match(await cliente('cancelar'), /parei por aqui/);
});

test('robô: localização enviada vale como endereço e endereço não achado vira "sem local"', async () => {
  const { cliente, demandas, enviadas, a } = montar();
  await cliente('oi');
  await cliente('1');
  assert.match(await cliente('', P(1)), /endereço de \*ENTREGA\*/);
  await cliente('Travessa Sumida 5');
  assert.match(await cliente('Travessa Sumida 5, Bairro Novo'), /Anotei o endereço[\s\S]*Que tipo de serviço/);
  await cliente('1');
  await cliente('Envelope');
  assert.match(await cliente('1'), /Pedido #1 recebido/);
  assert.equal(demandas()[0].status, 'sem_local');
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /sem local no mapa/.test(m.texto)), 'responsável é avisado');
});

test('robô: atendente assume e o robô se cala até o cliente mandar "menu"', async () => {
  const { s, a, cliente, enviadas } = montar();
  await cliente('oi');
  assert.match(await cliente('quero falar com atendente'), /Chamei um atendente/);
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /pediu um atendente/.test(m.texto)));
  assert.equal(a.resumo().whatsapp.pendentes, 1);
  assert.equal(await cliente('alguém aí?'), '', 'robô não responde');

  const conversa = s.listarConversas()[0];
  assert.equal(conversa.telefone, '11977770001');
  enviadas.length = 0;
  a.responder(conversa.id, 'Oi Carla, sou o Luan.', 'admin:teste');
  await a.despacharSaida();
  assert.deepEqual(enviadas, [{ destino: '5511977770001', texto: 'Oi Carla, sou o Luan.' }]);
  assert.equal(a.resumo().whatsapp.pendentes, 0);
  const direcoes = s.mensagensDaConversa(conversa.id).map((m) => m.direcao);
  assert.ok(direcoes.includes('entrada') && direcoes.includes('saida'));
  assert.match(await cliente('menu'), /Pedir um motoboy/, 'cliente volta ao robô');
});

test('motoboy que responde no WhatsApp não aciona o robô', async () => {
  const { a, motoboyEmTurno, enviadas, limpar } = montar();
  motoboyEmTurno();
  await limpar();
  await a.receber({ telefone: '5511999990001', nome: 'Ana', texto: 'ok, indo' });
  assert.equal(enviadas.length, 0);
});

test('fila de envio: tenta de novo com espera crescente e registra o erro', async () => {
  const relogio = { t: Date.parse('2026-03-10T09:00:00-03:00') };
  const s = criarServico({ db: abrirBanco(':memory:'), agora: () => relogio.t });
  let falhar = true;
  const enviadas = [];
  const a = criarAtendimento({ servico: s, enviar: async (c, destino, texto) => { if (falhar) throw new Error('fora do ar'); enviadas.push(texto); } });
  s.salvarConfig({ whats_provedor: 'webhook', whats_url: 'http://x', admin_telefone: '11988880000' }, 'teste');
  const id = s.criarMotoboy({ nome: 'Ana', telefone: '11999990001', pin: '123456', veiculo: 'moto' }, 'teste');
  s.convocar(id, 'teste');
  assert.equal(await a.despacharSaida(), 0);
  assert.equal(a.resumo().whatsapp.ultimo_erro, 'fora do ar');
  falhar = false;
  assert.equal(await a.despacharSaida(), 0, 'ainda dentro da espera');
  relogio.t += MIN;
  assert.equal(await a.despacharSaida(), 1);
  assert.match(enviadas[0], /Olá, Ana! A SpeedBoy convocou você/);
});

test('site: pedido fica retido até o admin aprovar', async () => {
  const { s, a, motoboyEmTurno, demandas, enviadas, aceitar, estadoDe } = montar();
  const { token } = motoboyEmTurno();
  const cotacao = await a.cotarPublico({ coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Rua da Entrega, 20, Centro' } }, 'ip');
  assert.equal(cotacao.valor, 12);
  assert.equal(cotacao.coleta.lat, P(0).lat);
  const pedido = { nome: 'Bruno', telefone: '(11) 96666-0002', descricao: 'Envelope', coleta: cotacao.coleta, entrega: cotacao.entrega };
  await assert.rejects(a.pedidoSite({ ...pedido, site: 'http://spam' }, 'ip'), { codigo: 'invalido' });
  await assert.rejects(a.pedidoSite({ ...pedido, telefone: '123' }, 'ip'), { codigo: 'telefone_invalido' });

  const r = await a.pedidoSite(pedido, 'ip');
  assert.equal(r.confirmacao, 'painel');
  assert.equal(demandas()[0].status, 'aguardando');
  assert.equal(demandas()[0].retida, 1);
  assert.deepEqual(s.estadoAdmin().sugestoes, []);
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => /chegou pelo site e espera sua aprovação[\s\S]*📦 Coleta: [\s\S]*🏁 Entrega: /.test(m.texto)), 'aviso leva coleta e entrega');

  const publico = s.pedidoPublico(r.codigo);
  assert.equal(publico.retida, true);
  assert.equal(publico.motoboy, null);
  assert.throws(() => s.pedidoPublico('codigo-errado'), { codigo: 'nao_encontrado' });

  assert.equal(estadoDe(token).ofertas.length, 0, 'retido não é oferecido');
  s.liberarDemanda(r.id, 'admin:teste');
  assert.equal(demandas()[0].status, 'aguardando', 'urgente espera alguém aceitar');
  assert.equal(demandas()[0].ofertas, 1);
  aceitar(token);
  assert.equal(demandas()[0].status, 'atribuida');
  const depois = s.pedidoPublico(r.codigo);
  assert.equal(depois.motoboy.nome, 'Ana');
  assert.equal(depois.motoboy.lat, null, 'posição só aparece com rastreio_cliente ligado');
  s.salvarConfig({ rastreio_cliente: '1' }, 'teste');
  assert.equal(s.pedidoPublico(r.codigo).motoboy.lat, P(0).lat);
  assert.equal(s.pedidoPublico(r.codigo).paradas_antes, 0);
});

test('site: cliente confirma pelo WhatsApp; sem resposta o pedido é cancelado', async () => {
  const { a, relogio, motoboyEmTurno, demandas, enviadas, limpar, aceitar } = montar({ site_confirmacao: 'whatsapp' });
  const { token } = motoboyEmTurno();
  const pedido = (telefone) => ({
    nome: 'Carla Souza', telefone, descricao: 'Envelope',
    coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Rua da Entrega, 20, Centro' },
  });
  await limpar();
  const r = await a.pedidoSite(pedido('11977770001'), 'ip');
  assert.equal(r.confirmacao, 'whatsapp');
  await a.despacharSaida();
  assert.match(enviadas[0].texto, /Recebemos um pedido no site[\s\S]*Foi você/);
  assert.equal(demandas()[0].status, 'aguardando');

  enviadas.length = 0;
  await a.receber({ telefone: '5511977770001', nome: 'Carla Souza', texto: '1' });
  assert.ok(enviadas.some((m) => m.destino === '5511977770001' && /Pedido #1 confirmado/.test(m.texto)));
  aceitar(token);
  assert.equal(demandas()[0].status, 'atribuida');

  const outro = await a.pedidoSite(pedido('11955550003'), 'ip');
  relogio.t += 61 * MIN;
  a.rotina();
  assert.equal(demandas().find((d) => d.id === outro.id).status, 'cancelada');
  enviadas.length = 0;
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => /cancelado por falta de confirmação/.test(m.texto)));
});

test('horário de atendimento fecha o site e o robô', async () => {
  const { s, a, cliente } = montar({ atendimento_inicio: '10:00', atendimento_fim: '18:00' });
  assert.equal(s.foraDoHorario(), '10:00 às 18:00');
  await cliente('oi');
  assert.match(await cliente('1'), /estamos fechados[\s\S]*10:00 às 18:00/);
  await assert.rejects(a.pedidoSite({ nome: 'Bruno', telefone: '11966660002', coleta: { endereco: 'Rua A, 1' }, entrega: { endereco: 'Rua B, 2' } }, 'ip'), { codigo: 'recusado' });
});

test('convocação automática respeita espera, rodízio e limite do dia', async () => {
  const { s, a, relogio, enviadas } = montar({ convocacao_auto: '1', convocacao_auto_max: 1, convocacao_auto_espera_min: 3 });
  s.criarMotoboy({ nome: 'Ana', telefone: '11999990001', pin: '123456', veiculo: 'moto' }, 'teste');
  s.criarMotoboy({ nome: 'Beto', telefone: '11999990002', pin: '123456', veiculo: 'moto' }, 'teste');
  s.criarDemanda({ cliente: 'Loja', coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(2) } }, 'teste');
  s.rotina();
  assert.ok(s.estadoAdmin().motoboys.every((m) => !m.convocado_ate), 'ainda dentro da espera');
  relogio.t += 4 * MIN;
  s.rotina();
  s.rotina();
  assert.equal(s.estadoAdmin().motoboys.filter((m) => m.convocado_ate).length, 1);
  enviadas.length = 0;
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => m.destino === '5511999990001' && /convocou você/.test(m.texto)));
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /Convocação automática: Ana/.test(m.texto)));
});

test('relatório por cliente soma entregas e valores', async () => {
  const { s, motoboyEmTurno, relogio } = montar();
  const { token } = motoboyEmTurno();
  const d = s.criarDemanda({ cliente: 'Loja X', coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(0.05) } }, 'teste');
  s.confirmarParada(s.autenticarMotoboy(token), { demanda_id: d.id, tipo: 'coleta' });
  s.confirmarParada(s.autenticarMotoboy(token), { demanda_id: d.id, tipo: 'entrega', recebedor: 'Zé' });
  assert.deepEqual(s.relatorioClientes(relogio.t - MIN, relogio.t + MIN), [{ cliente: 'Loja X', telefone: '', entregas: 1, km: 0.1, valor: 8 }]);
});

test('banco antigo (sem as colunas novas) é atualizado sem perder dados', () => {
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'speed-')), 'speed.db');
  const antigo = new DatabaseSync(arquivo);
  antigo.exec(`
    CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    INSERT INTO config VALUES ('cidade_base', 'Campinas, SP');
    CREATE TABLE motoboys (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL,
      veiculo TEXT NOT NULL, tem_bau INTEGER NOT NULL DEFAULT 0, tem_bag INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, criado_em INTEGER NOT NULL);
    CREATE TABLE convocacoes (id INTEGER PRIMARY KEY, motoboy_id INTEGER NOT NULL, criada_em INTEGER NOT NULL, valida_ate INTEGER NOT NULL, usada_em INTEGER, cancelada_em INTEGER);
    CREATE TABLE demandas (id INTEGER PRIMARY KEY, cliente TEXT NOT NULL, descricao TEXT NOT NULL DEFAULT '', requisito TEXT NOT NULL DEFAULT 'qualquer',
      origem TEXT NOT NULL DEFAULT 'painel', coleta_endereco TEXT NOT NULL, coleta_lat REAL, coleta_lon REAL, coleta_contato TEXT NOT NULL DEFAULT '',
      entrega_endereco TEXT NOT NULL, entrega_lat REAL, entrega_lon REAL, entrega_contato TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      motoboy_id INTEGER, turno_id INTEGER, ordem_coleta INTEGER NOT NULL DEFAULT 0, ordem_entrega INTEGER NOT NULL DEFAULT 0, criada_em INTEGER NOT NULL,
      atribuida_em INTEGER, coletada_em INTEGER, entregue_em INTEGER, cancelada_em INTEGER, coleta_dist_m INTEGER, entrega_dist_m INTEGER,
      coleta_justificativa TEXT, entrega_justificativa TEXT, recebedor TEXT);
    INSERT INTO demandas (cliente, coleta_endereco, entrega_endereco, status, criada_em) VALUES ('Antiga', 'Rua A', 'Rua B', 'entregue', 1);
    CREATE TABLE conversas (id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, criada_em INTEGER NOT NULL, atualizada_em INTEGER NOT NULL);
    CREATE TABLE mensagens (id INTEGER PRIMARY KEY, conversa_id INTEGER NOT NULL, ts INTEGER NOT NULL, autor TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL,
      demanda_id INTEGER, UNIQUE (conversa_id, ts, autor, texto));
  `);
  antigo.close();
  for (let i = 0; i < 2; i++) { // abrir duas vezes: a atualização não pode repetir nem quebrar
    const db = abrirBanco(arquivo);
    const s = criarServico({ db });
    assert.equal(s.cidadeBase(), 'Campinas, SP');
    const [d] = db.prepare('SELECT * FROM demandas').all();
    assert.equal(d.cliente, 'Antiga');
    assert.equal(d.retida, 0);
    assert.equal(d.codigo, null);
    assert.equal(s.lerConfig().site_confirmacao, 'painel');
    db.close();
  }
});

test('HTTP: páginas públicas, webhook com segredo e segredos fora da resposta', async (t) => {
  const db = abrirBanco(':memory:');
  const servico = criarServico({ db });
  servico.garantirAdmin('admin', 'senha-de-teste-123');
  const enviadas = [];
  const atendimento = criarAtendimento({ servico, enviar: async (c, destino, texto) => { enviadas.push(texto); } });
  const app = criarApp({ servico, atendimento, geocodificar: null });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const json = (corpo) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });

  for (const pagina of ['/pedir/', '/acompanhar/', '/site/base.js', '/site/site.css']) {
    assert.equal((await fetch(base + pagina)).status, 200, pagina);
  }
  assert.equal((await fetch(`${base}/pedir`, { redirect: 'manual' })).headers.get('location'), '/pedir/');
  assert.equal((await (await fetch(`${base}/api/publico/info`)).json()).empresa, 'SpeedBoy');
  assert.equal((await fetch(`${base}/api/publico/pedido?c=nao-existe-123`)).status, 404);

  // Site da empresa chama as rotas públicas direto do navegador; outros sites e o painel não.
  const pre = await fetch(`${base}/api/publico/pedidos`, { method: 'OPTIONS', headers: { Origin: 'https://www.speedboy.com.br', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://www.speedboy.com.br');
  assert.equal((await fetch(`${base}/api/publico/info`, { headers: { Origin: 'https://golpe.example' } })).headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${base}/api/admin/estado`, { headers: { Origin: 'https://www.speedboy.com.br' } })).headers.get('access-control-allow-origin'), null);

  const login = await fetch(`${base}/api/admin/login`, json({ usuario: 'admin', senha: 'senha-de-teste-123' }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = (metodo, caminho, corpo) => fetch(base + caminho, {
    method: metodo, headers: { Cookie: cookie, 'X-Speed': '1', 'Content-Type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined,
  });
  assert.equal((await admin('PUT', '/api/admin/config', { whats_provedor: 'webhook', whats_url: 'http://x', whats_token: 'segredo-do-provedor' })).status, 200);
  const cfg = await (await admin('GET', '/api/admin/config')).json();
  assert.equal(cfg.whats_token, undefined, 'a chave do provedor nunca volta para o navegador');
  assert.equal(cfg.whats_token_definido, true);
  assert.equal(cfg.url_publica, base, 'endereço aprendido no primeiro login');
  assert.ok(cfg.whats_segredo.length >= 20);

  assert.equal((await fetch(`${base}/api/whatsapp/webhook?s=errado`, json({ telefone: '5511977770001', texto: 'oi' }))).status, 403);
  assert.equal((await fetch(`${base}/api/whatsapp/webhook?s=${cfg.whats_segredo}`, json({ telefone: '5511977770001', nome: 'Carla', texto: 'oi' }))).status, 200);
  for (let i = 0; i < 50 && !enviadas.length; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.match(enviadas[0], /Pedir um motoboy/);
  const verificacao = await fetch(`${base}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${cfg.whats_segredo}&hub.challenge=4242`);
  assert.equal(await verificacao.text(), '4242');

  const pedido = await fetch(`${base}/api/publico/pedidos`, json({
    nome: 'Bruno', telefone: '11966660002', descricao: 'Envelope',
    coleta: { endereco: 'Rua A, 100', ...P(0) }, entrega: { endereco: 'Rua B, 200', ...P(2) },
  }));
  assert.equal(pedido.status, 200);
  const { id, codigo } = await pedido.json();
  const estado = await (await admin('GET', '/api/admin/estado')).json();
  assert.equal(estado.demandas[0].retida, 1);
  assert.equal(estado.whatsapp.ligado, true);
  assert.ok(estado.pendencias.length > 0);
  assert.equal((await admin('POST', `/api/admin/demandas/${id}/liberar`, {})).status, 200);
  const publico = await (await fetch(`${base}/api/publico/pedido?c=${codigo}`)).json();
  assert.equal(publico.retida, false);
  assert.equal(publico.coleta.endereco, 'Rua A, 100');
});

test('avulso: entra sem convocação, vê a oferta com o repasse, aceita, recebe e encerra quando quiser', async () => {
  const { s, a, relogio, cliente, motoboyEmTurno, demandas, enviadas, estadoDe, aceitar } = montar({ preco_base: 20, preco_km_incluso: 0, preco_km: 5 });
  assert.throws(() => s.convocar(s.criarMotoboy({ nome: 'Zeca', telefone: '11999990009', pin: '123456', veiculo: 'moto', tipo: 'avulso' }, 'teste'), 'teste'), { codigo: 'avulso' });
  const { token } = motoboyEmTurno({ nome: 'Beto Reis', telefone: '11999990002', tipo: 'avulso' });
  assert.equal(estadoDe(token).motoboy.tipo, 'avulso');
  assert.equal(estadoDe(token).pode_encerrar, true);

  for (const texto of ['oi', '1', 'Rua da Coleta, 10, Centro', '1', 'Rua da Entrega, 20, Centro', '1', '1', 'Envelope', '1']) await cliente(texto);
  const [d] = demandas();
  assert.equal(d.valor, 40, 'R$ 20 + 4 km x R$ 5');
  assert.equal(d.repasse, 24, '60% do valor');
  assert.equal(d.status, 'aguardando');
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => m.destino === '5511999990002' && /Entrega disponível \(R\$\s24,00 para você\)/.test(m.texto)));

  const [oferta] = estadoDe(token).ofertas;
  assert.equal(oferta.repasse, 24);
  assert.equal(oferta.coleta_endereco, 'Rua da Coleta, 10, Centro');
  const posicao = s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...P(0), ts: relogio.t + 1000, precisao: 10 }] });
  assert.equal(posicao.pendentes, 1, 'a oferta conta como pendência: o app nativo avisa o motoboy');

  aceitar(token);
  assert.equal(demandas()[0].status, 'atribuida');
  assert.equal(estadoDe(token).rota[0].repasse, 24);
  assert.throws(() => s.encerrarPeloMotoboy(s.autenticarMotoboy(token)), { codigo: 'com_demanda' });
  s.confirmarParada(s.autenticarMotoboy(token), { demanda_id: d.id, tipo: 'coleta' });
  s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...P(3), ts: relogio.t + 2000, precisao: 10 }] });
  s.confirmarParada(s.autenticarMotoboy(token), { demanda_id: d.id, tipo: 'entrega', recebedor: 'João' });
  assert.deepEqual(estadoDe(token).ganhos.total, 24);
  assert.equal(estadoDe(token).ganhos.entregas[0].id, d.id);

  const [linha] = s.relatorio(relogio.t - MIN, relogio.t + MIN);
  assert.deepEqual([linha.diarias, linha.repasses, linha.valor], [0, 24, 24], 'avulso recebe por entrega, não diária');
  const [entrega] = s.relatorioEntregas(relogio.t - MIN, relogio.t + MIN);
  assert.deepEqual([entrega.valor, entrega.repasse, entrega.margem, entrega.motoboy], [40, 24, 16, 'Beto Reis']);

  s.encerrarPeloMotoboy(s.autenticarMotoboy(token));
  assert.throws(() => s.autenticarMotoboy(token), { codigo: 'turno_encerrado' });
});

test('oferta: só para quem está perto, o primeiro que aceita leva, recusa some e o raio cresce com a espera', async () => {
  const { s, relogio, motoboyEmTurno, demandas, estadoDe, aceitar, enviadas, a } = montar();
  const perto = motoboyEmTurno({ nome: 'Ana', telefone: '11999990001', tipo: 'avulso' }, 1);
  const tambem = motoboyEmTurno({ nome: 'Beto', telefone: '11999990002' }, 2); // diária também vê urgente
  const longe = motoboyEmTurno({ nome: 'Caio', telefone: '11999990003', tipo: 'avulso' }, 9); // 9 km x 1,35 = fora do raio de 5 km
  const pedido = () => s.criarPedido({ cliente: 'Loja', urgente: true, coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(3) } }, 'site');

  const d1 = pedido();
  assert.deepEqual([perto, tambem, longe].map((m) => estadoDe(m.token).ofertas.length), [1, 1, 0]);
  assert.equal(estadoDe(tambem.token).ofertas[0].repasse, null, 'diária não vê repasse');
  aceitar(tambem.token);
  assert.equal(demandas().find((d) => d.id === d1.id).motoboy_id, tambem.id);
  assert.equal(estadoDe(perto.token).ofertas.length, 0, 'a oferta some para os outros');
  assert.throws(() => s.responderOferta(s.autenticarMotoboy(perto.token), { oferta_id: 1, acao: 'aceitar' }), { codigo: 'oferta_encerrada' });

  const d2 = pedido();
  s.responderOferta(s.autenticarMotoboy(perto.token), { oferta_id: estadoDe(perto.token).ofertas[0].id, acao: 'recusar' });
  s.despacharPendentes();
  assert.equal(estadoDe(perto.token).ofertas.length, 0, 'quem recusou não recebe de novo');

  // Ninguém aceitou: o raio dobra a cada 1,5 min, o motoboy longe passa a ver e o responsável é avisado.
  for (let i = 0; i < 4; i++) {
    relogio.t += 1.5 * MIN;
    for (const m of [perto, tambem, longe]) s.registrarPosicoes(s.autenticarMotoboy(m.token), { pontos: [], gps_ligado: true });
    s.despacharPendentes();
  }
  assert.equal(estadoDe(longe.token).ofertas[0].demanda_id, d2.id);
  enviadas.length = 0;
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /sem motoboy aceitar/.test(m.texto)));
});

test('demanda comum continua indo direto para a diária; sem diária, é oferecida ao avulso', () => {
  const { s, motoboyEmTurno, demandas, estadoDe } = montar();
  const avulso = motoboyEmTurno({ nome: 'Ana', telefone: '11999990001', tipo: 'avulso' });
  const comum = () => s.criarDemanda({ cliente: 'Loja', coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(2) } }, 'teste');
  const d1 = comum();
  assert.equal(demandas().find((d) => d.id === d1.id).status, 'aguardando');
  assert.equal(estadoDe(avulso.token).ofertas.length, 1);
  const diaria = motoboyEmTurno({ nome: 'Beto', telefone: '11999990002' });
  assert.equal(demandas().find((d) => d.id === d1.id).motoboy_id, diaria.id, 'entrou diária: recebe direto');
  assert.equal(estadoDe(avulso.token).ofertas.length, 0);
});

test('tipo de serviço soma no preço e pode ter repasse próprio', () => {
  const { s } = montar();
  const cartorio = s.listarServicos().find((x) => x.nome === 'Cartório ou protocolo');
  s.salvarServico({ id: cartorio.id, nome: cartorio.nome, adicional: 30, repasse_pct: 70 }, 'teste');
  const cot = s.cotar(P(0), P(3), { servicoId: cartorio.id });
  assert.equal(cot.valor, 42, 'R$ 12 da distância + R$ 30 do cartório');
  assert.equal(cot.repasse, 29.4, '70% para o motoboy');
  assert.equal(s.cotar(P(0), P(3), { km: 10 }).valor, 24, 'km pelas ruas, quando informado, vale mais que a linha reta');
  assert.throws(() => s.salvarServico({ nome: 'X' }, 'teste'), { codigo: 'servico_invalido' });
});

test('Pix: pedido só é liberado depois de pago; vencido sem pagar é cancelado', async () => {
  const { s, a, relogio, banco, motoboyEmTurno, demandas, estadoDe, enviadas, limpar } = montar({ site_confirmacao: 'pagamento', mp_token: 'TOKEN-SECRETO' });
  const { token } = motoboyEmTurno({ tipo: 'avulso' });
  const pedido = (telefone, extra = {}) => a.pedidoSite({
    nome: 'Bruno', telefone, email: 'bruno@exemplo.com', descricao: 'Envelope', servico_id: 1,
    coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Rua da Entrega, 20, Centro' }, ...extra,
  }, 'ip');
  assert.equal(a.infoPublica().pagamento, true);
  await assert.rejects(pedido('11966660002', { email: 'sem-arroba' }), { codigo: 'email_invalido' });

  await limpar();
  const r = await pedido('11966660002');
  assert.equal(r.confirmacao, 'pagamento');
  assert.equal(r.pix.codigo, `PIX-${r.codigo}`);
  assert.deepEqual([banco.cobrancas[0].valor, banco.cobrancas[0].email, banco.cobrancas[0].token], [12, 'bruno@exemplo.com', 'TOKEN-SECRETO']);
  assert.equal(banco.cobrancas[0].avisoUrl.startsWith('https://speed.exemplo/api/pagamento/mp?s='), true);
  assert.equal(estadoDe(token).ofertas.length, 0, 'sem pagar, nenhum motoboy vê');
  let publico = await a.pedidoVivo(r.codigo);
  assert.deepEqual([publico.pagamento, publico.pix.codigo, publico.pix.qr], ['pendente', r.pix.codigo, 'QUJD']);
  assert.equal(s.estadoAdmin().demandas[0].pag_pix, undefined, 'código do Pix não vai para a lista do painel');

  banco.pagos.add('mp1');
  await a.webhookPagamento({ type: 'payment', data: { id: 'mp1' } }, new URL('http://x/'));
  publico = await a.pedidoVivo(r.codigo);
  assert.deepEqual([publico.pagamento, publico.pix, publico.retida], ['pago', null, false]);
  assert.equal(estadoDe(token).ofertas.length, 1, 'pago: oferecido aos motoboys');
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => /Pagamento do pedido #1 confirmado/.test(m.texto)));

  // Aviso falso (pagamento que o banco não confirma) não libera nada.
  const r2 = await pedido('11955550003');
  await a.webhookPagamento({ data: { id: 'mp2' } }, new URL('http://x/'));
  assert.equal(demandas().find((d) => d.id === r2.id).pagamento, 'pendente');
  relogio.t += 31 * MIN;
  await a.expirarPagamentos();
  assert.equal(demandas().find((d) => d.id === r2.id).status, 'cancelada');

  // Pago que precisa ser cancelado: o responsável é avisado para devolver.
  enviadas.length = 0;
  s.cancelarDemanda(r.id, 'admin:teste');
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /Devolva o Pix de R\$\s12,00/.test(m.texto)));

  // Mercado Pago fora do ar: o pedido não se perde, fica para aprovação.
  banco.falhar = true;
  assert.equal((await pedido('11944440004')).confirmacao, 'painel');
});

test('Pix pelo robô: pede e-mail uma vez, manda o copia e cola e libera quando pagar', async () => {
  const { a, banco, cliente, demandas } = montar({ site_confirmacao: 'pagamento', mp_token: 'TOKEN' });
  for (const texto of ['oi', '1', 'Rua da Coleta, 10, Centro', '1', 'Rua da Entrega, 20, Centro', '1', '1', 'Envelope']) await cliente(texto);
  assert.match(await cliente('1'), /me diga seu \*e-mail\*/);
  assert.match(await cliente('nao sei'), /Não entendi o e-mail/);
  const fim = await cliente('Carla@Exemplo.com');
  assert.match(fim, /Pedido #1 reservado[\s\S]*R\$\s12,00[\s\S]*PIX-[\s\S]*aviso por aqui/);
  assert.deepEqual([demandas()[0].retida, demandas()[0].pagamento, banco.cobrancas[0].email], [1, 'pendente', 'carla@exemplo.com']);
  banco.pagos.add('mp1');
  await a.pedidoVivo(demandas()[0].codigo);
  assert.equal(demandas()[0].pagamento, 'pago');
  // Segundo pedido: e-mail já conhecido, vai direto ao Pix.
  for (const texto of ['oi', '1', '1', 'Rua da Entrega, 20, Centro', '1', '1', 'Outro envelope']) await cliente(texto);
  assert.match(await cliente('1'), /Pedido #2 reservado/);
});

test('cliente fixo: preço próprio, vai para a fatura e confirma pelo WhatsApp em vez de pagar', async () => {
  const { s, a, demandas, enviadas, limpar } = montar({ site_confirmacao: 'pagamento', mp_token: 'TOKEN' });
  s.salvarCliente({ telefone: '(11) 97777-0001', nome: 'Clínica Vida', faturado: true, preco_pct: 80 }, 'teste');
  await limpar();
  const r = await a.pedidoSite({
    nome: 'Recepção', telefone: '11977770001', descricao: 'Exames',
    coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Rua da Entrega, 20, Centro' },
  }, 'ip');
  assert.deepEqual([r.confirmacao, r.pix, r.valor], ['whatsapp', null, 9.6]);
  const [d] = demandas();
  assert.deepEqual([d.cliente, d.pagamento, d.retida], ['Clínica Vida', 'faturado', 1]);
  await a.receber({ telefone: '5511977770001', nome: 'Recepção', texto: '1' });
  assert.equal(demandas()[0].retida, 0);
  assert.ok(enviadas.some((m) => /Pedido #1 confirmado/.test(m.texto)));
});

test('Pix: pedido que entrou sem local só é cobrado depois que o admin marca o ponto', async () => {
  const { s, a, banco, demandas, enviadas, limpar, motoboyEmTurno, estadoDe } = montar({ site_confirmacao: 'pagamento', mp_token: 'TOKEN' });
  const { token } = motoboyEmTurno({ tipo: 'avulso' });
  const dados = { nome: 'Bruno', telefone: '11966660002', descricao: 'Envelope', coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Beco Sem Mapa, 7' } };
  await assert.rejects(a.pedidoSite(dados, 'ip'), { codigo: 'email_invalido' });
  const r = await a.pedidoSite({ ...dados, email: 'bruno@exemplo.com' }, 'ip');
  assert.deepEqual([r.confirmacao, r.pix, r.status], ['painel', null, 'sem_local']);
  await limpar();

  s.definirLocais(r.id, { entrega: { endereco: 'Beco Sem Mapa, 7', ...P(3) } }, 'admin:teste');
  await new Promise((ok) => setImmediate(ok));
  const [d] = demandas();
  assert.deepEqual([d.status, d.retida, d.pagamento, d.valor], ['aguardando', 1, 'pendente', 12]);
  assert.equal(estadoDe(token).ofertas.length, 0);
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => /Pedido #1 conferido[\s\S]*R\$\s12,00/.test(m.texto)));
  assert.ok(enviadas.some((m) => m.texto === `PIX-${r.codigo}`));
  banco.pagos.add('mp1');
  await a.pedidoVivo(r.codigo);
  assert.equal(estadoDe(token).ofertas.length, 1);
});

test('Pix copia e cola: código no padrão do Banco Central e chave conferida pelo tipo', () => {
  // Exemplo do manual do BR Code (Banco Central): o CRC esperado é 1D3D.
  assert.equal(crc16('00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304'), '1D3D');
  const codigo = brCode({ chave: '46178859000196', nome: 'SpeedBoy Motoboy Ltda. Serviços', cidade: 'Vila Velha', valor: 46.25, txid: 'PEDIDO12' });
  assert.match(codigo, /^000201/);
  assert.ok(codigo.includes('0014br.gov.bcb.pix011446178859000196'));
  assert.ok(codigo.includes('540546.25'), 'valor com ponto e duas casas');
  assert.ok(codigo.includes('5925SpeedBoy Motoboy Ltda. Se60'), 'nome sem acento e cortado em 25 letras');
  assert.ok(codigo.includes('0508PEDIDO12'));
  assert.equal(codigo.slice(-4), crc16(codigo.slice(0, -4)));
  assert.equal(normalizarChave('cnpj', '46.178.859/0001-96'), '46178859000196');
  assert.equal(normalizarChave('telefone', '(27) 99916-5959'), '+5527999165959');
  assert.equal(normalizarChave('email', ' Financeiro@Speed.com.br '), 'financeiro@speed.com.br');
  assert.equal(normalizarChave('cpf', '123'), '');
  assert.equal(normalizarChave('aleatoria', '123E4567-e12b-12d1-a456-426655440000'), '123e4567-e12b-12d1-a456-426655440000');
});

test('Pix na chave da empresa: cliente manda o comprovante e o responsável libera com "pago 1"', async () => {
  const { s, a, relogio, cliente, motoboyEmTurno, demandas, enviadas, limpar, estadoDe } = montar({
    site_confirmacao: 'pix', pix_tipo: 'cnpj', pix_chave: '46.178.859/0001-96', pix_nome: 'SpeedBoy Motoboy', pix_cidade: 'Vila Velha', empresa_whatsapp: '27999165959',
  });
  assert.throws(() => s.salvarConfig({ pix_tipo: 'cpf', pix_chave: '46.178.859/0001-96' }, 'teste'), { codigo: 'config_invalida' });
  const { token } = motoboyEmTurno({ tipo: 'avulso' });
  assert.deepEqual([a.infoPublica().pagamento, a.infoPublica().pede_email], [true, false], 'Pix próprio não precisa de e-mail');

  for (const texto of ['oi', '1', 'Rua da Coleta, 10, Centro', '1', 'Rua da Entrega, 20, Centro', '1', '1', 'Envelope']) await cliente(texto);
  const fim = await cliente('1');
  assert.match(fim, /Pedido #1 reservado[\s\S]*R\$\s12,00[\s\S]*000201[\s\S]*envie o comprovante aqui/);
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /esperando Pix de R\$\s12,00[\s\S]*pago 1/.test(m.texto)));
  const publico = s.pedidoPublico(demandas()[0].codigo);
  assert.deepEqual([publico.pix.manual, publico.pix.whatsapp, publico.pix.qr], [true, '27999165959', '']);
  assert.match(publico.pix.codigo, /0014br\.gov\.bcb\.pix011446178859000196[\s\S]*540512\.00[\s\S]*0507PEDIDO1/);
  assert.equal(estadoDe(token).ofertas.length, 0);

  // Vencido: Pix manual não cancela sozinho (o sistema não vê a conta); só lembra o responsável.
  relogio.t += 31 * MIN;
  await limpar();
  await a.expirarPagamentos();
  await a.expirarPagamentos();
  assert.equal(demandas()[0].status, 'aguardando');
  await a.despacharSaida();
  assert.equal(enviadas.filter((m) => /ainda sem confirmação do Pix/.test(m.texto)).length, 1);

  // Comprovante: foto sem texto.
  enviadas.length = 0;
  await a.receber({ telefone: '5511977770001', nome: 'Carla Souza', texto: '' });
  assert.ok(enviadas.some((m) => m.destino === '5511977770001' && /conferindo o pagamento do pedido #1/.test(m.texto)));
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /enviou o comprovante do pedido #1/.test(m.texto)));
  assert.equal(s.pedidoPublico(demandas()[0].codigo).pix.comprovante, true);

  // Só o número do responsável libera.
  await a.receber({ telefone: '5511977770001', nome: 'Carla Souza', texto: 'pago 1' });
  assert.equal(demandas()[0].pagamento, 'pendente');
  enviadas.length = 0;
  s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...P(0), ts: relogio.t, precisao: 10 }], gps_ligado: true });
  await a.receber({ telefone: '5511988880000', nome: 'Luan', texto: 'Pago #1' });
  assert.equal(demandas()[0].pagamento, 'pago');
  assert.equal(estadoDe(token).ofertas.length, 1);
  assert.ok(enviadas.some((m) => m.destino === '5511988880000' && /Pagamento do pedido #1 confirmado/.test(m.texto)));
  await a.receber({ telefone: '5511988880000', nome: 'Luan', texto: 'cancelar 99' });
  assert.ok(enviadas.some((m) => /Não achei o pedido #99/.test(m.texto)));
});

test('IA no site: corrige o tipo de serviço antes de cobrar e segura pedido duvidoso para conferência', async () => {
  const { s, a, demandas, enviadas, iaFalsa, limpar, banco } = montar({ ia_chave: 'chave-da-ia', site_confirmacao: 'pagamento', mp_token: 'TOKEN' });
  const cartorio = s.listarServicos().find((x) => /Cartório/.test(x.nome));
  s.salvarServico({ id: cartorio.id, nome: cartorio.nome, adicional: 20 }, 'teste');
  const pedido = (extra = {}) => a.pedidoSite({
    nome: 'Bruno', telefone: '11966660002', email: 'bruno@exemplo.com', descricao: 'Reconhecer firma e entregar', servico_id: 1,
    coleta: { endereco: 'Rua da Coleta, 10, Centro' }, entrega: { endereco: 'Rua da Entrega, 20, Centro' }, ...extra,
  }, 'ip');
  assert.equal(s.lerConfig().ia_chave, undefined, 'a chave da IA nunca volta para o navegador');
  assert.equal(s.lerConfig().ia_chave_definida, true);

  // Cliente marcou "entrega", mas descreveu cartório: vê o preço certo antes de pagar.
  iaFalsa.resposta = { aprovado: true, servico_id: cartorio.id, motivos: [], resumo: 'Reconhecer firma e entregar no escritório.' };
  await assert.rejects(pedido(), (e) => e.codigo === 'servico_diferente' && e.extra.servico_id === cartorio.id && e.extra.valor === 32);
  assert.equal(demandas().length, 0);
  const enviado = iaFalsa.pedidos[0];
  assert.deepEqual(Object.keys(enviado.pedido).sort(), ['coleta', 'descricao', 'distancia_km', 'entrega', 'tipo_escolhido_id']);
  assert.ok(!JSON.stringify(enviado).includes('11966660002') && !JSON.stringify(enviado).includes('Bruno'), 'nome e telefone não vão para a IA');
  assert.equal(enviado.pedido.coleta.local_no_mapa, 'Rua da Coleta, 10, Centro (mapa)');

  const ok = await pedido({ servico_id: cartorio.id });
  assert.deepEqual([ok.confirmacao, ok.valor], ['pagamento', 32]);
  assert.deepEqual([demandas()[0].ia_ok, demandas()[0].ia_obs], [1, 'Reconhecer firma e entregar no escritório.']);

  // Pedido duvidoso: fica para a equipe e, aprovado, o cliente recebe a cobrança (não sai sem pagar).
  await limpar();
  iaFalsa.resposta = { aprovado: false, servico_id: 1, motivos: ['Entrega fora das cidades atendidas'], resumo: '' };
  const duvidoso = await pedido({ telefone: '11955550003', descricao: 'Levar caixa' });
  assert.deepEqual([duvidoso.confirmacao, duvidoso.pix], ['painel', null]);
  const d = demandas().find((x) => x.id === duvidoso.id);
  assert.deepEqual([d.retida, d.ia_ok, d.ia_obs, d.pagamento], [1, 0, 'Entrega fora das cidades atendidas', '']);
  await a.despacharSaida();
  assert.ok(enviadas.some((m) => /A IA pediu conferência do pedido #2[\s\S]*fora das cidades atendidas/.test(m.texto)));
  assert.equal(s.liberarDemanda(d.id, 'admin:teste'), 'cobrar');
  await new Promise((ok2) => setImmediate(ok2));
  assert.deepEqual([demandas().find((x) => x.id === d.id).pagamento, demandas().find((x) => x.id === d.id).retida], ['pendente', 1]);
  assert.equal(banco.cobrancas.length, 2);

  // IA fora do ar: o pedido segue as regras normais.
  iaFalsa.resposta = null;
  assert.equal((await pedido({ telefone: '11944440004' })).confirmacao, 'pagamento');
});

test('IA no robô: cliente só descreve e ela escolhe o serviço; fora do ar, o robô pergunta', async () => {
  const { cliente, demandas, iaFalsa } = montar({ ia_chave: 'chave-da-ia' });
  iaFalsa.resposta = { aprovado: true, servico_id: 3, motivos: [], resumo: 'Protocolar documento na prefeitura.' };
  for (const texto of ['oi', '1', 'Rua da Coleta, 10, Centro', '1', 'Rua da Entrega, 20, Centro']) await cliente(texto);
  assert.match(await cliente('1'), /Descreva o que precisa/, 'com IA não pergunta o tipo de serviço');
  assert.match(await cliente('Protocolar um documento na prefeitura'), /Confira o pedido[\s\S]*Cartório ou protocolo/);
  await cliente('1');
  assert.deepEqual([demandas()[0].servico, demandas()[0].ia_ok], ['Cartório ou protocolo', 1]);

  iaFalsa.resposta = null;
  for (const texto of ['oi', '1', '1', 'Rua da Entrega, 20, Centro', '1']) await cliente(texto);
  assert.match(await cliente('Levar um envelope'), /Que tipo de serviço/);
  assert.match(await cliente('1'), /Confira o pedido[\s\S]*Entrega de documento/);

  // Pedido que a IA reprova: fica retido e o cliente é avisado de que a equipe confere.
  iaFalsa.resposta = { aprovado: false, servico_id: 1, motivos: ['Descrição não dá para entender'], resumo: '' };
  await cliente('2');
  for (const texto of ['oi', '1', '1', 'Rua da Entrega, 20, Centro', '1', 'asdf qwer']) await cliente(texto);
  assert.match(await cliente('1'), /Pedido #2 recebido[\s\S]*equipe vai conferir/);
  assert.deepEqual([demandas()[0].retida, demandas()[0].ia_ok], [1, 0]);
});

test('IA: chamada à API com o modelo escolhido, saída estruturada e falha sem travar o pedido', async () => {
  const chamadas = [];
  let resposta = { stop_reason: 'end_turn', parsed_output: { aprovado: true, servico_id: 3, motivos: [], resumo: 'Levar ao cartório.' } };
  const ia = criarIA({
    criarCliente: (apiKey) => ({ beta: { messages: { parse: async (corpo) => { chamadas.push({ apiKey, ...corpo }); if (resposta instanceof Error) throw resposta; return resposta; } } } }),
  });
  const pedido = { cidades_atendidas: 'Vila Velha', tipos_de_servico: [{ id: 3, nome: 'Cartório' }], pedido: { descricao: 'x' } };
  assert.equal(await ia.conferir({ ia_chave: '' }, pedido), null, 'sem chave não chama');
  assert.deepEqual(await ia.conferir({ ia_chave: 'k', ia_modelo: 'claude-opus-5-5' }, pedido), { aprovado: true, servico_id: 3, motivos: [], resumo: 'Levar ao cartório.' });
  const c = chamadas[0];
  assert.deepEqual([c.apiKey, c.model, c.fallbacks, c.betas], ['k', 'claude-opus-5-5', 'default', ['server-side-fallback-2026-07-01']]);
  assert.equal(c.output_config.effort, 'low');
  assert.equal(c.output_config.format.type, 'json_schema');
  assert.equal(c.thinking, undefined);
  assert.deepEqual(JSON.parse(c.messages[0].content), pedido);

  await ia.conferir({ ia_chave: 'k', ia_modelo: 'claude-haiku-5-5' }, pedido);
  assert.deepEqual([chamadas[1].model, chamadas[1].fallbacks], ['claude-haiku-5-5', undefined]);

  resposta = { stop_reason: 'refusal', parsed_output: null };
  assert.equal(await ia.conferir({ ia_chave: 'k' }, pedido), null);
  assert.match(ia.ultimoErro(), /recusou/);
  resposta = new Error('caiu');
  assert.equal(await ia.conferir({ ia_chave: 'k' }, pedido), null);
  await assert.rejects(ia.conferir({ ia_chave: 'k' }, pedido, { lancar: true }), /caiu/);
});

const b64 = (dados) => Buffer.from(dados).toString('base64');
const PNG = b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]));
const SEM_PEDIDOS = { resumo: 'Nada.', resposta: '', pedidos: [], comprovante: null, alertas: [] };

test('IA lê arquivos: foto, PDF e conversa do WhatsApp viram pedidos prontos; tipo é conferido pelo conteúdo', async () => {
  const { s, a, iaFalsa } = montar({ ia_chave: 'chave-da-ia' });
  iaFalsa.analise = {
    resumo: 'Cliente pede uma entrega.', resposta: 'Há 1 pedido em aberto.', comprovante: null, alertas: ['Falta o número da rua de entrega.'],
    pedidos: [{ cliente: 'Loja X', telefone: '27 99999-0000', coleta_endereco: 'Rua A, 100', coleta_contato: 'Maria', entrega_endereco: 'Rua B', entrega_contato: '',
      descricao: '2 caixas', servico_id: 2, requisito: 'bau', observacao: 'Falta o número.' },
    { cliente: 'Outro', telefone: '', coleta_endereco: '', coleta_contato: '', entrega_endereco: '', entrega_contato: '', descricao: '', servico_id: 999, requisito: 'qualquer', observacao: '' }],
  };
  const conversa = '16/11/2026 14:32 - Maria: Preciso de um motoboy\n16/11/2026 14:33 - Maria: Coleta na Rua A, 100';
  const r = await a.analisarArquivos({
    pergunta: 'Quais pedidos estão em aberto?',
    arquivos: [
      { nome: 'print.jpg', conteudo: PNG }, // extensão errada de propósito: vale o conteúdo
      { nome: 'nota.pdf', conteudo: b64('%PDF-1.4 conteudo') },
      { nome: 'Conversa do WhatsApp com Maria.txt', conteudo: b64(conversa) },
    ],
  }, 'admin:teste');
  const enviado = iaFalsa.analises[0];
  assert.deepEqual(enviado.arquivos.map((x) => [x.tipo, x.mime]), [['imagem', 'image/png'], ['pdf', undefined], ['texto', undefined]]);
  assert.equal(enviado.arquivos[2].texto, '[16/11 14:32] Maria: Preciso de um motoboy\n[16/11 14:33] Maria: Coleta na Rua A, 100');
  assert.equal(enviado.pergunta, 'Quais pedidos estão em aberto?');
  assert.deepEqual(Object.keys(enviado.contexto).sort(), ['cidades_atendidas', 'data_de_hoje', 'empresa', 'pedidos_esperando_pagamento', 'recebedor_dos_pagamentos', 'tipos_de_servico']);
  assert.deepEqual([r.pedidos[0].servico, r.pedidos[0].requisito, r.resposta], ['Ida e volta (leva e traz)', 'bau', 'Há 1 pedido em aberto.']);
  assert.deepEqual([r.pedidos[1].servico_id, r.pedidos[1].servico], [null, ''], 'tipo de serviço inventado pela IA é descartado');

  const [guardada] = a.listarAnalises();
  assert.deepEqual([guardada.id, guardada.titulo, guardada.pedidos.length], [r.id, 'print.jpg, nota.pdf, Conversa do WhatsApp com Maria.txt', 2]);
  assert.equal(JSON.stringify(s.interno.q('SELECT * FROM analises').all()).includes(PNG), false, 'o arquivo não fica guardado');

  await assert.rejects(a.analisarArquivos({ arquivos: [] }, 'x'), { codigo: 'sem_arquivo' });
  await assert.rejects(a.analisarArquivos({ arquivos: [{ nome: 'virus.exe', conteudo: b64(Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01])) }] }, 'x'), { codigo: 'tipo_invalido' });
  await assert.rejects(a.analisarArquivos({ arquivos: Array(7).fill({ nome: 'a.png', conteudo: PNG }) }, 'x'), { codigo: 'muitos_arquivos' });
  iaFalsa.analise = null;
  await assert.rejects(a.analisarArquivos({ arquivos: [{ nome: 'a.png', conteudo: PNG }] }, 'x'), { codigo: 'ia_falhou' });
  s.salvarConfig({ ia_ativa: '0' }, 'teste');
  await assert.rejects(a.analisarArquivos({ arquivos: [{ nome: 'a.png', conteudo: PNG }] }, 'x'), { codigo: 'ia_desligada' });
});

test('IA lê conversa já importada e avisa quando só coube o final', async () => {
  const { s, a, iaFalsa } = montar({ ia_chave: 'chave-da-ia' });
  iaFalsa.analise = SEM_PEDIDOS;
  const linhas = Array.from({ length: 620 }, (_, i) => `16/11/2026 ${String(8 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} - Maria: mensagem ${i + 1}`);
  const { conversa_id: id } = s.importarWhatsapp({ arquivo: 'Conversa do WhatsApp com Maria.txt', conteudo: b64(linhas.join('\n')) }, 'teste');
  const r = await a.analisarConversa(id, '', 'admin:teste');
  assert.deepEqual(r.avisos, ['Maria: conversa longa, analisei as últimas 500 de 620 mensagens.']);
  const texto = iaFalsa.analises[0].arquivos[0].texto;
  assert.ok(texto.startsWith('[16/11 10:00] Maria: mensagem 121') && texto.endsWith('mensagem 620'));
  await assert.rejects(a.analisarConversa(999, '', 'x'), { codigo: 'nao_encontrado' });
});

test('IA confere comprovante: acha o pedido pelo valor e, no WhatsApp, manda a leitura ao responsável', async () => {
  const { a, cliente, demandas, enviadas, iaFalsa, limpar } = montar({
    ia_chave: 'chave-da-ia', site_confirmacao: 'pix', pix_tipo: 'cnpj', pix_chave: '46178859000196', pix_nome: 'SpeedBoy Motoboy',
  });
  iaFalsa.resposta = { aprovado: true, servico_id: 1, motivos: [], resumo: 'Levar envelope.' };
  for (const texto of ['oi', '1', 'Rua da Coleta, 10, Centro', '1', 'Rua da Entrega, 20, Centro', '1', 'Envelope', '1']) await cliente(texto);
  assert.equal(demandas()[0].pagamento, 'pendente');

  iaFalsa.analise = {
    resumo: 'Comprovante de Pix.', resposta: '', pedidos: [], alertas: [],
    comprovante: { valor: 12, recebedor: 'SPEEDBOY MOTOBOY', pagador: 'Carla Souza', data_hora: '16/11/2026 21:58', identificador: 'E123', confere_recebedor: true },
  };
  // Pelo painel: aponta qual pedido esperando Pix tem esse valor.
  const r = await a.analisarArquivos({ arquivos: [{ nome: 'comprovante.png', conteudo: PNG }] }, 'admin:teste');
  assert.deepEqual(r.comprovante.pedidos_compativeis, [1]);
  assert.deepEqual(JSON.parse(JSON.stringify(iaFalsa.analises[0].contexto.pedidos_esperando_pagamento)), [{ id: 1, valor: 12 }]);
  assert.deepEqual(iaFalsa.analises[0].contexto.recebedor_dos_pagamentos, { nome: 'SpeedBoy Motoboy', chave_pix: '46178859000196' });

  // Pelo WhatsApp: o cliente manda a foto; a leitura vai ao responsável, que ainda precisa responder "pago 1".
  await limpar();
  iaFalsa.analise.comprovante.valor = 10;
  iaFalsa.analise.alertas = ['Parece agendamento, não pagamento feito.'];
  await a.receber({ telefone: '5511977770001', nome: 'Carla Souza', texto: '', midia_tipo: 'image/png', midia_base64: PNG.repeat(4) });
  for (let i = 0; i < 20 && !enviadas.some((m) => /Leitura do comprovante/.test(m.texto)); i++) await new Promise((ok) => setTimeout(ok, 5));
  const leitura = enviadas.find((m) => /Leitura do comprovante do pedido #1/.test(m.texto));
  assert.equal(leitura.destino, '5511988880000');
  assert.match(leitura.texto, /R\$\s10,00 ⚠️ o pedido é de R\$\s12,00[\s\S]*SPEEDBOY MOTOBOY \(confere\)[\s\S]*Parece agendamento[\s\S]*pago 1/);
  assert.equal(demandas()[0].pagamento, 'pendente', 'a IA nunca libera sozinha');
});

test('IA: análise de arquivos monta imagem, PDF e texto na chamada e devolve o resultado limpo', async () => {
  const chamadas = [];
  const ia = criarIA({ criarCliente: () => ({ beta: { messages: { parse: async (corpo, opcoes) => {
    chamadas.push({ corpo, opcoes });
    return { stop_reason: 'end_turn', parsed_output: {
      resumo: ' Resumo. ', resposta: '', alertas: ['', 'Olhar isso'],
      pedidos: [{ cliente: 'A', telefone: '', coleta_endereco: 'Rua A', coleta_contato: '', entrega_endereco: 'Rua B', entrega_contato: '', descricao: 'x', servico_id: 0, requisito: 'caminhao', observacao: '' }],
      comprovante: { encontrado: false, valor: 0, recebedor: '', pagador: '', data_hora: '', identificador: '', confere_recebedor: false },
    } };
  } } } }) });
  const r = await ia.analisar({ ia_chave: 'k', ia_modelo: 'claude-sonnet-5-5' }, {
    arquivos: [{ nome: 'f.png', tipo: 'imagem', mime: 'image/png', base64: 'AAAA' }, { nome: 'd.pdf', tipo: 'pdf', base64: 'BBBB' }, { nome: 'c.txt', tipo: 'texto', texto: 'oi' }],
    contexto: { empresa: 'SpeedBoy' }, pergunta: '',
  });
  const { corpo, opcoes } = chamadas[0];
  assert.deepEqual(corpo.messages[0].content.map((b) => b.type), ['text', 'image', 'text', 'document', 'text', 'text', 'text']);
  assert.deepEqual(corpo.messages[0].content[1].source, { type: 'base64', media_type: 'image/png', data: 'AAAA' });
  assert.deepEqual(corpo.messages[0].content[3].source, { type: 'base64', media_type: 'application/pdf', data: 'BBBB' });
  assert.match(corpo.messages[0].content[6].text, /"empresa":"SpeedBoy"[\s\S]*nenhuma; faça a análise padrão/);
  assert.deepEqual([corpo.model, corpo.max_tokens, corpo.output_config.effort, corpo.fallbacks, opcoes.timeout], ['claude-sonnet-5-5', 16000, 'medium', 'default', 120000]);
  assert.match(corpo.system, /não invente|não complete endereço de memória/i);
  assert.deepEqual([r.resumo, r.alertas, r.comprovante, r.pedidos[0].servico_id, r.pedidos[0].requisito], ['Resumo.', ['Olhar isso'], null, null, 'qualquer']);
  await assert.rejects(ia.analisar({ ia_chave: '' }, { arquivos: [], contexto: {}, pergunta: '' }), /chave da IA/);
});

test('pedido do site fechado no WhatsApp: grava valor, recalcula repasse e libera', () => {
  const s = criarServico({ db: abrirBanco(':memory:') });
  const d = s.criarPedido({
    cliente: 'Loja Teste', telefone: '27999990000', descricao: 'caixa',
    coleta: { endereco: 'Rua A, 1, Centro, Vila Velha', lat: -20.3357, lon: -40.2968 },
    entrega: { endereco: 'Rua B, 2, Centro, Vitória', lat: -20.3186, lon: -40.3302 },
  }, 'site', { retida: true });
  assert.equal(d.retida, 1);
  const r = s.fecharPedido(d.id, 40, 'api');
  assert.equal(r.liberada, true);
  const depois = s.estadoAdmin().demandas.find((x) => x.id === d.id);
  assert.equal(depois.valor, 40);
  assert.equal(depois.repasse, 24, '60% de 40');
  assert.equal(s.fecharPedido(d.id, 50, 'api').liberada, false, 'não fecha duas vezes');
  assert.throws(() => s.fecharPedido(9999, 10, 'api'), { codigo: 'nao_encontrado' });
});
