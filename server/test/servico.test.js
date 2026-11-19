import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';
import { melhorInsercao, atende } from '../src/despacho.js';

const MIN = 60_000;
// Pontos em São Paulo, em linha no eixo leste-oeste (≈ 1 km a cada 0.0098 de longitude).
const P = (km) => ({ lat: -23.55, lon: -46.65 + km * 0.0098 });

function montar() {
  const relogio = { t: new Date('2026-03-10T09:00:00-03:00').getTime() };
  const db = abrirBanco(':memory:');
  const s = criarServico({ db, agora: () => relogio.t });
  const avancar = (min) => { relogio.t += min * MIN; };
  const novoMotoboy = (nome, telefone, extra = {}) =>
    s.criarMotoboy({ nome, telefone, pin: '123456', veiculo: 'moto', tem_bau: false, tem_bag: true, ...extra }, 'teste');
  const entrar = (id, telefone) => {
    s.convocar(id, 'teste');
    const { token } = s.loginMotoboy({ telefone, pin: '123456', aceito_termo: true, dispositivo: 'aparelho-1', origem: 'app' }, '1.1.1.1');
    return token;
  };
  const posicao = (token, ponto, extra = {}) =>
    s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...ponto, ts: relogio.t, precisao: 10, ...extra }], gps_ligado: true });
  const demanda = (kmColeta, kmEntrega, extra = {}) =>
    s.criarDemanda({
      cliente: 'Cliente', requisito: 'qualquer',
      coleta: { endereco: 'Rua da Coleta, 1', ...P(kmColeta) },
      entrega: { endereco: 'Rua da Entrega, 2', ...P(kmEntrega) },
      ...extra,
    }, 'teste');
  const alertas = (tipo) => s.estadoAdmin().alertas.filter((a) => a.tipo === tipo);
  return { s, db, relogio, avancar, novoMotoboy, entrar, posicao, demanda, alertas };
}

test('login só com convocação, termo aceito e senha certa', () => {
  const { s, novoMotoboy } = montar();
  const id = novoMotoboy('Ana', '11999990001');
  const dados = { telefone: '(11) 99999-0001', pin: '123456', aceito_termo: true, dispositivo: 'a', origem: 'app' };
  s.salvarConfig({ convocacao_obrigatoria: '1' }, 'teste');
  assert.throws(() => s.loginMotoboy(dados, 'ip'), { codigo: 'sem_convocacao' });
  s.convocar(id, 'teste');
  assert.throws(() => s.loginMotoboy({ ...dados, aceito_termo: false }, 'ip'), { codigo: 'termo_obrigatorio' });
  assert.throws(() => s.loginMotoboy({ ...dados, pin: '000000' }, 'ip'), { codigo: 'login_invalido' });
  const { token, fim_previsto } = s.loginMotoboy(dados, 'ip');
  const turno = s.autenticarMotoboy(token);
  assert.equal(fim_previsto - turno.inicio, 8 * 60 * MIN);
  assert.equal(turno.termo_versao, '1');
});

test('cinco senhas erradas bloqueiam o telefone', () => {
  const { s, novoMotoboy } = montar();
  s.convocar(novoMotoboy('Ana', '11999990001'), 'teste');
  const errado = { telefone: '11999990001', pin: '111111', aceito_termo: true };
  for (let i = 0; i < 5; i++) assert.throws(() => s.loginMotoboy(errado, 'ip'), { codigo: 'login_invalido' });
  assert.throws(() => s.loginMotoboy({ ...errado, pin: '123456' }, 'ip'), { codigo: 'bloqueado' });
});

test('novo login no mesmo turno derruba o aparelho anterior e avisa', () => {
  const { s, novoMotoboy, entrar, alertas } = montar();
  const token1 = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  const { token: token2 } = s.loginMotoboy({ telefone: '11999990001', pin: '123456', aceito_termo: true, dispositivo: 'aparelho-2' }, 'ip');
  assert.throws(() => s.autenticarMotoboy(token1), { codigo: 'turno_encerrado' });
  assert.ok(s.autenticarMotoboy(token2));
  assert.equal(alertas('troca_aparelho').length, 1);
});

