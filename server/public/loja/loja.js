// Entrega para lojas (varejo): a loja grava nome, WhatsApp e endereço de saída uma vez;
// depois só informa a entrega, vê o valor da tabela e confirma.
import { h, trocar, api, reais, km, camadaBase, icone } from '/site/base.js';

const L = window.L;
const raiz = document.getElementById('raiz');
const CHAVE = 'speed_loja';
let info = { empresa: 'SpeedBoy', ativo: true, fechado: '', mapa: { lat: -20.3358, lon: -40.2969 } };
let pedido = null; // { coleta, entrega, km, valor, zona_sul }

const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch { return null; } };
const gravar = (l) => { try { localStorage.setItem(CHAVE, JSON.stringify(l)); } catch { /* sem armazenamento */ } };
let loja = ler();

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, info.empresa), h('div', { class: 'sub' }, loja?.nome ? `Entregas — ${loja.nome}` : 'Entrega para lojas'))),
    h('main', null, conteudo));
}

// Primeira vez (ou editar): dados da loja e endereço de saída.
function telaLoja(mensagem = '') {
  const nome = h('input', { id: 'nome', maxlength: 80, required: true, placeholder: 'Ex.: KS Modas', value: loja?.nome || '' });
  const telefone = h('input', { id: 'telefone', type: 'tel', inputmode: 'tel', required: true, placeholder: '(27) 99999-0000', value: loja?.telefone || '' });
  const saida = h('input', { id: 'saida', maxlength: 200, required: true, placeholder: 'Rua, número, bairro, cidade', value: loja?.coleta?.endereco || '' });
  const fixa = h('input', { id: 'fixa', type: 'checkbox', checked: loja ? loja.fixa !== false : true });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const salvar = h('button', { class: 'primario', type: 'submit' }, 'Salvar e continuar');
  const form = h('form', {
    class: 'cartao',
    onsubmit: (ev) => {
      ev.preventDefault();
      const tel = telefone.value.replace(/\D/g, '');
      if (nome.value.trim().length < 2) { erro.textContent = 'Informe o nome da loja.'; return; }
      if (tel.length < 10) { erro.textContent = 'Informe o WhatsApp com DDD.'; return; }
      if (saida.value.trim().length < 6) { erro.textContent = 'Escreva o endereço de saída com rua, número e bairro.'; return; }
      const mudou = saida.value.trim() !== (loja?.coleta?.endereco || '');
      loja = {
        nome: nome.value.trim(), telefone: telefone.value.trim(), fixa: fixa.checked,
        coleta: mudou ? { endereco: saida.value.trim() } : loja.coleta,
      };
      gravar(loja);
      telaEntrega();
    },
  },
  h('label', { for: 'nome' }, 'Nome da loja'), nome,
  h('label', { for: 'telefone' }, 'WhatsApp da loja (com DDD)'), telefone,
  h('label', { for: 'saida' }, 'Endereço de saída (onde o motoboy busca)'), saida,
  h('label', { class: 'marcar', for: 'fixa' }, fixa, 'Usar sempre este endereço de saída'),
  salvar, erro);
  moldura(h('h1', null, loja ? 'Dados da loja' : 'Primeiro acesso'),
    h('p', { class: 'nota' }, 'Preencha só uma vez. Fica guardado neste aparelho e dá para editar quando quiser.'), form);
  (loja ? saida : nome).focus({ preventScroll: true });
}

// Campo com rótulo; obrigatório quando "req".
const campo = (id, rotulo, attrs = {}) => {
  const el = h(attrs.tag || 'input', { id, maxlength: 160, ...attrs, tag: null });
  return { el, nos: [h('label', { for: id }, rotulo), el] };
};
const caixa = (id, rotulo, marcado = false) => {
  const el = h('input', { id, type: 'checkbox', checked: marcado });
  return { el, nos: h('label', { class: 'marcar', for: id }, el, rotulo) };
};

