// WhatsApp automático: entende o que o provedor manda (webhook) e envia mensagens.
// Provedores: 'evolution' (Evolution API), 'meta' (WhatsApp Cloud API oficial) e
// 'webhook' (genérico: n8n, Make ou qualquer robô que fale JSON simples).

export const PROVEDORES = ['', 'evolution', 'meta', 'webhook'];
const MIDIAS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const MIDIA_MAX = 7 * 1024 * 1024; // caracteres em base64 (cerca de 5 MB de arquivo)

// Telefone brasileiro como o sistema guarda: DDD + número (10 ou 11 dígitos). '' se não der.
export function normalizarTelefone(bruto) {
  let d = String(bruto ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  // Alguns números de celular ainda chegam sem o nono dígito.
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  return d.length === 10 || d.length === 11 ? d : '';
}

// Para onde responder: dígitos com DDI. Aceita o que veio do provedor ou um telefone guardado.
export function destinoDe(bruto) {
  const texto = String(bruto ?? '');
  if (texto.includes('@') && !texto.endsWith('@s.whatsapp.net')) return texto; // id interno (@lid)
  const d = texto.split('@')[0].split(':')[0].replace(/\D/g, '');
  return d.length <= 11 ? `55${d}` : d;
}

function textoEvolution(m) {
  if (!m || typeof m !== 'object') return '';
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption
    || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title || '';
}

// Devolve a lista de mensagens recebidas: { telefone, destino, nome, texto, lat, lon }.
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
  const juntar = (bruto, nome, texto, local = {}, midia = null, destino = bruto) => {
    const telefone = normalizarTelefone(bruto);
    if (!telefone) return;
    lista.push({
      telefone, destino: destinoDe(destino), nome: String(nome || '').trim().slice(0, 80),
      texto: String(texto || '').trim().slice(0, 2000), ...coord(local.lat, local.lon),
      ...(midia ? { midia } : {}),
    });
  };

  if (provedor === 'evolution') {
    if (corpo?.event && !/^messages[._]upsert$/i.test(String(corpo.event))) return lista;
    const itens = Array.isArray(corpo?.data) ? corpo.data : [corpo?.data?.messages ?? corpo?.data].flat();
    for (const item of itens) {
      const chave = item?.key;
      if (!chave || chave.fromMe) continue;
      const jid = String(chave.remoteJid || '');
      if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
      const numero = jid.endsWith('@lid') ? (chave.senderPn || chave.remoteJidAlt || item.senderPn || '') : jid;
      const loc = item.message?.locationMessage || item.message?.liveLocationMessage;
      const arquivo = item.message?.imageMessage || item.message?.documentMessage;
      juntar(numero, item.pushName, textoEvolution(item.message),
        loc ? { lat: loc.degreesLatitude, lon: loc.degreesLongitude } : {},
        arquivo ? midiaDe(arquivo.mimetype, item.message?.base64 ?? item.base64) : null);
    }
  } else if (provedor === 'meta') {
    for (const entrada of corpo?.entry || []) {
      for (const mudanca of entrada?.changes || []) {
        const v = mudanca?.value || {};
        const nomes = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          const texto = m.text?.body || m.button?.text || m.interactive?.button_reply?.title
            || m.interactive?.list_reply?.title || m.image?.caption || '';
          juntar(m.from, nomes.get(m.from), texto,
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

// Envia uma mensagem de texto. Lança erro (com motivo curto) se o provedor recusar.
export async function enviar(cfg, destino, texto, buscar = fetch) {
  const base = String(cfg.whats_url || '').replace(/\/+$/, '');
  const token = cfg.whats_token || '';
  let url;
  let cabecalhos = { 'Content-Type': 'application/json' };
  let corpo;
  if (cfg.whats_provedor === 'evolution') {
    if (!base || !cfg.whats_instancia) throw new Error('Falta o endereço ou a instância da Evolution API.');
    url = `${base}/message/sendText/${encodeURIComponent(cfg.whats_instancia)}`;
    cabecalhos.apikey = token;
    corpo = { number: destino, text: texto };
  } else if (cfg.whats_provedor === 'meta') {
    if (!cfg.whats_instancia) throw new Error('Falta o ID do número (Phone Number ID).');
    url = `${base || 'https://graph.facebook.com/v21.0'}/${encodeURIComponent(cfg.whats_instancia)}/messages`;
    cabecalhos.Authorization = `Bearer ${token}`;
    corpo = { messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: texto } };
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
  if (!r.ok) {
    const detalhe = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(`Provedor respondeu ${r.status}${detalhe ? `: ${detalhe}` : ''}`);
  }
}