test('despacho escolhe o motoboy mais perto', () => {
  const { s, novoMotoboy, entrar, posicao, demanda } = montar();
  const longe = novoMotoboy('Longe', '11999990001');
  const perto = novoMotoboy('Perto', '11999990002');
  posicao(entrar(longe, '11999990001'), P(10));
  posicao(entrar(perto, '11999990002'), P(1));
  const d = demanda(0, 3);
  assert.equal(d.status, 'atribuida');
  assert.equal(d.motoboy_id, perto);
  assert.ok(s);
});

test('despacho respeita baú, bag e limite da bike', () => {
  const { novoMotoboy, entrar, posicao, demanda } = montar();
  const semBau = novoMotoboy('Sem baú', '11999990001');
  const comBau = novoMotoboy('Com baú', '11999990002', { tem_bau: true });
  const bike = novoMotoboy('Bike', '11999990003', { veiculo: 'bike' });
  posicao(entrar(semBau, '11999990001'), P(1));
  posicao(entrar(comBau, '11999990002'), P(20));
  posicao(entrar(bike, '11999990003'), P(0));
  // A bike está em cima da coleta, mas a demanda exige moto.
  assert.equal(demanda(0, 2, { requisito: 'moto' }).motoboy_id, semBau);
  assert.equal(demanda(0, 2, { requisito: 'bau' }).motoboy_id, comBau);
  // 12 km de trecho: longe demais para a bike, mesmo ela estando em cima da coleta.
  assert.notEqual(demanda(0, 12).motoboy_id, bike);
  assert.equal(atende({ veiculo: 'bike', tem_bag: 1 }, { requisito: 'qualquer', coleta_lat: -23.55, coleta_lon: -46.65, entrega_lat: -23.55, entrega_lon: -46.64 }, { bikeMaxKm: 5 }), true);
});

test('sem ninguém em turno a demanda aguarda, sugere rodízio e é entregue ao primeiro que entrar', () => {
  const { s, novoMotoboy, entrar, demanda } = montar();
  const a = novoMotoboy('Ana', '11999990001');
  novoMotoboy('Bia', '11999990002', { tem_bag: false });
  const d = demanda(0, 2, { requisito: 'bag' });
  assert.equal(d.status, 'aguardando');
  const { sugestoes } = s.estadoAdmin();
  assert.deepEqual(sugestoes.map((x) => x.motoboy_id), [a]);
  entrar(a, '11999990001');
  const depois = s.estadoAdmin().demandas.find((x) => x.id === d.id);
  assert.equal(depois.status, 'atribuida');
  assert.equal(depois.motoboy_id, a);
  assert.equal(s.estadoAdmin().sugestoes.length, 0);
});

test('rota: nova demanda entra onde soma menos km, coleta antes da entrega', () => {
  const origem = P(0);
  const rota = [{ ...P(2), id: 'c1' }, { ...P(10), id: 'e1' }];
  const { rota: nova } = melhorInsercao(origem, rota, { ...P(4), id: 'c2' }, { ...P(6), id: 'e2' });
  assert.deepEqual(nova.map((p) => p.id), ['c1', 'c2', 'e2', 'e1']);
});

test('parado no meio da rota gera alerta; andar ou almoçar encerra', () => {
  const { s, novoMotoboy, entrar, posicao, demanda, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(5));
  avancar(30); // 30 min parado SEM demanda: não é problema
  posicao(token, P(5));
  assert.equal(alertas('parado').length, 0);
  demanda(0, 2);
  avancar(5); posicao(token, P(5));
  assert.equal(alertas('parado').length, 0, 'ainda dentro da tolerância');
  avancar(4); posicao(token, P(5));
  const [alerta] = alertas('parado');
  assert.ok(alerta && alerta.fim === null, 'alerta aberto após 9 min parado com demanda');
  avancar(1); posicao(token, P(4));
  assert.ok(alertas('parado')[0].fim !== null, 'fechou quando voltou a andar');
  assert.ok(s.relatorio(0, Number.MAX_SAFE_INTEGER)[0].min_parado >= 9);
});

test('esperar no local da coleta tem tolerância maior', () => {
  const { novoMotoboy, entrar, posicao, demanda, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(0));
  demanda(0, 2);
  avancar(15); posicao(token, P(0));
  assert.equal(alertas('parado').length, 0);
  avancar(6); posicao(token, P(0));
  assert.equal(alertas('parado').length, 1);
});

