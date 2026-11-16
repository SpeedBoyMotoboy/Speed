// Site de pedidos: o cliente informa coleta e entrega, vê o valor e confirma.
import { h, trocar, api, reais, km, camadaBase, icone } from '/site/base.js';

const L = window.L;
const raiz = document.getElementById('raiz');
const guardado = (() => { try { return JSON.parse(localStorage.getItem('speed_cliente') || '{}'); } catch { return {}; } })();
let info = { empresa: 'Speedboy', ativo: true, fechado: '', mapa: { lat: -23.5505, lon: -46.6333 } };
let pedido = null; // { coleta, entrega, km, valor }

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, info.empresa), h('div', { class: 'sub' }, 'Pedir motoboy'))),
    h('main', null, conteudo));
}

function telaEnderecos(mensagem = '') {
  const coleta = h('input', { id: 'coleta', maxlength: 200, autocomplete: 'street-address', placeholder: 'Rua, número, bairro', value: pedido?.coleta.endereco || guardado.coleta || '' });
  const entrega = h('input', { id: 'entrega', maxlength: 200, placeholder: 'Rua, número, bairro', value: pedido?.entrega.endereco || '' });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  let aqui = null;
  const botaoAqui = h('button', {
    type: 'button', class: 'leve',
    onclick: () => {
      if (!navigator.geolocation) { erro.textContent = 'Este aparelho não informa a localização.'; return; }
      botaoAqui.disabled = true;
      navigator.geolocation.getCurrentPosition((p) => {
        aqui = { lat: p.coords.latitude, lon: p.coords.longitude };
        if (!coleta.value.trim()) coleta.value = 'Minha localização atual';
        botaoAqui.textContent = 'Localização marcada ✓';
      }, () => { botaoAqui.disabled = false; erro.textContent = 'Não consegui ler a localização. Escreva o endereço.'; },
      { enableHighAccuracy: true, timeout: 10000 });
    },
  }, 'Usar minha localização na coleta');
  coleta.addEventListener('input', () => { aqui = null; botaoAqui.disabled = false; botaoAqui.textContent = 'Usar minha localização na coleta'; });

  const seguir = h('button', { class: 'primario', type: 'submit' }, 'Ver valor');
  const form = h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      seguir.disabled = true;
      seguir.textContent = 'Procurando os endereços…';
      try {
        pedido = await api('POST', '/api/publico/cotar', {
          coleta: { endereco: coleta.value, ...(aqui || {}) }, entrega: { endereco: entrega.value },
        });
        telaConfirmar();
      } catch (e) {
        erro.textContent = e.message;
        seguir.disabled = false;
        seguir.textContent = 'Ver valor';
      }
    },
  },
  h('label', { for: 'coleta' }, 'Onde coletamos?'), coleta, botaoAqui,
  h('label', { for: 'entrega' }, 'Onde entregamos?'), entrega,
  seguir, erro);

  moldura(h('h1', null, 'Peça um motoboy agora'),
    h('p', { class: 'nota' }, 'Informe os endereços e veja o valor na hora.'), form);
}

