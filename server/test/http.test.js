import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { criarServico } from '../src/servico.js';
import { criarApp } from '../src/app.js';
import { criarAtendimento } from '../src/atendimento.js';

async function subir() {
  const db = abrirBanco(':memory:');
  const servico = criarServico({ db });
  servico.garantirAdmin('admin', 'senha-de-teste-123');
  const atendimento = criarAtendimento({ servico });
  const app = criarApp({ servico, atendimento, geocodificar: null });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.address().port}`;
  const chamar = async (metodo, caminho, { corpo, cookie, token, extra } = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      redirect: 'manual',
      headers: {
        ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* não é JSON */ }
    return { status: r.status, json, texto, headers: r.headers };
  };
  return { app, servico, atendimento, chamar };
}

test('API: painel exige login, cookie seguro e cabeçalho próprio', async (t) => {
  const { app, chamar } = await subir();
  t.after(() => app.close());

  assert.equal((await chamar('GET', '/api/admin/estado')).status, 401);
  assert.equal((await chamar('POST', '/api/admin/login', { corpo: { usuario: 'admin', senha: 'errada' } })).status, 401);

  const login = await chamar('POST', '/api/admin/login', { corpo: { usuario: 'admin', senha: 'senha-de-teste-123' } });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  const estado = await chamar('GET', '/api/admin/estado', { cookie });
  assert.equal(estado.status, 200);
  assert.deepEqual(estado.json.motoboys, []);

  const novo = { nome: 'Ana', telefone: '11999990001', pin: '123456', veiculo: 'moto', tem_bag: true };
  assert.equal((await chamar('POST', '/api/admin/motoboys', { cookie, corpo: novo })).status, 403, 'sem X-Speed é recusado');
  const criado = await chamar('POST', '/api/admin/motoboys', { cookie, corpo: novo, extra: { 'X-Speed': '1' } });
  assert.equal(criado.status, 200);
  const lista = await chamar('GET', '/api/admin/estado', { cookie });
  assert.equal(lista.json.motoboys[0].pin_hash, undefined, 'hash da senha nunca sai do servidor');

  await chamar('POST', `/api/admin/motoboys/${criado.json.id}/convocar`, { cookie, corpo: {}, extra: { 'X-Speed': '1' } });
  const entrar = await chamar('POST', '/api/motoboy/login', {
    corpo: { telefone: '11999990001', pin: '123456', aceito_termo: true, dispositivo: 'x', origem: 'app' },
  });
  assert.equal(entrar.status, 200);
  const { token } = entrar.json;

  assert.equal((await chamar('GET', '/api/motoboy/estado')).status, 401);
  assert.equal((await chamar('GET', '/api/admin/estado', { token })).status, 401, 'token de motoboy não abre o painel');
  const ping = await chamar('POST', '/api/motoboy/posicoes', {
    token, corpo: { pontos: [{ lat: -23.55, lon: -46.65, ts: Date.now(), precisao: 8 }], gps_ligado: true, bateria: 80 },
  });
  assert.equal(ping.status, 200);
  const meu = await chamar('GET', '/api/motoboy/estado', { token });
  assert.equal(meu.json.motoboy.nome, 'Ana');

  const mapa = await chamar('GET', '/api/admin/estado', { cookie });
  assert.equal(mapa.json.motoboys[0].turno.bateria, 80);
  assert.equal(mapa.json.motoboys[0].turno.status, 'disponivel');

  await chamar('POST', `/api/admin/turnos/${mapa.json.motoboys[0].turno.id}/encerrar`, { cookie, corpo: {}, extra: { 'X-Speed': '1' } });
  assert.equal((await chamar('GET', '/api/motoboy/estado', { token })).status, 401, 'turno encerrado: rastreio para');

  assert.equal((await chamar('POST', '/api/entrada/demandas', { corpo: { cliente: 'x' } })).status, 401);
  await chamar('POST', '/api/admin/logout', { cookie, corpo: {}, extra: { 'X-Speed': '1' } });
  assert.equal((await chamar('GET', '/api/admin/estado', { cookie })).status, 401);
});

test('estáticos: páginas servidas com CSP e sem escapar da pasta pública', async (t) => {
  const { app, chamar } = await subir();
  t.after(() => app.close());
  const painel = await chamar('GET', '/painel/');
  assert.equal(painel.status, 200);
  assert.match(painel.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await chamar('GET', '/app/')).status, 200);
  assert.equal((await chamar('GET', '/privacidade/')).status, 200);
  assert.equal((await chamar('GET', '/privacidade')).status, 302);
  assert.equal((await chamar('GET', '/vendor/leaflet/leaflet.js')).status, 200);
  assert.equal((await chamar('GET', '/..%2f..%2fpackage.json')).status, 404);
  assert.equal((await chamar('GET', '/vendor/leaflet/..%2f..%2f..%2fpackage.json')).status, 404);
  assert.equal((await chamar('GET', '/')).status, 302);
});

test('API: aviso de Pix do banco só entra com a chave de API ou o segredo interno', async (t) => {
  const { app, servico, chamar } = await subir();
  t.after(() => app.close());
  const corpo = { valor: 25, pagador: 'Paula Reis' };
  assert.equal((await chamar('POST', '/api/entrada/pix-recebido', { corpo })).status, 401);
  assert.equal((await chamar('POST', '/api/entrada/pix-recebido', { corpo, extra: { 'x-speed-segredo': 'errado' } })).status, 401);
  const segredo = servico.lerConfig().whats_segredo;
  const r = await chamar('POST', '/api/entrada/pix-recebido', { corpo, extra: { 'x-speed-segredo': segredo } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});
