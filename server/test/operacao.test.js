import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';

const MIN = 60_000;
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
    return s.loginMotoboy({ telefone, pin: '123456', aceito_termo: true, dispositivo: `aparelho-${id}`, origem: 'app' }, '1.1.1.1').token;
  };
  const posicao = (token, ponto) =>
    s.registrarPosicoes(s.autenticarMotoboy(token), { pontos: [{ ...ponto, ts: relogio.t, precisao: 10 }], gps_ligado: true });
  const demanda = (kmColeta, kmEntrega, extra = {}) =>
    s.criarDemanda({
      cliente: 'Cliente', requisito: 'qualquer',
      coleta: { endereco: 'Rua da Coleta, 1', ...P(kmColeta) },
      entrega: { endereco: 'Rua da Entrega, 2', ...P(kmEntrega) },
      ...extra,
    }, 'teste');
  return { s, db, relogio, avancar, novoMotoboy, entrar, posicao, demanda };
}

test('conta do dono: entrega comum toca antes para os outros e só depois da espera para ele', () => {
  const { s, db, avancar, novoMotoboy, entrar, posicao, demanda } = montar();
  const dono = novoMotoboy('Dono', '11999990001');
  const outro = novoMotoboy('Outro', '11999990002');
  s.salvarConfig({ atribuir_auto: '0', dono_motoboy_id: String(dono), dono_espera_min: '10' }, 'teste');
  const tDono = entrar(dono, '11999990001');
  const tOutro = entrar(outro, '11999990002');
  posicao(tDono, P(0)); posicao(tOutro, P(0));
  const d = demanda(0, 2);
  const ofertas = (token) => db.prepare('SELECT COUNT(*) AS n FROM ofertas WHERE demanda_id = ? AND turno_id = ?')
    .get(d.id, s.autenticarMotoboy(token).id).n;
  assert.equal(ofertas(tOutro), 1);
  assert.equal(ofertas(tDono), 0);
  avancar(11);
  posicao(tDono, P(0)); posicao(tOutro, P(0));
  s.despacharPendentes();
  assert.equal(ofertas(tDono), 1);
});

test('conta do dono: sozinho no ar, recebe a oferta na hora', () => {
  const { s, db, novoMotoboy, entrar, posicao, demanda } = montar();
  const dono = novoMotoboy('Dono', '11999990001');
  s.salvarConfig({ atribuir_auto: '0', dono_motoboy_id: String(dono), dono_espera_min: '10' }, 'teste');
  const tDono = entrar(dono, '11999990001');
  posicao(tDono, P(0));
  const d = demanda(0, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ofertas WHERE demanda_id = ?').get(d.id).n, 1);
});

test('cancelamento guarda o motivo; pedido parado aparece nos avisos; fechamento conta cancelados', () => {
  const { s, db, relogio, avancar, demanda } = montar();
  const d = demanda(0, 2);
  s.cancelarDemanda(d.id, 'teste', 'cliente desistiu');
  assert.equal(db.prepare('SELECT cancel_motivo AS m FROM demandas WHERE id = ?').get(d.id).m, 'cliente desistiu');
  const d2 = demanda(0, 2);
  assert.equal(s.estadoAdmin().avisos.length, 0);
  avancar(25);
  assert.ok(s.estadoAdmin().avisos.some((a) => a.includes(`#${d2.id}`)));
  const f = s.fechamento(0, relogio.t + 1);
  assert.equal(f.cancelados, 1);
  assert.equal(f.entregas, 0);
  assert.equal(f.em_aberto, 1);
});

test('entrada automática: o mesmo pedido mandado duas vezes em 10 min não duplica', async () => {
  const { s, avancar } = montar();
  const pedido = {
    cliente: 'Aliomar', coleta: { endereco: 'Rua A, 556, Centro', ...P(0) },
    entrega: { endereco: 'Aeroporto de Vitória', ...P(3) },
  };
  const a = await s.criarDemandaExterna(pedido);
  const b = await s.criarDemandaExterna({ ...pedido, coleta: { endereco: 'R. A, 556, Centro', ...P(0) } });
  assert.equal(b.id, a.id);
  avancar(11);
  const c = await s.criarDemandaExterna(pedido);
  assert.notEqual(c.id, a.id);
});

test('diária em turno há 2 h sem entrega lançada gera aviso; com entrega, não', () => {
  const { s, avancar, novoMotoboy, entrar, posicao, demanda } = montar();
  const id = novoMotoboy('Lucas', '11999990003');
  const token = entrar(id, '11999990003');
  posicao(token, P(0));
  const avisos = () => s.estadoAdmin().alertas.filter((a) => a.tipo === 'sem_lancamento' && a.fim == null);
  avancar(121); posicao(token, P(0)); s.rotina();
  assert.equal(avisos().length, 1);
  demanda(0, 2);
  s.rotina();
  assert.equal(avisos().length, 0);
});
