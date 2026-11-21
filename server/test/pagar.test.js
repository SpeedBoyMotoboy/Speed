import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';
import { chaveDoMotoboy, crc16 } from '../src/pix.js';

process.env.TZ = 'America/Sao_Paulo';

test('chave Pix do motoboy: descobre o tipo', () => {
  assert.deepEqual(chaveDoMotoboy('(27) 99999-0001'), { tipo: 'telefone', chave: '+5527999990001', duvida: false });
  assert.deepEqual(chaveDoMotoboy('529.982.247-25'), { tipo: 'cpf', chave: '52998224725' });
  assert.equal(chaveDoMotoboy('Fulano@X.com').chave, 'fulano@x.com');
  assert.equal(chaveDoMotoboy('12.345.678/0001-95').tipo, 'cnpj');
  assert.equal(chaveDoMotoboy('abc'), null);
});

test('a pagar: soma desde o último pago, Pix copia e cola e "Marquei pago"', () => {
  const relogio = { t: new Date('2026-12-01T09:00:00-03:00').getTime() };
  const db = abrirBanco(':memory:');
  const s = criarServico({ db, agora: () => relogio.t });
  s.salvarConfig({ diaria_valor: 100, almoco_valor: 20, pix_cidade: 'Vitoria' }, 'teste');
  const id = s.criarMotoboy({ nome: 'Ana Lima', telefone: '27999990001', pin: '123456', veiculo: 'moto', tem_bag: true }, 'teste');
  const mensal = s.criarMotoboy({ nome: 'Lucas', telefone: '27999990002', pin: '123456', veiculo: 'moto', tem_bag: true }, 'teste');
  for (const m of [id, mensal]) s.convocar(m, 'teste');
  const { token } = s.loginMotoboy({ telefone: '27999990001', pin: '123456', aceito_termo: true, dispositivo: 'a', origem: 'app' }, 'ip');
  s.loginMotoboy({ telefone: '27999990002', pin: '123456', aceito_termo: true, dispositivo: 'b', origem: 'app' }, 'ip');
  s.salvarRecebimento(s.autenticarMotoboy(token), { pix_chave: '(27) 99999-0001', pix_titular: 'Ana Lima', pix_banco: 'Inter', ciente: true });
  db.prepare('UPDATE motoboys SET mensal = 1 WHERE id = ?').run(mensal);
  relogio.t += 60 * 60_000;
  let r = s.aPagar();
  const ana = r.lista.find((l) => l.nome === 'Ana Lima');
  assert.equal(r.lista.find((l) => l.nome === 'Lucas'), undefined, 'mensal fica fora');
  assert.equal(ana.valor, 120);
  assert.equal(ana.diarias, 1);
  assert.equal(ana.pix.tipo, 'telefone');
  assert.match(ana.codigo, /br\.gov\.bcb\.pix0114\+5527999990001/);
  assert.match(ana.codigo, /5406120\.00/);
  assert.equal(ana.codigo.slice(-4), crc16(ana.codigo.slice(0, -4)));
  s.marcarMotoboyPago({ motoboy_id: id, ate: r.ate }, 'teste');
  assert.throws(() => s.marcarMotoboyPago({ motoboy_id: id, ate: r.ate }, 'teste'), /já foi marcado/);
  r = s.aPagar();
  assert.equal(r.lista.find((l) => l.nome === 'Ana Lima'), undefined);
  assert.equal(r.pagos[0].valor, 120);
});