function telaConfirmar() {
  const mapaEl = h('div', { class: 'mapa' });
  const preco = h('div', { class: 'preco' });
  const linhas = { coleta: h('div', null), entrega: h('div', null) };
  const marcadores = {};
  let mapa = null;
  let alvo = null;

  const desenharLinhas = () => {
    for (const [qual, letra] of [['coleta', 'C'], ['entrega', 'E']]) {
      const p = pedido[qual];
      trocar(linhas[qual], h('div', { class: 'linha-end' },
        h('div', { class: `ponto ${qual}` }, letra),
        h('div', null, p.endereco,
          p.lat == null && h('div', { class: 'falta' }, `Não achamos no mapa: toque no mapa para marcar a ${qual}.`))));
    }
    alvo = pedido.coleta.lat == null ? 'coleta' : pedido.entrega.lat == null ? 'entrega' : null;
    trocar(preco,
      h('span', { class: 'nota' }, pedido.km != null ? `Distância aproximada: ${km(pedido.km)}` : 'Marque os dois pontos para ver o valor'),
      h('b', null, pedido.valor != null ? reais(pedido.valor) : pedido.km != null ? 'Valor a combinar' : ''));
  };
  const recotar = async () => {
    try { pedido = await api('POST', '/api/publico/cotar', { coleta: pedido.coleta, entrega: pedido.entrega }); } catch { /* mantém o que tinha */ }
    desenharLinhas();
  };
  const marcar = (qual, lat, lon) => {
    pedido[qual].lat = lat;
    pedido[qual].lon = lon;
    if (marcadores[qual]) marcadores[qual].remove();
    marcadores[qual] = L.marker([lat, lon], { icon: icone(L, `ponto ${qual}`, qual === 'coleta' ? 'C' : 'E'), draggable: true }).addTo(mapa);
    marcadores[qual].on('dragend', (ev) => {
      const pos = ev.target.getLatLng();
      pedido[qual].lat = pos.lat;
      pedido[qual].lon = pos.lng;
      recotar();
    });
  };

  const nome = h('input', { id: 'nome', maxlength: 80, autocomplete: 'name', required: true, value: guardado.nome || '' });
  const telefone = h('input', { id: 'telefone', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', required: true, placeholder: '(11) 99999-0000', value: guardado.telefone || '' });
  const descricao = h('input', { id: 'descricao', maxlength: 300, required: true, placeholder: 'Ex.: envelope, caixa pequena' });
  const contato = h('input', { id: 'contato', maxlength: 120, placeholder: 'Nome e telefone de quem recebe' });
  const requisito = h('select', { id: 'requisito' },
    h('option', { value: 'qualquer' }, 'Cabe na mochila / não precisa de nada especial'),
    h('option', { value: 'bau' }, 'Precisa de baú (volume maior)'),
    h('option', { value: 'bag' }, 'Precisa de bag térmica (comida)'));
  const isca = h('input', { name: 'site', tabindex: '-1', autocomplete: 'off' });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const enviar = h('button', { class: 'primario', type: 'submit' }, 'Confirmar pedido');

  const form = h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      enviar.disabled = true;
      try {
        const r = await api('POST', '/api/publico/pedidos', {
          nome: nome.value, telefone: telefone.value, descricao: descricao.value, requisito: requisito.value, site: isca.value,
          coleta: pedido.coleta, entrega: { ...pedido.entrega, contato: contato.value },
        });
        try { localStorage.setItem('speed_cliente', JSON.stringify({ nome: nome.value, telefone: telefone.value, coleta: pedido.coleta.endereco })); } catch { /* sem armazenamento */ }
        telaPronto(r);
      } catch (e) {
        erro.textContent = e.message;
        enviar.disabled = false;
      }
    },
  },
  h('h2', null, 'Seus dados'),
  h('label', { for: 'nome' }, 'Seu nome'), nome,
  h('label', { for: 'telefone' }, 'Seu WhatsApp (com DDD)'), telefone,
  h('label', { for: 'descricao' }, 'O que vamos levar?'), descricao,
  h('label', { for: 'requisito' }, 'Tamanho'), requisito,
  h('label', { for: 'contato' }, 'Quem recebe na entrega? (opcional)'), contato,
  h('div', { class: 'isca', 'aria-hidden': 'true' }, isca),
  enviar, erro);

  moldura(
    h('h1', null, 'Confira e confirme'),
    h('div', { class: 'cartao' },
      linhas.coleta, linhas.entrega, mapaEl,
      h('p', { class: 'nota' }, 'O ponto ficou errado? Arraste o marcador para o lugar certo.'),
      preco,
      h('button', { type: 'button', class: 'leve', onclick: () => telaEnderecos() }, 'Mudar endereços')),
    form);

  mapa = L.map(mapaEl).setView([info.mapa.lat, info.mapa.lon], 12);
  camadaBase(L).addTo(mapa);
  mapa.on('click', (ev) => {
    if (!alvo) return;
    marcar(alvo, ev.latlng.lat, ev.latlng.lng);
    recotar();
  });
  const pontos = [];
  for (const qual of ['coleta', 'entrega']) {
    if (pedido[qual].lat != null) { marcar(qual, pedido[qual].lat, pedido[qual].lon); pontos.push([pedido[qual].lat, pedido[qual].lon]); }
  }
  if (pontos.length) mapa.fitBounds(pontos, { padding: [40, 40], maxZoom: 16 });
  desenharLinhas();
  nome.focus({ preventScroll: true });
}

function telaPronto(r) {
  const proximo = {
    whatsapp: 'Enviamos uma mensagem no seu WhatsApp. Responda 1 por lá para confirmar e liberar o motoboy.',
    painel: 'Nossa equipe confirma seu pedido em instantes e já libera o motoboy.',
    nenhuma: r.status === 'sem_local' ? 'Nossa equipe vai conferir o endereço e já libera o motoboy.' : 'Já estamos chamando o motoboy mais próximo.',
  }[r.confirmacao];
  pedido = null;
  moldura(
    h('h1', null, `Pedido #${r.id} recebido`),
    h('div', { class: 'cartao' },
      h('p', null, proximo),
      r.valor != null && h('div', { class: 'preco' }, h('span', { class: 'nota' }, 'Valor'), h('b', null, reais(r.valor))),
      h('a', { class: 'botao primario', href: `/acompanhar/?c=${encodeURIComponent(r.codigo)}` }, 'Acompanhar o pedido'),
      h('button', { type: 'button', class: 'leve', onclick: () => telaEnderecos() }, 'Fazer outro pedido')));
}

try { info = await api('GET', '/api/publico/info'); } catch { /* usa o padrão */ }
document.title = `Pedir motoboy — ${info.empresa}`;
if (!info.ativo) {
  moldura(h('h1', null, 'Pedidos pelo site indisponíveis'), h('p', { class: 'nota' }, 'Fale com a gente pelo WhatsApp.'));
} else if (info.fechado) {
  moldura(h('h1', null, 'Estamos fechados agora'), h('p', { class: 'nota' }, `Nosso horário de atendimento: ${info.fechado}.`));
} else {
  telaEnderecos();
}
