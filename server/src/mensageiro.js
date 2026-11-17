// WhatsApp automático: entende o que o provedor manda (webhook) e envia mensagens.
// Só caminhos oficiais:
//  'meta'    - WhatsApp Cloud API da Meta (direto ou por parceiro oficial), inclusive em coexistência
//              com o app WhatsApp Business no mesmo número;
//  'webhook' - genérico (n8n, Make), para ligar a um provedor OFICIAL que fale JSON simples.
// Conexão pelo WhatsApp Web (QR code: Evolution, Baileys e afins) foi removida: a Meta pode banir o número.
import crypto from 'node:crypto';

export const PROVEDORES = ['', 'meta', 'webhook'];
const MIDIAS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const MIDIA_MAX = 7 * 1024 * 1024; // caracteres em base64 (cerca de 5 MB de arquivo)
const GRAPH = 'https://graph.facebook.com/v21.0';
// Erros da Meta que não adianta tentar de novo (fora da janela de 24 h, número sem WhatsApp, bloqueio de política).
const ERROS_DEFINITIVOS = {
  131047: 'Fora da janela de 24 h: a Meta só deixa mandar modelo aprovado para quem não escreveu nas últimas 24 h.',
  131026: 'O destinatário não pode receber a mensagem (número sem WhatsApp ou versão antiga).',
  131051: 'Tipo de mensagem não aceito.',
  368: 'A Meta bloqueou o envio temporariamente por política.',
};

// Telefone brasileiro como o sistema guarda: DDD + número (10 ou 11 dígitos). '' se não der.
export function normalizarTelefone(bruto) {
  let d = String(bruto ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  // Alguns números de celular ainda chegam sem o nono dígito.
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  return d.length === 10 || d.length === 11 ? d : '';
}

// Para onde responder: dígitos com DDI.
export function destinoDe(bruto) {
  const d = String(bruto ?? '').replace(/\D/g, '');
  return d.length <= 11 ? `55${d}` : d;
}

// Confere a assinatura que a Meta põe em cada aviso (X-Hub-Signature-256 = HMAC-SHA256 do corpo com o App Secret).
export function assinaturaMetaConfere(segredoApp, corpoBruto, cabecalho) {
  if (!segredoApp || !Buffer.isBuffer(corpoBruto)) return false;
  const esperado = Buffer.from(`sha256=${crypto.createHmac('sha256', segredoApp).update(corpoBruto).digest('hex')}`);
  const recebido = Buffer.from(String(cabecalho || ''));
  return recebido.length === esperado.length && crypto.timingSafeEqual(recebido, esperado);
}

function textoMeta(m) {
  return m?.text?.body || m?.button?.text || m?.interactive?.button_reply?.title
    || m?.interactive?.list_reply?.title || m?.image?.caption || m?.document?.caption || m?.video?.caption || '';
}

// Devolve a lista do que chegou. Cada item:
//   mensagem do cliente: { telefone, destino, nome, texto, lat, lon, midia? }
//   eco (coexistência: mensagem que a empresa mandou pelo app WhatsApp Business): { eco: true, id, telefone, destino, texto }
export function interpretar(provedor, corpo) {
  const lista = [];
  const coord = (lat, lon) => {
    const a = Number(lat);
    const b = Number(lon);
    return Number.isFinite(a) && Number.isFinite(b) && (a !== 0 || b !== 0) ? { lat: a, lon: b } : { lat: null, lon: null };
  };
  // Foto ou PDF que veio junto (quando o provedor entrega o arquivo em base64).
  const midiaDe = (mime, base64) => {
    const tipo = String(mime || '').split(';')[0].trim().toLowerCase();
    const dados = typeof base64 === 'string' ? base64.replace(/^data:[^,]*,/, '') : '';
    return MIDIAS.includes(tipo) && dados.length > 100 && dados.length <= MIDIA_MAX ? { mime: tipo, base64: dados } : null;
  };
  const juntar = (bruto, nome, texto, local = {}, midia = null) => {
    const telefone = normalizarTelefone(bruto);
    if (!telefone) return;
    lista.push({
      telefone, destino: destinoDe(bruto), nome: String(nome || '').trim().slice(0, 80),
      texto: String(texto || '').trim().slice(0, 2000), ...coord(local.lat, local.lon),
      ...(midia ? { midia } : {}),
    });
  };

  if (provedor === 'meta') {
    if (corpo?.object && corpo.object !== 'whatsapp_business_account') return lista;
    for (const entrada of corpo?.entry || []) {
      for (const mudanca of entrada?.changes || []) {
        const v = mudanca?.value || {};
        if (mudanca?.field === 'smb_message_echoes') {
          // Coexistência: a empresa respondeu pelo app. Vira registro na conversa e pausa o robô; nunca dispara resposta.
          for (const m of v.message_echoes || []) {
            const telefone = normalizarTelefone(m.to);
            if (!telefone) continue;
            const texto = m.type === 'text' ? textoMeta(m) : textoMeta(m) || `(${m.type || 'mensagem'} enviada pelo app)`;
            lista.push({ eco: true, id: String(m.id || ''), telefone, destino: destinoDe(m.to), texto: String(texto).slice(0, 2000) });
          }
          continue;
        }
        if (mudanca?.field && mudanca.field !== 'messages') continue; // statuses, history, smb_app_state_sync...
        const nomes = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          if (m.type === 'reaction' || m.type === 'system' || m.type === 'unsupported') continue;
          juntar(m.from, nomes.get(m.from), textoMeta(m),
            m.location ? { lat: m.location.latitude, lon: m.location.longitude } : {});
        }
      }
    }
  } else if (provedor === 'webhook') {
    juntar(corpo?.telefone, corpo?.nome, corpo?.texto, { lat: corpo?.lat, lon: corpo?.lon },
      midiaDe(corpo?.midia_tipo, corpo?.midia_base64));
  }
  return lista;
}

