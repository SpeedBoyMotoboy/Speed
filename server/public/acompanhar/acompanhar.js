// Acompanhamento do pedido pelo cliente (link com código). Atualiza sozinho.
import { h, trocar, api, reais, hora, camadaBase, icone, desenharQr, botaoComprovante, reduzirFoto } from '/site/base.js';

const L = window.L;
const raiz = document.getElementById('raiz');
const codigo = new URLSearchParams(location.search).get('c') || '';
const cabecalho = h('header', { class: 'topo' });
const corpo = h('main', null);
const mapaEl = h('div', { class: 'mapa' });
raiz.append(cabecalho, corpo);

let mapa = null;
let camada = null;
let enquadrado = '';
let ultimo = '';

const SELO = {
  sem_local: ['Conferindo o endereço', 'espera'], aguardando: ['Procurando motoboy', 'espera'],
  atribuida: ['Motoboy a caminho da coleta', ''], coletada: ['A caminho da entrega', ''],
  entregue: ['Entregue', 'ok'], cancelada: ['Cancelado', 'fim'],
};

function desenharMapa(p) {
  const pontos = [];
  if (!mapa) {
    mapa = L.map(mapaEl, { zoomControl: false });
    camadaBase(L).addTo(mapa);
    camada = L.layerGroup().addTo(mapa);
  }
  camada.clearLayers();
  for (const [qual, letra] of [['coleta', 'C'], ['entrega', 'E']]) {
    if (p[qual].lat == null) continue;
    if (qual === 'coleta' && ['coletada', 'entregue'].includes(p.status)) continue;
    L.marker([p[qual].lat, p[qual].lon], { icon: icone(L, `ponto ${qual}`, letra) }).addTo(camada);
    pontos.push([p[qual].lat, p[qual].lon]);
  }
  if (p.motoboy?.lat != null) {
    L.marker([p.motoboy.lat, p.motoboy.lon], { icon: icone(L, 'ponto motoboy', '🛵', 34), zIndexOffset: 500 }).addTo(camada);
    pontos.push([p.motoboy.lat, p.motoboy.lon]);
  }
  // Só reenquadra quando muda a etapa, para não brigar com quem está mexendo no mapa.
  const chave = `${p.status}|${p.motoboy?.lat != null}`;
  if (pontos.length && chave !== enquadrado) {
    enquadrado = chave;
    mapa.invalidateSize();
    mapa.fitBounds(pontos, { padding: [40, 40], maxZoom: 16 });
  }
  return pontos.length > 0;
}

// Lê o arquivo do comprovante: foto vira JPEG menor; PDF vai como está.
function lerArquivo(arq) {
  if (arq.type === 'application/pdf') {
    return new Promise((ok, falha) => { const l = new FileReader(); l.onload = () => ok(l.result); l.onerror = () => falha(new Error('Não consegui ler o arquivo.')); l.readAsDataURL(arq); });
  }
  return reduzirFoto(arq);
}
// Enviar o comprovante pela própria página: já chega ligado ao pedido certo.
function envioComprovante(p) {
  const aviso = h('div', { class: 'erro', role: 'alert' });
  const campo = h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true });
  const botao = h('button', { type: 'button', class: 'primario' }, p.pix.comprovante ? 'Enviar outro comprovante' : '📎 Enviar comprovante');
  botao.onclick = () => campo.click();
  campo.onchange = async () => {
    const arq = campo.files?.[0];
    if (!arq) return;
    aviso.textContent = '';
    botao.disabled = true;
    botao.textContent = 'Enviando…';
    try {
      await api('POST', '/api/publico/pedidos/comprovante', { codigo, arquivo: await lerArquivo(arq) });
      ultimo = '';
      atualizarJa();
    } catch (e) {
      aviso.textContent = e.message || 'Não consegui enviar. Tente de novo.';
      botao.disabled = false;
      botao.textContent = '📎 Enviar comprovante';
    }
  };
  return [campo, botao, aviso];
}
// Dados da nota fiscal de quem paga o frete (cliente da loja).
function formNota() {
  const doc = h('input', { id: 'nf_doc', inputmode: 'numeric', maxlength: 18, placeholder: 'CPF ou CNPJ' });
  const nome = h('input', { id: 'nf_nome', maxlength: 80, autocomplete: 'name', placeholder: 'Nome completo ou razão social' });
  const aviso = h('div', { class: 'erro', role: 'alert' });
  const salvar = h('button', { type: 'submit' }, 'Salvar dados da nota');
  return h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      aviso.textContent = '';
      salvar.disabled = true;
      try {
        await api('POST', '/api/publico/pedidos/nota', { codigo, nf_doc: doc.value, nf_nome: nome.value });
        ultimo = '';
        atualizarJa();
      } catch (e) { aviso.textContent = e.message; salvar.disabled = false; }
    },
  },
  h('b', null, 'Dados para a nota fiscal do frete'),
  h('label', { for: 'nf_doc' }, 'CPF ou CNPJ'), doc,
  h('label', { for: 'nf_nome' }, 'Nome'), nome,
  aviso, salvar);
}