function telaEntrega(mensagem = '') {
  const trocarSaida = loja.fixa === false;
  const ant = pedido?.form || {};
  const v = (k, padrao = '') => ant[k] ?? padrao;
  // Coleta
  const saida = campo('saida', 'Endereço de saída', { maxlength: 200, required: true, placeholder: 'Rua, número, bairro, cidade', value: loja.coleta?.endereco || '' });
  const falarCom = campo('falar', 'Falar com quem na loja', { required: true, placeholder: 'Nome e telefone', value: v('falar', loja.falar || '') });
  const comoRetirar = campo('retirar', 'Como retirar (loja/piso/balcão, onde estacionar)', { placeholder: 'Ex.: loja 12, piso L2, retirar no caixa', value: v('retirar', loja.retirar || '') });
  // Entrega
  const entrega = campo('entrega', 'Endereço de entrega', { maxlength: 200, required: true, placeholder: 'Rua, número, bairro, cidade', value: pedido?.entrega?.base || '' });
  const compl = campo('compl', 'Complemento', { placeholder: 'Apto, bloco, casa, sala', value: v('compl') });
  const refer = campo('refer', 'Ponto de referência', { placeholder: 'Ex.: em frente à farmácia, portão azul', value: v('refer') });
  const recebe = campo('recebe', 'Nome de quem recebe', { required: true, value: v('recebe') });
  const telRecebe = campo('telrecebe', 'Telefone de quem recebe (com DDD)', { type: 'tel', inputmode: 'tel', required: true, placeholder: '(27) 99999-0000', value: v('telrecebe') });
  const instrEnt = campo('instrent', 'Instruções na entrega', { placeholder: 'Ex.: deixar na portaria, ligar ao chegar', value: v('instrent') });
  const ate = campo('ate', 'Entregar até (horário, se tiver)', { type: 'time', value: v('ate') });
  // Mercadoria
  const item = campo('item', 'O que vai', { required: true, placeholder: 'Ex.: 2 vestidos, nº do pedido 123', value: v('item') });
  const volumes = campo('volumes', 'Quantidade de volumes', { type: 'number', min: 1, max: 50, inputmode: 'numeric', value: v('volumes', '1') });
  const tamanho = { el: h('select', { id: 'tamanho' },
    h('option', { value: 'qualquer' }, 'Pequeno — cabe na mochila'),
    h('option', { value: 'bau' }, 'Grande — precisa de baú'),
    h('option', { value: 'bag' }, 'Comida — precisa de bag térmica')) };
  tamanho.el.value = v('tamanho', 'qualquer');
  tamanho.nos = [h('label', { for: 'tamanho' }, 'Tamanho'), tamanho.el];
  const fragil = caixa('fragil', 'Frágil — cuidado no transporte', v('fragil', false));
  const troca = caixa('troca', 'Troca / ida e volta (motoboy traz algo de volta para a loja)', v('troca', false));
  const cobrar = campo('cobrar', 'Cobrar do cliente na entrega? (valor e forma)', { placeholder: 'Ex.: R$ 89,90 no Pix. Vazio = já está pago', value: v('cobrar') });
  const obs = campo('obs', 'Outras observações para o motoboy', { tag: 'textarea', rows: 2, maxlength: 200, value: v('obs') });

  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const seguir = h('button', { class: 'primario', type: 'submit' }, 'Ver valor');

  const blocoSaida = trocarSaida ? saida.nos
    : h('div', { class: 'saida' },
      h('div', null, h('div', { class: 'nota' }, 'Saída'), h('b', null, loja.coleta?.endereco || '')),
      h('button', { type: 'button', class: 'leve', onclick: () => telaLoja() }, 'Trocar'));

  const ler = () => ({
    falar: falarCom.el.value.trim(), retirar: comoRetirar.el.value.trim(), compl: compl.el.value.trim(), refer: refer.el.value.trim(),
    recebe: recebe.el.value.trim(), telrecebe: telRecebe.el.value.trim(), instrent: instrEnt.el.value.trim(), ate: ate.el.value,
    item: item.el.value.trim(), volumes: volumes.el.value || '1', tamanho: tamanho.el.value, fragil: fragil.el.checked,
    troca: troca.el.checked, cobrar: cobrar.el.value.trim(), obs: obs.el.value.trim(),
  });

  const form = h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      const f = ler();
      if (f.telrecebe.replace(/\D/g, '').length < 10) { erro.textContent = 'Telefone de quem recebe com DDD.'; return; }
      seguir.disabled = true;
      seguir.textContent = 'Procurando no mapa…';
      try {
        let coleta = loja.coleta;
        if (trocarSaida && saida.el.value.trim() !== loja.coleta?.endereco) coleta = { endereco: saida.el.value.trim() };
        const r = await api('POST', '/api/publico/cotar', { coleta, entrega: { endereco: entrega.el.value }, telefone: loja.telefone });
        pedido = { ...r, form: f };
        pedido.entrega.base = r.entrega.endereco;
        if (coleta === loja.coleta && r.coleta.lat != null) loja.coleta = { ...r.coleta, contato: '' };
        loja.falar = f.falar;
        loja.retirar = f.retirar;
        gravar(loja);
        telaConfirmar();
      } catch (e) {
        erro.textContent = e.message;
        seguir.disabled = false;
        seguir.textContent = 'Ver valor';
      }
    },
  },
  h('h2', null, '1. Coleta'), blocoSaida, falarCom.nos, comoRetirar.nos,
  h('h2', null, '2. Entrega'), entrega.nos, compl.nos, refer.nos, recebe.nos, telRecebe.nos, instrEnt.nos, ate.nos,
  h('h2', null, '3. Mercadoria'), item.nos, volumes.nos, tamanho.nos, fragil.nos, troca.nos, cobrar.nos, obs.nos,
  seguir, erro);

  moldura(h('h1', null, 'Nova entrega'),
    h('p', { class: 'nota' }, 'Quanto mais detalhe, mais rápido o motoboy é atendido.'), form,
    h('button', { type: 'button', class: 'leve', onclick: () => telaLoja() }, 'Editar dados da loja'));
  entrega.el.focus({ preventScroll: true });
}