test('GPS falso, GPS desligado e perda de sinal viram alertas', () => {
  const { s, novoMotoboy, entrar, posicao, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(0), { falso: true });
  assert.equal(alertas('gps_falso').length, 1);
  avancar(1);
  s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [], gps_ligado: false });
  assert.equal(alertas('gps_desligado').length, 1);
  avancar(4);
  s.rotina();
  assert.equal(alertas('sem_sinal').filter((a) => a.fim === null).length, 1);
  assert.equal(s.estadoAdmin().motoboys[0].turno.status, 'sem_sinal');
  posicao(token, P(0));
  assert.equal(alertas('sem_sinal').filter((a) => a.fim === null).length, 0);
  assert.ok(alertas('gps_falso')[0].fim !== null);
});

test('salto impossível de posição é registrado', () => {
  const { novoMotoboy, entrar, posicao, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(0));
  avancar(1);
  posicao(token, P(30));
  assert.equal(alertas('salto').length, 1);
});

test('confirmar longe do local exige justificativa e fica registrado', () => {
  const { s, novoMotoboy, entrar, posicao, demanda, alertas, avancar } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(3));
  const d = demanda(0, 2);
  const turno = () => s.autenticarMotoboy(token);
  assert.throws(() => s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'coleta' }), { codigo: 'fora_do_local' });
  assert.throws(() => s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'entrega', recebedor: 'João' }), { codigo: 'estado_invalido' });
  s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'coleta', justificativa: 'Cliente trouxe até a esquina' });
  assert.equal(alertas('fora_do_local').length, 1);
  avancar(1);
  posicao(token, P(2));
  // posição enviada pela tela é ignorada: vale a do rastreio
  assert.throws(() => s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'entrega', lat: 0.1, lon: 0.1 }), { codigo: 'recebedor_obrigatorio' });
  s.confirmarParada(turno(), { demanda_id: d.id, tipo: 'entrega', recebedor: 'João' });
  const final = s.estadoAdmin().demandas.find((x) => x.id === d.id);
  assert.equal(final.status, 'entregue');
  assert.equal(final.recebedor, 'João');
  assert.equal(s.estadoMotoboy(turno()).rota.length, 0);
});

test('turno acaba em 8 h; não coletadas voltam para a fila', () => {
  const { s, novoMotoboy, entrar, posicao, demanda, avancar } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(0));
  const d = demanda(1, 2);
  avancar(8 * 60 + 1);
  s.rotina();
  assert.throws(() => s.autenticarMotoboy(token), { codigo: 'turno_encerrado' });
  assert.equal(s.estadoAdmin().demandas.find((x) => x.id === d.id).status, 'aguardando');
  // posições depois do turno não entram
  assert.equal(s.estadoAdmin().motoboys[0].turno, null);
});