// Envia uma mensagem de texto. Devolve o id da mensagem (quando o provedor informa).
// Lança erro com motivo curto; erro.definitivo = true quando não adianta tentar de novo.
export async function enviar(cfg, destino, texto, buscar = fetch) {
  const base = String(cfg.whats_url || '').replace(/\/+$/, '');
  const token = cfg.whats_token || '';
  let url;
  const cabecalhos = { 'Content-Type': 'application/json' };
  let corpo;
  if (cfg.whats_provedor === 'meta') {
    if (!cfg.whats_instancia) throw new Error('Falta o ID do número (Phone Number ID).');
    if (!token) throw new Error('Falta o token de acesso da Meta.');
    url = `${base || GRAPH}/${encodeURIComponent(cfg.whats_instancia)}/messages`;
    cabecalhos.Authorization = `Bearer ${token}`;
    corpo = { messaging_product: 'whatsapp', recipient_type: 'individual', to: destino, type: 'text', text: { preview_url: true, body: texto } };
  } else if (cfg.whats_provedor === 'webhook') {
    if (!base) throw new Error('Falta o endereço do webhook de saída.');
    url = base;
    if (token) cabecalhos.Authorization = `Bearer ${token}`;
    corpo = { telefone: destino, texto };
  } else {
    throw new Error('WhatsApp automático desligado.');
  }
  const r = await buscar(url, {
    method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000),
  });
  const bruto = await r.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(bruto); } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const codigo = json?.error?.code;
    if (ERROS_DEFINITIVOS[codigo]) throw Object.assign(new Error(ERROS_DEFINITIVOS[codigo]), { definitivo: true, codigo });
    const detalhe = (json?.error?.message || bruto).slice(0, 200);
    throw new Error(`Provedor respondeu ${r.status}${detalhe ? `: ${detalhe}` : ''}`);
  }
  return String(json?.messages?.[0]?.id || '');
}