// Junta o formulário no pedido: endereço com complemento, contatos e a descrição em itens (o app separa por " · ").
function montarPedido() {
  const f = pedido.form;
  const hora = f.ate ? `ATÉ ${f.ate}` : '';
  const partes = [
    hora && `⏰ Entregar ${hora.toLowerCase()}`,
    f.troca && '🔁 TROCA / IDA E VOLTA: trazer de volta para a loja',
    f.cobrar && `💵 COBRAR NA ENTREGA: ${f.cobrar}`,
    `📦 ${f.item} (${f.volumes} volume${Number(f.volumes) > 1 ? 's' : ''})`,
    f.fragil && '⚠️ FRÁGIL',
    f.retirar && `🏬 Coleta: ${f.retirar}`,
    f.refer && `📍 Referência: ${f.refer}`,
    f.instrent && `🏁 Entrega: ${f.instrent}`,
    f.obs && `📝 ${f.obs}`,
  ].filter(Boolean);
  const base = pedido.entrega.base || pedido.entrega.endereco;
  return {
    nome: loja.nome, telefone: loja.telefone, requisito: f.tamanho, site: '',
    descricao: `Loja ${loja.nome} · ${partes.join(' · ')}`.slice(0, 1200),
    coleta: { ...pedido.coleta, contato: f.falar || `${loja.nome} ${loja.telefone}` },
    entrega: {
      endereco: (f.compl ? `${base} — ${f.compl}` : base).slice(0, 200),
      lat: pedido.entrega.lat, lon: pedido.entrega.lon, contato: `${f.recebe} ${f.telrecebe}`.slice(0, 120),
    },
  };
}

