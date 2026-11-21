// Entrega urgente: o cliente informa coleta, entrega e o tipo de serviço, vê o valor, paga o Pix e acompanha.
import { h, trocar, api, reais, km, hora, camadaBase, icone, desenharQr, botaoComprovante, reduzirFoto, botaoSalvarApp } from '/site/base.js';

const L = window.L;
const raiz = document.getElementById('raiz');
const guardado = (() => { try { return JSON.parse(localStorage.getItem('speed_cliente') || '{}'); } catch { return {}; } })();
let info = { empresa: 'SpeedBoy', ativo: true, fechado: '', mapa: { lat: -23.5505, lon: -46.6333 }, prazo_min: 30, pagamento: false, servicos: [] };
let pedido = null; // { coleta, entrega, km, valor }
let servicoId = null;
let espera = null; // conferência do pagamento
// Link do cliente da loja (/pedir/?loja=CÓDIGO): a retirada é a loja; o cliente só diz onde entregar.
const codLoja = new URLSearchParams(location.search).get('loja') || '';
let loja = null; // { nome, coleta: { endereco } }

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, info.empresa), h('div', { class: 'sub' }, loja ? `Entrega da ${loja.nome}` : 'Entrega urgente'))),
    h('main', null, conteudo));
}

function telaEnderecos(mensagem = '') {
  clearTimeout(espera);
  const servico = h('select', { id: 'servico' }, info.servicos.map((x) =>
    h('option', { value: x.id, selected: x.id === servicoId }, x.adicional ? `${x.nome} (+ ${reais(x.adicional)})` : x.nome)));
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
        servicoId = info.servicos.length ? Number(loja ? info.servicos[0].id : servico.value) : null;
        pedido = await api('POST', '/api/publico/cotar', loja
          ? { loja: codLoja, entrega: { endereco: entrega.value }, servico_id: servicoId }
          : { coleta: { endereco: coleta.value, ...(aqui || {}) }, entrega: { endereco: entrega.value }, servico_id: servicoId });
        telaConfirmar();
      } catch (e) {
        erro.textContent = e.message;
        seguir.disabled = false;
        seguir.textContent = 'Ver valor';
      }
    },
  },
  !loja && [h('label', { for: 'coleta' }, 'Onde coletamos?'), coleta, botaoAqui],
  h('label', { for: 'entrega' }, loja ? 'Onde você quer receber?' : 'Onde entregamos?'), entrega,
  !loja && info.servicos.length > 1 && [h('label', { for: 'servico' }, 'O que você precisa?'), servico],
  seguir, erro);

  if (loja) {
    moldura(h('h1', null, `Receba sua compra da ${loja.nome}`),
      h('p', { class: 'nota' }, 'Diga onde entregar e veja o valor do frete na hora. O motoboy retira na loja e leva até você.'), form);
    return;
  }
  moldura(h('h1', null, `Motoboy em até ${info.prazo_min} minutos`),
    h('p', { class: 'nota' }, info.pagamento
      ? 'Informe os endereços, veja o valor na hora e pague por Pix. O motoboy sai assim que o pagamento cair.'
      : 'Informe os endereços e veja o valor na hora.'), form);
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
      const daLoja = loja && qual === 'coleta';
      trocar(linhas[qual], h('div', { class: 'linha-end' },
        h('div', { class: `ponto ${qual}` }, letra),
        h('div', null, daLoja ? `Retirada na ${loja.nome}` : p.endereco,
          p.lat == null && !daLoja && h('div', { class: 'falta' }, `Não achamos no mapa: toque no mapa para marcar a ${qual}.`))));
    }
    alvo = pedido.coleta.lat == null && !loja ? 'coleta' : pedido.entrega.lat == null ? 'entrega' : null;
    trocar(preco,
      h('span', { class: 'nota' }, pedido.km != null ? `Distância aproximada: ${km(pedido.km)}` : 'Marque os dois pontos para ver o valor'),
      h('b', null, pedido.valor != null ? reais(pedido.valor) : pedido.km != null ? 'Valor a combinar' : ''));
  };
  const recotar = async () => {
    try { pedido = await api('POST', '/api/publico/cotar', { ...(loja ? { loja: codLoja } : { coleta: pedido.coleta }), entrega: pedido.entrega, servico_id: servicoId }); } catch { /* mantém o que tinha */ }
    desenharLinhas();
  };
  const marcar = (qual, lat, lon) => {
    pedido[qual].lat = lat;
    pedido[qual].lon = lon;
    if (marcadores[qual]) marcadores[qual].remove();
    marcadores[qual] = L.marker([lat, lon], { icon: icone(L, `ponto ${qual}`, qual === 'coleta' ? 'C' : 'E'), draggable: !(loja && qual === 'coleta') }).addTo(mapa);
    marcadores[qual].on('dragend', (ev) => {
      const pos = ev.target.getLatLng();
      pedido[qual].lat = pos.lat;
      pedido[qual].lon = pos.lng;
      recotar();
    });
  };

  const nome = h('input', { id: 'nome', maxlength: 80, autocomplete: 'name', required: true, value: guardado.nome || '' });
  const telefone = h('input', { id: 'telefone', type: 'tel', inputmode: 'tel', autocomplete: 'tel-national', required: true, placeholder: '(11) 99999-0000', value: guardado.telefone || '' });
  const email = h('input', { id: 'email', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: 120, required: info.pede_email, value: guardado.email || '' });
  const descricao = h('input', { id: 'descricao', maxlength: 300, required: true, placeholder: loja ? 'Ex.: 2 jogos de lençol, pedido 1234' : 'Ex.: envelope para reconhecer firma' });
  const contato = h('input', { id: 'contato', maxlength: 120, placeholder: 'Nome e telefone de quem recebe' });
  const requisito = h('select', { id: 'requisito' },
    h('option', { value: 'qualquer' }, 'Cabe na mochila / não precisa de nada especial'),
    h('option', { value: 'bau' }, 'Precisa de baú (volume maior)'),
    h('option', { value: 'bag' }, 'Precisa de bag térmica (comida)'));
  const isca = h('input', { name: 'site', tabindex: '-1', autocomplete: 'off' });
  // Link da loja: quem recebe (pode ser outra pessoa), como entregar, foto da fachada e dados da nota.
  const outraPessoa = h('input', { type: 'checkbox', id: 'outra' });
  const recebeNome = h('input', { id: 'recebe_nome', maxlength: 80, autocomplete: 'off', placeholder: 'Nome de quem recebe' });
  const recebeFone = h('input', { id: 'recebe_fone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '(27) 99999-0000' });
  const blocoOutra = h('div', { hidden: true }, h('label', { for: 'recebe_nome' }, 'Nome de quem recebe'), recebeNome, h('label', { for: 'recebe_fone' }, 'Telefone de quem recebe'), recebeFone);
  outraPessoa.addEventListener('change', () => { blocoOutra.hidden = !outraPessoa.checked; recebeNome.required = outraPessoa.checked; recebeFone.required = outraPessoa.checked; });
  const instrucoes = h('textarea', { id: 'instrucoes', rows: 3, maxlength: 300, placeholder: 'Ex.: deixar na portaria com o Sr. João. Apto 302, bloco B. Casa de portão azul.' });
  const fachada = h('input', { id: 'fachada', type: 'file', accept: 'image/*' });
  const nfDoc = h('input', { id: 'nf_doc', inputmode: 'numeric', maxlength: 18, placeholder: 'Só os números (opcional)', value: guardado.nf_doc || '' });
  const nfNome = h('input', { id: 'nf_nome', maxlength: 120, placeholder: 'Nome completo ou razão social (opcional)', value: guardado.nf_nome || '' });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const enviar = h('button', { class: 'primario', type: 'submit' }, info.pagamento ? 'Pagar com Pix' : 'Confirmar pedido');

  const form = h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      enviar.disabled = true;
      try {
        const r = await api('POST', '/api/publico/pedidos', {
          nome: nome.value, telefone: telefone.value, email: email.value, descricao: descricao.value, requisito: requisito.value,
          servico_id: servicoId, site: isca.value,
          ...(loja
            ? { loja: codLoja, recebe_nome: outraPessoa.checked ? recebeNome.value : '', recebe_fone: outraPessoa.checked ? recebeFone.value : '', instrucoes: instrucoes.value, nf_doc: nfDoc.value, nf_nome: nfNome.value }
            : { coleta: pedido.coleta }),
          entrega: { ...pedido.entrega, contato: loja ? '' : contato.value },
        });
        try { localStorage.setItem('speed_cliente', JSON.stringify({ nome: nome.value, telefone: telefone.value, email: email.value, coleta: loja ? (guardado.coleta || '') : pedido.coleta.endereco, nf_doc: loja ? nfDoc.value : (guardado.nf_doc || ''), nf_nome: loja ? nfNome.value : (guardado.nf_nome || '') })); } catch { /* sem armazenamento */ }
        // A foto da fachada vai depois do pedido criado; se falhar, o pedido segue e o motoboy usa as instruções.
        if (loja && fachada.files && fachada.files[0]) {
          enviar.textContent = 'Enviando a foto…';
          try { await api('POST', '/api/publico/pedidos/fachada', { codigo: r.codigo, foto: await reduzirFoto(fachada.files[0]) }); } catch { /* segue sem foto */ }
        }
        if (r.pix) telaPix(r); else telaPronto(r);
      } catch (e) {
        // A conferência viu que a descrição é de outro tipo de serviço: mostra o valor certo e pede novo clique.
        if (e.dados?.erro === 'servico_diferente') {
          servicoId = e.dados.servico_id;
          pedido.km = e.dados.km;
          pedido.valor = e.dados.valor;
          desenharLinhas();
        }
        erro.textContent = e.message;
        enviar.disabled = false;
      }
    },
  },
  h('h2', null, 'Seus dados'),
  h('label', { for: 'nome' }, 'Seu nome'), nome,
  h('label', { for: 'telefone' }, 'Seu WhatsApp (com DDD)'), telefone,
  info.pede_email && [h('label', { for: 'email' }, 'Seu e-mail (para o comprovante do Pix)'), email],
  h('label', { for: 'descricao' }, loja ? 'O que você comprou? (a loja separa mais rápido)' : 'Descreva o serviço'), descricao,
  h('label', { for: 'requisito' }, 'Tamanho'), requisito,
  !loja && [h('label', { for: 'contato' }, 'Quem recebe na entrega? (opcional)'), contato],
  loja && [
    h('h2', null, 'Na entrega'),
    h('label', { class: 'marcar' }, outraPessoa, 'Outra pessoa vai receber'), blocoOutra,
    h('label', { for: 'instrucoes' }, 'Como o motoboy entrega? (portaria, apartamento, com quem deixar)'), instrucoes,
    h('label', { for: 'fachada' }, 'Foto da fachada (opcional, ajuda o motoboy a achar)'), fachada,
    h('h2', null, 'Nota fiscal do frete'),
    h('p', { class: 'nota' }, 'A nota sai no seu nome. Informe CPF ou CNPJ.'),
    h('label', { for: 'nf_doc' }, 'CPF ou CNPJ'), nfDoc,
    h('label', { for: 'nf_nome' }, 'Nome completo ou razão social'), nfNome],
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