function desenhar(p) {
  document.title = `Pedido #${p.id} — ${p.empresa}`;
  trocar(cabecalho, h('div', { class: 'dentro' }, h('div', { class: 'logo' }, p.empresa), h('div', { class: 'sub' }, `Pedido #${p.id}`)));
  const [rotulo, classe] = p.pix ? ['Aguardando o pagamento', 'espera']
    : p.retida && !['entregue', 'cancelada'].includes(p.status) ? ['Aguardando confirmação', 'espera'] : SELO[p.status];
  const copiar = p.pix && h('button', {
    type: 'button', class: 'primario',
    onclick: async () => { try { await navigator.clipboard.writeText(p.pix.codigo); copiar.textContent = 'Código copiado ✓'; } catch { /* copia manual */ } },
  }, 'Copiar código Pix');
  const etapas = [
    ['Pedido recebido', p.criada_em],
    ['Motoboy a caminho da coleta', p.atribuida_em],
    ['Coletado', p.coletada_em],
    ['Entregue', p.entregue_em],
  ];
  const atual = p.status === 'cancelada' ? -1 : etapas.filter(([, ts]) => ts != null).length - 1;
  const temMapa = p.coleta.lat != null || p.entrega.lat != null;
  const frase = p.status === 'cancelada' ? `Cancelado às ${hora(p.cancelada_em)}.`
    : p.status === 'entregue' ? `Entregue para ${p.recebedor || 'o destinatário'} às ${hora(p.entregue_em)}.`
      : p.motoboy ? [
        `${p.motoboy.nome} (${p.motoboy.veiculo === 'bike' ? 'bike' : 'moto'}) está com o seu pedido.`,
        p.paradas_antes > 0 ? ` Ele tem ${p.paradas_antes} parada(s) antes da sua.` : '',
      ].join('')
        : p.acima_teto && !p.pix ? 'Estamos confirmando o valor da entrega. O Pix aparece aqui em instantes.'
        : p.pix?.comprovante ? 'Comprovante recebido. Estamos conferindo o pagamento para liberar o motoboy.'
          : p.pix?.manual ? `Pague ${reais(p.valor)} por Pix e envie o comprovante para liberar o motoboy.`
            : p.pix ? `Pague ${reais(p.valor)} por Pix até ${hora(p.pix.expira)} para liberar o motoboy.`
          : p.retida ? 'Assim que o pedido for confirmado, chamamos o motoboy.' : 'Estamos chamando o motoboy mais próximo.';

  trocar(corpo,
    h('div', { class: 'cartao' },
      h('span', { class: `selo ${classe}` }, rotulo),
      h('p', { 'aria-live': 'polite' }, frase),
      p.pix && [
        p.pix.qr
          ? h('img', { class: 'qr', alt: 'QR code do Pix', width: 220, height: 220, src: p.pix.qr.startsWith("data:") ? p.pix.qr : `data:image/png;base64,${p.pix.qr}` })
          : desenharQr(p.pix.codigo),
        h('label', { for: 'pix' }, 'Pix copia e cola'),
        h('textarea', { id: 'pix', readonly: true, rows: 4, value: p.pix.codigo }),
        copiar,
        p.pix.manual && h('div', { class: 'aviso-quarta' },
          h('b', null, 'A entrega só sai depois do pagamento conferido.'),
          h('div', null, 'Pague o Pix e envie o comprovante aqui. Assim que conferir, o motoboy é chamado.')),
        p.pix.manual && envioComprovante(p),
        p.pix.manual && !p.pix.comprovante && botaoComprovante(p.pix.whatsapp, p.id, p.valor)],
      temMapa && !p.pix && mapaEl),
    p.falta_nota && formNota(),
    p.status !== 'cancelada' && h('div', { class: 'cartao' },
      h('ol', { class: 'passos' }, etapas.map(([nome, ts], i) =>
        h('li', { class: i < atual || p.status === 'entregue' ? 'feito' : i === atual ? 'agora' : '' },
          h('span', null, nome), ts != null && h('time', null, hora(ts)))))),
    h('div', { class: 'cartao' },
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto coleta' }, 'C'), h('div', null, p.coleta.endereco)),
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto entrega' }, 'E'), h('div', null, p.entrega.endereco)),
      (p.servico || p.descricao) && h('p', { class: 'nota' }, [p.servico, p.descricao].filter(Boolean).join(' · ')),
      p.valor != null && h('div', { class: 'preco' }, h('span', { class: 'nota' }, 'Valor'), h('b', null, reais(p.valor)))),
    h('a', { class: 'botao primario', href: '/pedir/' }, 'Fazer novo pedido'));
  if (temMapa && !p.pix) desenharMapa(p);
}

// Redesenha na hora (depois de enviar comprovante ou nota), sem abrir outro ciclo de consulta.
async function atualizarJa() {
  try { const p = await api('GET', `/api/publico/pedido?c=${encodeURIComponent(codigo)}`); ultimo = ''; desenhar(p); } catch { /* o ciclo normal mostra */ }
}

async function atualizar() {
  try {
    const p = await api('GET', `/api/publico/pedido?c=${encodeURIComponent(codigo)}`);
    // Só redesenha quando algo muda (o cliente pode estar copiando o código do Pix).
    const chave = JSON.stringify([p.status, p.pagamento, p.retida, p.motoboy, p.paradas_antes, p.pix?.comprovante, p.falta_nota]);
    if (chave !== ultimo) { ultimo = chave; desenhar(p); }
    if (!['entregue', 'cancelada'].includes(p.status)) setTimeout(atualizar, p.pix ? 5000 : 10000);
  } catch (e) {
    if (e.status === 404 || !codigo) {
      trocar(cabecalho, h('div', { class: 'dentro' }, h('div', { class: 'logo' }, 'Acompanhar pedido')));
      trocar(corpo, h('h1', null, 'Pedido não encontrado'), h('p', { class: 'nota' }, 'Confira o link que você recebeu.'),
        h('a', { class: 'botao primario', href: '/pedir/' }, 'Fazer um pedido'));
    } else {
      setTimeout(atualizar, 15000);
    }
  }
}
atualizar();
