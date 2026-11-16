// Acompanhamento do pedido pelo cliente (link com código). Atualiza sozinho.
import { h, trocar, api, reais, hora, camadaBase, icone } from '/site/base.js';

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

function desenhar(p) {
  document.title = `Pedido #${p.id} — ${p.empresa}`;
  trocar(cabecalho, h('div', { class: 'dentro' }, h('div', { class: 'logo' }, p.empresa), h('div', { class: 'sub' }, `Pedido #${p.id}`)));
  const [rotulo, classe] = p.retida && !['entregue', 'cancelada'].includes(p.status)
    ? ['Aguardando confirmação', 'espera'] : SELO[p.status];
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
        : p.retida ? 'Assim que o pedido for confirmado, chamamos o motoboy.' : 'Estamos chamando o motoboy mais próximo.';

  trocar(corpo,
    h('div', { class: 'cartao' },
      h('span', { class: `selo ${classe}` }, rotulo),
      h('p', { 'aria-live': 'polite' }, frase),
      temMapa && mapaEl),
    p.status !== 'cancelada' && h('div', { class: 'cartao' },
      h('ol', { class: 'passos' }, etapas.map(([nome, ts], i) =>
        h('li', { class: i < atual || p.status === 'entregue' ? 'feito' : i === atual ? 'agora' : '' },
          h('span', null, nome), ts != null && h('time', null, hora(ts)))))),
    h('div', { class: 'cartao' },
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto coleta' }, 'C'), h('div', null, p.coleta.endereco)),
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto entrega' }, 'E'), h('div', null, p.entrega.endereco)),
      p.descricao && h('p', { class: 'nota' }, p.descricao),
      p.valor != null && h('div', { class: 'preco' }, h('span', { class: 'nota' }, 'Valor'), h('b', null, reais(p.valor)))),
    h('a', { class: 'botao primario', href: '/pedir/' }, 'Fazer novo pedido'));
  if (temMapa) desenharMapa(p);
}

async function atualizar() {
  try {
    const p = await api('GET', `/api/publico/pedido?c=${encodeURIComponent(codigo)}`);
    desenhar(p);
    if (!['entregue', 'cancelada'].includes(p.status)) setTimeout(atualizar, 10000);
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