test('com carga coletada o turno prorroga até entregar (limite de 2 h)', () => {
  const { s, novoMotoboy, entrar, posicao, demanda, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  posicao(token, P(0));
  const d = demanda(0, 2);
  s.confirmarParada(s.autenticarMotoboy(token), { demanda_id: d.id, tipo: 'coleta' });
  avancar(8 * 60 + 5);
  s.rotina();
  assert.ok(s.autenticarMotoboy(token), 'segue ativo para entregar');
  avancar(120);
  s.rotina();
  assert.throws(() => s.autenticarMotoboy(token), { codigo: 'turno_encerrado' });
  assert.equal(alertas('carga_pendente').length, 1);
});

test('almoço: uma vez por turno, não com carga, e pausa o alerta de parado', () => {
  const { s, novoMotoboy, entrar, posicao, demanda, avancar, alertas } = montar();
  const token = entrar(novoMotoboy('Ana', '11999990001'), '11999990001');
  const turno = () => s.autenticarMotoboy(token);
  posicao(token, P(5));
  demanda(0, 2);
  s.almoco(turno(), 'iniciar');
  avancar(30); posicao(token, P(5));
  assert.equal(alertas('parado').length, 0);
  avancar(31); s.rotina(); // almoço de 60 min acaba sozinho
  assert.equal(s.estadoMotoboy(turno()).turno.almoco_ate, null);
  assert.throws(() => s.almoco(turno(), 'iniciar'), { codigo: 'almoco_usado' });
  avancar(9); posicao(token, P(5));
  assert.equal(alertas('parado').length, 1);
});

test('admin reatribui e cancela; relatório soma diária + almoço', () => {
  const { s, novoMotoboy, entrar, posicao, demanda } = montar();
  const a = novoMotoboy('Ana', '11999990001');
  const b = novoMotoboy('Bia', '11999990002');
  posicao(entrar(a, '11999990001'), P(0));
  posicao(entrar(b, '11999990002'), P(9));
  const d = demanda(0, 1);
  assert.equal(d.motoboy_id, a);
  s.reatribuir(d.id, b, 'teste');
  assert.equal(s.estadoAdmin().demandas.find((x) => x.id === d.id).motoboy_id, b);
  s.cancelarDemanda(d.id, 'teste');
  assert.equal(s.estadoAdmin().motoboys.find((m) => m.id === b).turno.pendentes, 0);
  s.salvarConfig({ diaria_valor: 100, almoco_valor: 25 }, 'teste');
  const linhas = s.relatorio(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(linhas.map((l) => [l.nome, l.diarias, l.valor]), [['Ana', 1, 125], ['Bia', 1, 125]]);
  assert.throws(() => s.salvarConfig({ parado_min: 0 }, 'teste'), { codigo: 'config_invalida' });
});

test('entrada automática: endereço em texto vira ponto; sem resultado fica para o admin marcar', async () => {
  const db = abrirBanco(':memory:');
  const s = criarServico({
    db,
    geocodificar: async (texto) => (texto.includes('Paulista') ? [{ nome: 'x', lat: -23.56, lon: -46.65 }] : []),
  });
  const ok = await s.criarDemandaExterna({ cliente: 'Loja', coleta: { endereco: 'Av. Paulista, 1000' }, entrega: { endereco: 'Av. Paulista, 2000' } });
  assert.equal(ok.status, 'aguardando');
  const semLocal = await s.criarDemandaExterna({ cliente: 'Loja', coleta: { endereco: 'Av. Paulista, 1000' }, entrega: { endereco: 'Lugar que não existe' } });
  assert.equal(semLocal.status, 'sem_local');
  s.definirLocais(semLocal.id, { entrega: { lat: -23.57, lon: -46.66 } }, 'teste');
  assert.equal(s.estadoAdmin().demandas.find((x) => x.id === semLocal.id).status, 'aguardando');
  const chave = s.gerarChaveApi('teste');
  assert.equal(s.chaveApiValida(chave), true);
  assert.equal(s.chaveApiValida('errada-errada-errada-errada'), false);
});

test('avulso: rota da mesma coleta paga só o que a rota cresce', () => {
  const { s, novoMotoboy, posicao, demanda } = montar();
  s.salvarConfig({ preco_base: '25', preco_km: '2', preco_minimo: '25', repasse_base: '15', repasse_km: '1.5', preco_km_incluso: '10' }, 'teste');
  novoMotoboy('Bia', '11999990009', { tipo: 'avulso' });
  const { token } = s.loginMotoboy({ telefone: '11999990009', pin: '123456', aceito_termo: true, dispositivo: 'b', origem: 'app' }, '1.1.1.1');
  const turno = () => s.autenticarMotoboy(token);
  posicao(token, P(0));
  const id = (x) => (typeof x === 'object' ? x.id : x);
  const d1 = id(demanda(0, 5));
  const o1 = s.estadoMotoboy(turno()).ofertas.find((o) => o.demanda_id === d1);
  assert.equal(o1.na_rota, false);
  s.responderOferta(turno(), { oferta_id: o1.id, acao: 'aceitar' });
  const d2 = id(demanda(0, 8));
  const o2 = s.estadoMotoboy(turno()).ofertas.find((o) => o.demanda_id === d2);
  // rota coleta→5→8: 10,8 km = R$ 16,20; só a primeira (6,75 km) = R$ 15. A segunda soma R$ 1,20.
  assert.equal(o2.na_rota, true);
  assert.equal(o2.repasse, 1, `extra da rota ${o2.repasse}`); // 16,20 - 15 = 1,20, sem centavos
  const extra = o2.repasse;
  s.responderOferta(turno(), { oferta_id: o2.id, acao: 'aceitar' });
  const ganhos = s.estadoMotoboy(turno()).rota.filter((p) => p.tipo === 'entrega').map((p) => p.repasse).sort((a, b) => a - b);
  assert.deepEqual(ganhos, [extra, 15]);
});

test('tarifa urgente: +20% (mínimo R$ 10) e 70% do extra para o motoboy', () => {
  const { s } = montar();
  s.salvarConfig({ preco_base: '25', preco_km: '2', preco_minimo: '25', preco_km_incluso: '10', repasse_base: '15', repasse_km: '1.5' }, 'teste');
  const normal = s.cotar(P(0), P(5), { km: 8 });
  const urg = s.cotar(P(0), P(5), { km: 8, urgente: true });
  assert.equal(normal.valor, 25);
  assert.equal(urg.valor, 35);
  assert.equal(urg.repasse, 22);
  const longe = s.cotar(P(0), P(20), { km: 30, urgente: true });
  assert.equal(longe.valor, 78); // 65 + 13
  assert.equal(longe.repasse, 54); // 45 + 9,10, sem centavos
});

test('agendada: fica fora do despacho, reserva, expira sem confirmar e bloqueia 1 dia', () => {
  const { s, db, relogio, avancar, novoMotoboy, posicao, demanda } = montar();
  s.salvarConfig({ preco_base: '25', preco_km: '2', preco_minimo: '25', repasse_base: '15', repasse_km: '1.5', preco_km_incluso: '10' }, 'teste');
  const mb = novoMotoboy('Caio', '11999990010', { tipo: 'avulso' });
  const { token } = s.loginMotoboy({ telefone: '11999990010', pin: '123456', aceito_termo: true, dispositivo: 'c', origem: 'app' }, '1.1.1.1');
  const turno = () => s.autenticarMotoboy(token);
  posicao(token, P(0));
  const r = demanda(0, 5, { agendada_para: relogio.t + 6 * 60 * MIN });
  const id = typeof r === 'object' ? r.id : r;
  let e = s.estadoMotoboy(turno());
  assert.equal(e.ofertas.length, 0);
  assert.equal(e.agendadas.length, 1);
  s.agendadaMotoboy(turno(), { demanda_id: id, acao: 'reservar' });
  e = s.estadoMotoboy(turno());
  assert.equal(e.agendadas[0].minha, true);
  assert.equal(e.agendadas[0].pode_confirmar, false);
  assert.throws(() => s.agendadaMotoboy(turno(), { demanda_id: id, acao: 'confirmar' }), /2 horas/);
  avancar(5 * 60 + 1); // passou de 1h antes sem confirmar
  posicao(token, P(0));
  s.rotina();
  const d = db.prepare('SELECT reservada_por FROM demandas WHERE id = ?').get(id);
  assert.equal(d.reservada_por, null);
  assert.ok(db.prepare('SELECT reserva_bloqueio_ate FROM motoboys WHERE id = ?').get(mb).reserva_bloqueio_ate > relogio.t);
});

test('agendada: confirmar na janela entra na rota do motoboy', () => {
  const { s, relogio, avancar, novoMotoboy, posicao, demanda } = montar();
  novoMotoboy('Dani', '11999990011', { tipo: 'avulso' });
  const { token } = s.loginMotoboy({ telefone: '11999990011', pin: '123456', aceito_termo: true, dispositivo: 'd', origem: 'app' }, '1.1.1.1');
  const turno = () => s.autenticarMotoboy(token);
  posicao(token, P(0));
  const r = demanda(0, 5, { agendada_para: relogio.t + 3 * 60 * MIN });
  const id = typeof r === 'object' ? r.id : r;
  s.agendadaMotoboy(turno(), { demanda_id: id, acao: 'reservar' });
  avancar(90);
  posicao(token, P(0));
  s.agendadaMotoboy(turno(), { demanda_id: id, acao: 'confirmar' });
  const e = s.estadoMotoboy(turno());
  assert.equal(e.rota.length, 2);
  assert.ok(e.previsao_fim > relogio.t);
});

test('central finaliza a entrega com motivo', () => {
  const { s, db, demanda } = montar();
  const r = demanda(0, 5);
  const id = typeof r === 'object' ? r.id : r;
  s.finalizarDemanda(id, 'motoboy esqueceu de marcar', 'admin:teste');
  const d = db.prepare('SELECT status, entregue_em, entrega_justificativa FROM demandas WHERE id = ?').get(id);
  assert.equal(d.status, 'entregue');
  assert.ok(d.entregue_em > 0);
  assert.match(d.entrega_justificativa, /Finalizada pela central: motoboy esqueceu/);
  assert.throws(() => s.finalizarDemanda(id, '', 'admin:teste'), /finalizada/);
});

const TABELA = { preco_base: '25', preco_km: '2', preco_minimo: '25', preco_km_incluso: '10', repasse_base: '15', repasse_km: '1.5', tam_g_pct: '20', tam_gg_pct: '40' };

test('tamanho G/GG: % a mais sobre o base, 60% do extra ao motoboy, soma com a urgente', () => {
  const { s } = montar();
  s.salvarConfig(TABELA, 'teste');
  const normal = s.cotar(P(0), P(5), { km: 15, tamanho: 'medio' });
  assert.equal(normal.valor, 35);
  assert.equal(normal.repasse, 22); // 22,50 sem centavos
  const g = s.cotar(P(0), P(5), { km: 15, tamanho: 'grande' });
  assert.equal(g.valor, 42);
  assert.equal(g.repasse, 26);
  assert.equal(g.tamanho_extra, 7);
  const gg = s.cotar(P(0), P(5), { km: 15, tamanho: 'gg' });
  assert.equal(gg.valor, 49);
  assert.equal(gg.repasse, 30);
  const tudo = s.cotar(P(0), P(5), { km: 15, tamanho: 'maior', urgente: true });
  assert.equal(tudo.valor, 59); // 35 + 10 (urgente: 20% = 7, mínimo 10) + 14 (GG)
  assert.equal(tudo.repasse, 37); // 22,50 + 7 + 8,40 = 37,90
  const d = s.criarPedido({ cliente: 'Loja Teste', telefone: '27999990000', coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(5) }, km: 15, tamanho: 'maior' }, 'site', {});
  assert.equal(d.valor, 49);
  assert.equal(d.tamanho, 'gg');
  assert.equal(d.repasse, 30);
});

test('corrida longa suave: tabela até 30 km, R$ 2,50 por km até 50, R$ 3 acima; 70% para o motoboy', () => {
  const { s } = montar();
  s.salvarConfig(TABELA, 'teste');
  const caso = (km, valor, repasse, extra = {}) => {
    const c = s.cotar(P(0), P(5), { km, ...extra });
    assert.equal(c.valor, valor, `valor ${km} km`);
    assert.equal(c.repasse, repasse, `repasse ${km} km`);
  };
  caso(30, 65, 45); // até 30 km: tabela normal
  caso(31, 67, 47); // 65 + 2,50 = 67,50; motoboy 47,25
  caso(36, 80, 56); // Jacaraípe: 65 + 6 × 2,50
  caso(50, 115, 80);
  caso(60, 145, 101); // 115 + 10 × 3
  caso(120, 325, 227);
  caso(60, 145, 101, { tamanho: 'gg' }); // corrida longa não cobra tamanho
  caso(30, 91, 60, { tamanho: 'gg' }); // até 30 km cobra: 65 + 26; motoboy 45 + 15,60
  s.salvarConfig({ longa_km1: '0', longa_km2: '0' }, 'teste'); // desligada: volta a tabela normal
  caso(60, 125, 90);
});

test('central edita o valor: cliente e motoboy, travado, não muda depois de finalizada', () => {
  const { s } = montar();
  s.salvarConfig(TABELA, 'teste');
  const d = s.criarPedido({ cliente: 'Cliente Desconto', telefone: '27999990001', coleta: { endereco: 'Rua A, 1', ...P(0) }, entrega: { endereco: 'Rua B, 2', ...P(5) }, km: 15 }, 'site', { retida: true });
  assert.equal(d.valor, 35);
  const e = s.editarValor(d.id, { valor: '30,50', motivo: 'desconto' }, 'teste');
  assert.equal(e.valor, 30.5);
  assert.equal(e.repasse, 22); // motoboy não muda sozinho
  assert.equal(e.repasse_manual, 1);
  const f = s.editarValor(d.id, { valor: 30.5, repasse: 20 }, 'teste');
  assert.equal(f.repasse, 20);
  assert.throws(() => s.editarValor(d.id, { valor: 0 }, 'teste'), /inválido/);
  assert.throws(() => s.editarValor(d.id, { valor: 'abc' }, 'teste'), /inválido/);
  s.finalizarDemanda(d.id, '', 'teste');
  assert.throws(() => s.editarValor(d.id, { valor: 40 }, 'teste'), /finalizada/);
});
