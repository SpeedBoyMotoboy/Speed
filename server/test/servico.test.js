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
  assert.ok(Math.abs(o2.repasse - 1.2) < 0.1, `extra da rota ${o2.repasse}`);
  const extra = o2.repasse;
  s.responderOferta(turno(), { oferta_id: o2.id, acao: 'aceitar' });
  const ganhos = s.estadoMotoboy(turno()).rota.filter((p) => p.tipo === 'entrega').map((p) => p.repasse).sort((a, b) => a - b);
  assert.deepEqual(ganhos, [extra, 15]);
});