// Pix: QR code e copia e cola. A página confere sozinha e segue quando o pagamento cai.
function telaPix(r) {
  const aviso = h('p', { class: 'nota', 'aria-live': 'polite' }, 'Aguardando o pagamento…');
  const copiar = h('button', {
    type: 'button', class: 'primario',
    onclick: async () => {
      try { await navigator.clipboard.writeText(r.pix.codigo); copiar.textContent = 'Código copiado ✓'; } catch { aviso.textContent = 'Selecione o código acima e copie.'; }
    },
  }, 'Copiar código Pix');
  const qr = r.pix.qr
    ? h('img', { class: 'qr', alt: 'QR code do Pix', width: 220, height: 220, src: r.pix.qr.startsWith("data:") ? r.pix.qr : `data:image/png;base64,${r.pix.qr}` })
    : desenharQr(r.pix.codigo);
  const manual = Boolean(r.pix.manual);
  pedido = null;
  moldura(
    h('h1', null, `Pague ${reais(r.pix?.valor ?? r.valor)} para liberar o motoboy`),
    h('div', { class: 'cartao' },
      h('p', null, `Pedido #${r.id}. Abra o app do seu banco, escolha Pix e leia o QR code ou cole o código.`),
      qr,
      h('label', { for: 'pix' }, 'Pix copia e cola'),
      h('textarea', { id: 'pix', readonly: true, rows: 4, value: r.pix.codigo, onfocus: (ev) => ev.target.select() }),
      copiar,
      manual && [
        h('p', null, 'Depois de pagar, envie o comprovante. Liberamos o motoboy assim que conferirmos.'),
        botaoComprovante(info.whatsapp, r.id, r.valor)],
      aviso,
      !manual && h('p', { class: 'nota' }, `O código vale até ${hora(r.pix.expira)}. Sem pagamento, o pedido é cancelado sozinho.`),
      h('a', { class: 'botao', href: `/acompanhar/?c=${encodeURIComponent(r.codigo)}` }, 'Acompanhar o pedido'),
      loja && botaoSalvarApp()));

  const conferir = async () => {
    try {
      const p = await api('GET', `/api/publico/pedido?c=${encodeURIComponent(r.codigo)}`);
      if (p.pagamento === 'pago' || p.status === 'cancelada') { location.href = `/acompanhar/?c=${encodeURIComponent(r.codigo)}`; return; }
    } catch { /* tenta de novo */ }
    espera = setTimeout(conferir, 4000);
  };
  espera = setTimeout(conferir, 4000);
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
      loja ? [
        h('p', { class: 'nota' }, 'Precisa de motoboy para outra coisa? Documento, compra, entrega: a SpeedBoy busca e leva.'),
        h('a', { class: 'botao', href: '/pedir/' }, 'Chamar a SpeedBoy'),
        botaoSalvarApp(),
      ] : h('button', { type: 'button', class: 'leve', onclick: () => telaEnderecos() }, 'Fazer outro pedido')));
}

try { navigator.serviceWorker?.register('sw.js').catch(() => {}); } catch { /* sem suporte */ }
try { info = await api('GET', '/api/publico/info'); } catch { /* usa o padrão */ }
let linkRuim = '';
if (codLoja) {
  try { loja = await api('GET', `/api/publico/loja?l=${encodeURIComponent(codLoja)}`); } catch (e) { linkRuim = e.message || 'Link inválido.'; }
}
document.title = loja ? `Entrega da ${loja.nome} — ${info.empresa}` : `Pedir motoboy — ${info.empresa}`;
if (linkRuim) {
  moldura(h('h1', null, 'Link inválido'), h('p', { class: 'nota' }, 'Peça o link certo à loja onde você comprou.'));
} else if (!info.ativo) {
  moldura(h('h1', null, 'Pedidos pelo site indisponíveis'), h('p', { class: 'nota' }, 'Fale com a gente pelo WhatsApp.'));
} else if (info.fechado) {
  moldura(h('h1', null, 'Estamos fechados agora'), h('p', { class: 'nota' }, `Nosso horário de atendimento: ${info.fechado}.`));
} else {
  telaEnderecos();
}
