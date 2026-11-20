import test from 'node:test';
import assert from 'node:assert/strict';
import { criarVigia, lerAlvos } from '../src/vigia.js';

test('vigia: avisa só depois de 2 falhas seguidas e limpa quando o serviço volta', async () => {
  const relogio = { t: 1_000_000 };
  let fora = true;
  const buscar = async (url) => {
    if (url.includes('site')) return { status: 200 };
    if (fora) throw new Error('sem resposta');
    return { status: 200 };
  };
  const v = criarVigia({ alvos: lerAlvos('Site|https://site.test, Robô|https://robo.test'), buscar, agora: () => relogio.t });
  await v.conferir();
  assert.deepEqual(v.avisos(), []);
  relogio.t += 120_000;
  await v.conferir();
  assert.deepEqual(v.avisos(), ['Robô fora do ar há 2 min.']);
  fora = false;
  await v.conferir();
  assert.deepEqual(v.avisos(), []);
});

test('vigia: erro 5xx conta como fora do ar; lista de alvos ignora entrada torta', async () => {
  const v = criarVigia({ alvos: [{ nome: 'Ponte', url: 'https://ponte.test' }], buscar: async () => ({ status: 502 }) });
  await v.conferir(); await v.conferir();
  assert.equal(v.avisos().length, 1);
  assert.deepEqual(lerAlvos('sem-barra, X|ftp://x, Ok|https://ok.test'), [{ nome: 'Ok', url: 'https://ok.test' }]);
});