function telaConfirmar() {
  const mapaEl = h('div', { class: 'mapa' });
  const preco = h('div', { class: 'preco' });
  const linhas = { coleta: h('div', null), entrega: h('div', null) };
  const marcadores = {};
  let mapa = null;
  let alvo = null;

  const desenhar = () => {
    for (const [qual, letra] of [['coleta', 'C'], ['entrega', 'E']]) {
      const p = pedido[qual];
      trocar(linhas[qual], h('div', { class: 'linha-end' },
        h('div', { class: `ponto ${qual}` }, letra),
        h('div', null, p.endereco,
          p.lat == null && h('div', { class: 'falta' }, `Não achamos no mapa: toque no mapa para marcar a ${qual === 'coleta' ? 'saída' : 'entrega'}.`))));
    }
    alvo = pedido.coleta.lat == null ? 'coleta' : pedido.entrega.lat == null ? 'entrega' : null;
    trocar(preco,
      h('span', { class: 'nota' }, pedido.km != null ? `Distância: ${km(pedido.km)}` : 'Marque os dois pontos para ver o valor'),
      h('b', null, pedido.valor != null ? reais(pedido.valor) : pedido.km != null ? 'Valor a combinar' : ''),
      pedido.zona_sul && h('div', { class: 'aviso-sul' }, 'Inclui acréscimo da zona sul de Vila Velha.'),
      pedido.form?.troca && h('div', { class: 'aviso-sul' }, 'Troca / ida e volta: o valor da volta é somado na confirmação.'));
  };
  const recotar = async () => {
    try {
      const r = await api('POST', '/api/publico/cotar', { coleta: pedido.coleta, entrega: pedido.entrega, telefone: loja.telefone });
      Object.assign(pedido, { km: r.km, valor: r.valor, zona_sul: r.zona_sul });
    } catch { /* mantém o que tinha */ }
    if (loja.fixa !== false && pedido.coleta.lat != null) { loja.coleta = { ...pedido.coleta, contato: '' }; gravar(loja); }
    desenhar();
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

  const erro = h('div', { class: 'erro', role: 'alert' });
  const enviar = h('button', { class: 'primario', type: 'button' }, 'Confirmar entrega');
  enviar.onclick = async () => {
    erro.textContent = '';
    if (pedido.coleta.lat == null || pedido.entrega.lat == null) { erro.textContent = 'Marque a saída e a entrega no mapa.'; return; }
    enviar.disabled = true;
    enviar.textContent = 'Enviando…';
    try {
      const r = await api('POST', '/api/publico/pedidos', montarPedido());
      telaPronto(r);
    } catch (e) {
      erro.textContent = e.message;
      enviar.disabled = false;
      enviar.textContent = 'Confirmar entrega';
    }
  };

  moldura(
    h('h1', null, 'Confira o valor'),
    h('div', { class: 'cartao' },
      linhas.coleta, linhas.entrega, mapaEl,
      h('p', { class: 'nota' }, 'Ponto errado? Arraste o marcador para o lugar certo.'),
      preco, enviar, erro,
      h('button', { type: 'button', class: 'leve', onclick: () => telaEntrega() }, 'Voltar e corrigir')));

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
  desenhar();
}

function telaPronto(r) {
  const proximo = {
    whatsapp: 'Mandamos uma mensagem no WhatsApp da loja. Responda 1 para confirmar.',
    painel: 'Recebemos! Confirmamos em instantes e o motoboy sai pra buscar.',
    nenhuma: 'Já estamos chamando o motoboy.',
  }[r.confirmacao] || 'Recebemos o pedido.';
  pedido = null;
  moldura(
    h('h1', null, `Entrega #${r.id} recebida`),
    h('div', { class: 'cartao' },
      h('p', null, proximo),
      r.valor != null && h('div', { class: 'preco' }, h('span', { class: 'nota' }, 'Valor'), h('b', null, reais(r.valor))),
      h('a', { class: 'botao primario', href: `/acompanhar/?c=${encodeURIComponent(r.codigo)}` }, 'Acompanhar a entrega'),
      h('button', { type: 'button', class: 'leve', onclick: () => telaEntrega() }, 'Fazer outra entrega')));
}

try { info = await api('GET', '/api/publico/info'); } catch { /* usa o padrão */ }
document.title = `Entregas — ${info.empresa}`;
if (!info.ativo) {
  moldura(h('h1', null, 'Pedidos pelo site indisponíveis'), h('p', { class: 'nota' }, 'Fale com a gente pelo WhatsApp.'));
} else if (info.fechado) {
  moldura(h('h1', null, 'Estamos fechados agora'), h('p', { class: 'nota' }, `Nosso horário de atendimento: ${info.fechado}.`));
} else if (!loja?.coleta?.endereco) {
  telaLoja();
} else {
  telaEntrega();
}
