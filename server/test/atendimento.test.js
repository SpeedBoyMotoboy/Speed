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
import { interpretar, normalizarTelefone, destinoDe, enviar } from '../src/mensageiro.js';

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
  const a = criarAtendimento({
    servico: s, geocodificar,
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
  const motoboyEmTurno = () => {
    const id = s.criarMotoboy({ nome: 'Ana Lima', telefone: '11999990001', pin: '123456', veiculo: 'moto', tem_bag: true }, 'teste');
    s.convocar(id, 'teste');
    const { token } = s.loginMotoboy({ telefone: '11999990001', pin: '123456', aceito_termo: true, dispositivo: 'a', origem: 'app' }, 'ip');
    s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...P(0), ts: relogio.t, precisao: 10 }], gps_ligado: true });
    return { id, token };
  };
  const demandas = () => s.estadoAdmin().demandas;
  // Envia o que estava na fila e zera a lista, para conferir só o que vier depois.
  const limpar = async () => { await a.despacharSaida(); enviadas.length = 0; };
  return { s, a, db, relogio, enviadas, cliente, motoboyEmTurno, demandas, limpar };
}

test('telefones: normaliza DDI, nono dígito e ids do WhatsApp', () => {
  assert.equal(normalizarTelefone('5511977770001@s.whatsapp.net'), '11977770001');
  assert.equal(normalizarTelefone('(11) 97777-0001'), '11977770001');
  assert.equal(normalizarTelefone('553188887777'), '31988887777', 'celular sem o nono dígito');
  assert.equal(normalizarTelefone('1133334444'), '1133334444', 'fixo fica como está');
  assert.equal(normalizarTelefone('123'), '');
  assert.equal(destinoDe('11977770001'), '5511977770001');
  assert.equal(destinoDe('553188887777@s.whatsapp.net'), '553188887777');
});

test('webhooks: entende Evolution, Meta e ignora grupo e mensagem própria', () => {
  const evo = (key, message, extra = {}) => ({ event: 'messages.upsert', data: { key, pushName: 'Carla', message, ...extra } });
  assert.deepEqual(interpretar('evolution', evo({ remoteJid: '5511977770001@s.whatsapp.net', fromMe: false }, { conversation: 'oi' })),
    [{ telefone: '11977770001', destino: '5511977770001', nome: 'Carla', texto: 'oi', lat: null, lon: null }]);
  assert.equal(interpretar('evolution', evo({ remoteJid: '5511977770001@s.whatsapp.net', fromMe: true }, { conversation: 'oi' })).length, 0);
  assert.equal(interpretar('evolution', evo({ remoteJid: '12345@g.us', fromMe: false }, { conversation: 'oi' })).length, 0);
  assert.equal(interpretar('evolution', { event: 'connection.update', data: {} }).length, 0);
  const local = interpretar('evolution', evo({ remoteJid: '5511977770001@s.whatsapp.net' }, { locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6 } }));
  assert.equal(local[0].lat, -23.5);
  const meta = interpretar('meta', { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '5511977770001', profile: { name: 'Carla' } }],
    messages: [{ from: '5511977770001', type: 'text', text: { body: 'quero um motoboy' } }],
  } }] }] });
  assert.deepEqual(meta.map((m) => [m.telefone, m.nome, m.texto]), [['11977770001', 'Carla', 'quero um motoboy']]);
});

test('envio: monta a chamada certa para cada provedor', async () => {
  const chamadas = [];
  const buscar = async (url, opcoes) => { chamadas.push({ url, ...opcoes, body: JSON.parse(opcoes.body) }); return { ok: true }; };
  await enviar({ whats_provedor: 'evolution', whats_url: 'http://evo:8080/', whats_instancia: 'speed', whats_token: 'k' }, '5511977770001', 'oi', buscar);
  assert.equal(chamadas[0].url, 'http://evo:8080/message/sendText/speed');
  assert.equal(chamadas[0].headers.apikey, 'k');
  assert.deepEqual(chamadas[0].body, { number: '5511977770001', text: 'oi' });
  await enviar({ whats_provedor: 'meta', whats_url: '', whats_instancia: '999', whats_token: 't' }, '5511977770001', 'oi', buscar);
  assert.match(chamadas[1].url, /graph\.facebook\.com\/v[\d.]+\/999\/messages$/);
  assert.equal(chamadas[1].body.text.body, 'oi');
  await assert.rejects(enviar({ whats_provedor: 'webhook', whats_url: 'http://x' }, '55', 'oi', async () => ({ ok: false, status: 500, text: async () => 'caiu' })), /500/);
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
  assert.match(await cliente('1'), /O que vamos levar/);
  const resumo = await cliente('Caixa grande, precisa de baú. Entregar para João');
  assert.match(resumo, /Confira o pedido[\s\S]*Rua da Coleta[\s\S]*Rua da Entrega[\s\S]*R\$\s12,00/);
  assert.equal(demandas().length, 0, 'nada criado antes de confirmar');

  const fim = await cliente('1');
  assert.match(fim, /Pedido #1 confirmado[\s\S]*https:\/\/speed\.exemplo\/acompanhar\/\?c=/);
  const [d] = demandas();
  assert.equal(d.origem, 'robo');
  assert.equal(d.cliente, 'Carla Souza');
  assert.equal(d.cliente_telefone, '11977770001');
  assert.equal(d.requisito, 'bau');
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
  assert.match(await cliente('Travessa Sumida 5, Bairro Novo'), /Anotei o endereço[\s\S]*O que vamos levar/);
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
  const { s, a, motoboyEmTurno, demandas, enviadas } = montar();
  motoboyEmTurno();
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
  assert.ok(enviadas.some((m) => /chegou pelo site e espera sua aprovação/.test(m.texto)));

  const publico = s.pedidoPublico(r.codigo);
  assert.equal(publico.retida, true);
  assert.equal(publico.motoboy, null);
  assert.throws(() => s.pedidoPublico('codigo-errado'), { codigo: 'nao_encontrado' });

  s.liberarDemanda(r.id, 'admin:teste');
  assert.equal(demandas()[0].status, 'atribuida');
  const depois = s.pedidoPublico(r.codigo);
  assert.equal(depois.motoboy.nome, 'Ana');
  assert.equal(depois.motoboy.lat, null, 'posição só aparece com rastreio_cliente ligado');
  s.salvarConfig({ rastreio_cliente: '1' }, 'teste');
  assert.equal(s.pedidoPublico(r.codigo).motoboy.lat, P(0).lat);
  assert.equal(s.pedidoPublico(r.codigo).paradas_antes, 0);
});

test('site: cliente confirma pelo WhatsApp; sem resposta o pedido é cancelado', async () => {
  const { a, relogio, motoboyEmTurno, demandas, enviadas, limpar } = montar({ site_confirmacao: 'whatsapp' });
  motoboyEmTurno();
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
  assert.match(enviadas[0].texto, /Pedido #1 confirmado/);
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
