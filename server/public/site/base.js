// Peças comuns das páginas públicas (pedir e acompanhar). DOM montado por h(), nunca por innerHTML.
import qrcode from '/vendor/qrcode/qrcode.mjs';
export function h(tag, attrs, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'disabled' || k === 'hidden') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f == null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}
export function trocar(el, ...filhos) {
  el.replaceChildren(...filhos.flat(Infinity).filter((f) => f != null && f !== false));
}
export async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      headers: metodo === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: metodo === 'GET' ? undefined : JSON.stringify(corpo || {}),
    });
  } catch {
    throw new Error('Sem conexão. Confira a internet e tente de novo.');
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(json?.mensagem || 'Não deu certo. Tente de novo.'), { status: r.status, dados: json });
  return json;
}
export const reais = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const hora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const km = (v) => `${Number(v).toFixed(1).replace('.', ',')} km`;

// QR code do Pix desenhado no próprio navegador (para o Pix na chave da empresa).
export function desenharQr(texto, lado = 220) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const celula = Math.max(2, Math.floor(lado / (n + 8)));
  const tela = h('canvas', { class: 'qr', role: 'img', 'aria-label': 'QR code do Pix', width: celula * (n + 8), height: celula * (n + 8) });
  const ctx = tela.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tela.width, tela.height);
  ctx.fillStyle = '#000';
  for (let l = 0; l < n; l++) for (let c = 0; c < n; c++) if (qr.isDark(l, c)) ctx.fillRect((c + 4) * celula, (l + 4) * celula, celula, celula);
  return tela;
}
// Botão para mandar o comprovante pelo WhatsApp da empresa.
export function botaoComprovante(whatsapp, id, valor) {
  if (!whatsapp) return null;
  const texto = `Olá! Segue o comprovante do Pix do pedido #${id} (${reais(valor)}).`;
  return h('a', { class: 'botao primario', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/55${whatsapp}?text=${encodeURIComponent(texto)}` }, 'Enviar comprovante pelo WhatsApp');
}

export function camadaBase(L) {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© colaboradores do OpenStreetMap',
  });
}
export function icone(L, classe, texto, tamanho = 28) {
  const el = h('div', { class: classe }, texto);
  el.style.width = `${tamanho}px`;
  el.style.height = `${tamanho}px`;
  return L.divIcon({ className: '', html: el, iconSize: [tamanho, tamanho], iconAnchor: [tamanho / 2, tamanho / 2] });
}

// Foto escolhida pelo cliente vira JPEG leve (lado maior 1280 px).
export async function reduzirFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const escala = Math.min(1, 1280 / Math.max(img.width, img.height));
  const tela = document.createElement('canvas');
  tela.width = Math.round(img.width * escala);
  tela.height = Math.round(img.height * escala);
  tela.getContext('2d').drawImage(img, 0, 0, tela.width, tela.height);
  return tela.toDataURL('image/jpeg', 0.72);
}

// "Salvar a SpeedBoy no celular": instala a página de pedidos como app quando o navegador deixa.
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); pedidoInstalar = ev; });
export function botaoSalvarApp() {
  const ajuda = h('p', { class: 'nota', hidden: true }, 'No menu do navegador (⋮ ou compartilhar), toque em "Adicionar à tela inicial".');
  const botao = h('button', {
    type: 'button', class: 'leve',
    onclick: async () => {
      if (pedidoInstalar) { pedidoInstalar.prompt(); try { await pedidoInstalar.userChoice; } catch { /* fechou */ } pedidoInstalar = null; return; }
      ajuda.hidden = false;
    },
  }, '📲 Salvar a SpeedBoy no celular');
  return h('div', { class: 'salvar-app' }, botao, ajuda);
}
