// Pix pelo Mercado Pago: gera a cobrança e consulta se foi paga.
// O token de acesso (secreto) fica em Configurações e nunca vai para o navegador.
const API = 'https://api.mercadopago.com';

// Data no formato que o Mercado Pago pede, no fuso de Brasília.
const dataMp = (ts) => new Date(ts - 3 * 3600_000).toISOString().replace('Z', '-03:00');

async function chamar(token, metodo, caminho, corpo, extra, buscar) {
  const r = await buscar(API + caminho, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Mercado Pago respondeu ${r.status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ''}`);
  return json;
}

// Devolve { id, codigo (copia e cola), qr (PNG em base64) }.
export async function criarPix(token, { valor, descricao, email, referencia, avisoUrl, expiraEm }, buscar = fetch) {
  const p = await chamar(token, 'POST', '/v1/payments', {
    transaction_amount: valor,
    description: descricao,
    payment_method_id: 'pix',
    payer: { email },
    external_reference: referencia,
    date_of_expiration: dataMp(expiraEm),
    ...(avisoUrl ? { notification_url: avisoUrl } : {}),
  }, { 'X-Idempotency-Key': referencia }, buscar);
  const dados = p?.point_of_interaction?.transaction_data;
  if (!p?.id || !dados?.qr_code) throw new Error('Mercado Pago não devolveu o código Pix.');
  const qr = /^[A-Za-z0-9+/=]+$/.test(dados.qr_code_base64 || '') ? dados.qr_code_base64 : '';
  return { id: String(p.id), codigo: String(dados.qr_code), qr };
}

export async function consultar(token, id, buscar = fetch) {
  const p = await chamar(token, 'GET', `/v1/payments/${encodeURIComponent(id)}`, null, {}, buscar);
  return { status: p?.status, referencia: p?.external_reference, valor: Number(p?.transaction_amount) };
}
