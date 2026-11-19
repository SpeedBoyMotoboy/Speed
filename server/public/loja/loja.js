// Entrega para lojas (varejo): a loja cadastra uma vez nome, WhatsApp, saída e quem atende o motoboy.
// Depois só informa as entregas (uma ou várias paradas), vê o valor da tabela e confirma.
import { h, trocar, api, reais, km, camadaBase, icone } from '/site/base.js';

const L = window.L;
const raiz = document.getElementById('raiz');
const CHAVE = 'speed_loja';
let info = { empresa: 'SpeedBoy', ativo: true, fechado: '', mapa: { lat: -20.3358, lon: -40.2969 } };
let paradas = []; // dados digitados de cada entrega
let cotadas = null; // [{ coleta, entrega, km, valor, zona_sul }] na mesma ordem das paradas

// Regras que a loja aceita no cadastro. Mudou o texto: aumente a versão para pedir o aceite de novo.
const REGRAS_VERSAO = 1;
const REGRAS = [
  'Toda entrega precisa ser lançada aqui no sistema antes de sair com o motoboy. Cada entrega recebe um número de pedido.',
  'Entrega entregue ao motoboy sem lançamento no sistema é de responsabilidade da loja: a SpeedBoy não responde por atraso, dano, extravio ou qualquer problema nela.',
  'O motoboy é orientado a não sair com entrega que não esteja no sistema.',
  'Informe quando a entrega for frágil, para o motoboy ser avisado.',
];

const TAMANHOS = [
  ['pequeno', 'Pequeno — cabe na mochila', 'qualquer'],
  ['medio', 'Médio — até 20 cm', 'qualquer'],
  ['grande', 'Grande (G) — até 40 cm', 'bau'],
  ['maior', 'Gigante (GG) — mais de 40 cm', 'bau'],
];
const tamanho = (id) => TAMANHOS.find((t) => t[0] === id) || TAMANHOS[0];

const ler = () => { try { return JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch { return null; } };
const gravar = (l) => { try { localStorage.setItem(CHAVE, JSON.stringify(l)); } catch { /* sem armazenamento */ } };
let loja = ler();

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, 'SPEED', h('span', null, 'BOY')),
      h('div', { class: 'sub' }, loja?.nome ? `Entregas — ${loja.nome}` : 'Entrega para lojas'))),
    h('main', null, conteudo));
}

// Campo de endereço com sugestões do Google Maps (buscadas pelo servidor).
function campoEndereco(id, valor, aoEscolher) {
  const el = h('input', { id, maxlength: 200, required: true, autocomplete: 'off', placeholder: 'Comece a digitar: rua, número, bairro', value: valor || '' });
  const lista = h('div', { class: 'sugestoes', hidden: true });
  let espera = null;
  let ultima = '';
  el.addEventListener('input', () => {
    clearTimeout(espera);
    aoEscolher?.(null);
    const q = el.value.trim();
    if (q.length < 4) { lista.hidden = true; return; }
    espera = setTimeout(async () => {
      ultima = q;
      try {
        const r = await api('GET', `/api/publico/sugerir?q=${encodeURIComponent(q)}`);
        if (ultima !== q) return;
        trocar(lista, (r.sugestoes || []).map((s) => h('button', {
          type: 'button',
          onclick: () => { el.value = s; lista.hidden = true; aoEscolher?.(s); },
        }, s)));
        lista.hidden = !(r.sugestoes || []).length;
      } catch { lista.hidden = true; }
    }, 350);
  });
  el.addEventListener('blur', () => setTimeout(() => { lista.hidden = true; }, 200));
  return { el, nos: h('div', { class: 'com-sugestao' }, el, lista) };
}

// CNPJ: confere os dígitos verificadores.
function cnpjValido(c) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (const d of base) { soma += Number(d) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  return d1 === Number(c[12]) && dv(c.slice(0, 12) + d1) === Number(c[13]);
}
const fmtCnpj = (c) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

const campo = (id, rotulo, attrs = {}) => {
  const el = h('input', { id, maxlength: 160, ...attrs });
  return { el, nos: [h('label', { for: id }, rotulo), el] };
};

// Cadastro da loja (primeira vez ou "Trocar").
function telaLoja(mensagem = '') {
  const nome = campo('nome', 'Nome da loja', { required: true, placeholder: 'Ex.: KS Modas', value: loja?.nome || '' });
  const telefone = campo('telefone', 'WhatsApp da loja (com DDD)', { type: 'tel', inputmode: 'tel', required: true, placeholder: '(27) 99999-0000', value: loja?.telefone || '' });
  const saida = campoEndereco('saida', loja?.coleta?.endereco);
  const falar = campo('falar', 'Motoboy fala com quem na loja?', { required: true, placeholder: 'Nome e telefone', value: loja?.falar || '' });
  const retirar = campo('retirar', 'Como retirar (loja, piso, balcão, onde estacionar)', { placeholder: 'Ex.: loja 12, piso L2, retirar no caixa', value: loja?.retirar || '' });
  const fixa = h('input', { id: 'fixa', type: 'checkbox', checked: loja ? loja.fixa !== false : true });
  const querNf = h('input', { id: 'quernf', type: 'checkbox', checked: loja?.nf !== false });
  const cnpj = campo('cnpj', 'CNPJ para a nota fiscal', { inputmode: 'numeric', maxlength: 18, placeholder: '00.000.000/0000-00', value: loja?.nf?.cnpj || '' });
  const emailNf = campo('emailnf', 'E-mail para receber a nota (opcional)', { type: 'email', inputmode: 'email', maxlength: 120, value: loja?.nf?.email || '' });
  const aceite = h('input', { id: 'aceite', type: 'checkbox', checked: Boolean(loja?.aceite) });
  const blocoNf = h('div', { hidden: !querNf.checked }, cnpj.nos, emailNf.nos);
  querNf.addEventListener('change', () => { blocoNf.hidden = !querNf.checked; });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const form = h('form', {
    class: 'cartao',
    onsubmit: (ev) => {
      ev.preventDefault();
      if (nome.el.value.trim().length < 2) { erro.textContent = 'Informe o nome da loja.'; return; }
      if (telefone.el.value.replace(/\D/g, '').length < 10) { erro.textContent = 'Informe o WhatsApp com DDD.'; return; }
      if (saida.el.value.trim().length < 6) { erro.textContent = 'Escreva o endereço de saída com rua, número e bairro.'; return; }
      if (!aceite.checked) { erro.textContent = 'Para continuar, marque que leu e aceita as regras.'; aceite.focus(); return; }
      let nf = false;
      if (querNf.checked) {
        const c = cnpj.el.value.replace(/\D/g, '');
        if (!cnpjValido(c)) { erro.textContent = 'CNPJ inválido. Confira os números ou desmarque a nota fiscal.'; cnpj.el.focus(); return; }
        const em = emailNf.el.value.trim();
        if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { erro.textContent = 'E-mail da nota inválido.'; emailNf.el.focus(); return; }
        nf = { cnpj: fmtCnpj(c), email: em };
      }
      const mudou = saida.el.value.trim() !== (loja?.coleta?.endereco || '');
      loja = {
        nome: nome.el.value.trim(), telefone: telefone.el.value.trim(), fixa: fixa.checked,
        falar: falar.el.value.trim(), retirar: retirar.el.value.trim(), nf, aceite: REGRAS_VERSAO,
        coleta: mudou ? { endereco: saida.el.value.trim() } : loja.coleta,
      };
      gravar(loja);
      telaEntregas();
    },
  },
  nome.nos, telefone.nos,
  h('label', { for: 'saida' }, 'Endereço de saída (onde o motoboy busca)'), saida.nos,
  falar.nos, retirar.nos,
  h('label', { class: 'marcar', for: 'fixa' }, fixa, 'Usar sempre este endereço de saída'),
  h('h2', { class: 'secao' }, 'Nota fiscal'),
  h('label', { class: 'marcar', for: 'quernf' }, querNf, 'Precisa de nota fiscal das entregas'),
  blocoNf,
  h('h2', { class: 'secao' }, 'Regras'),
  h('ul', { class: 'regras' }, REGRAS.map((r) => h('li', null, r))),
  h('label', { class: 'marcar', for: 'aceite' }, aceite, 'Li e aceito as regras'),
  h('button', { class: 'primario', type: 'submit' }, 'Salvar e continuar'), erro);
  moldura(h('h1', null, loja ? 'Dados da loja e coleta' : 'Primeiro acesso'),
    h('p', { class: 'nota' }, 'Preencha só uma vez. Fica guardado neste aparelho.'), form);
  (loja ? saida.el : nome.el).focus({ preventScroll: true });
}

// Um cartão por entrega (parada).
function cartaoParada(p, i, total, aoRemover) {
  const n = (k) => `${k}${i}`;
  const end = campoEndereco(n('end'), p.endereco, () => {});
  const f = {
    endereco: end.el,
    compl: campo(n('compl'), 'Complemento', { placeholder: 'Apto, bloco, casa, sala', value: p.compl || '' }),
    refer: campo(n('refer'), 'Ponto de referência', { placeholder: 'Ex.: em frente à farmácia, portão azul', value: p.refer || '' }),
    recebe: campo(n('recebe'), 'Nome de quem recebe', { required: true, value: p.recebe || '' }),
    tel: campo(n('tel'), 'Telefone de quem recebe (com DDD)', { type: 'tel', inputmode: 'tel', required: true, placeholder: '(27) 99999-0000', value: p.tel || '' }),
    instr: campo(n('instr'), 'Instruções na entrega', { placeholder: 'Ex.: deixar na portaria, ligar ao chegar', value: p.instr || '' }),
    ate: campo(n('ate'), 'Entregar até (horário, se tiver)', { type: 'time', value: p.ate || '' }),
    cobrar: campo(n('cobrar'), 'Cobrar do cliente na entrega? (valor e forma)', { placeholder: 'Ex.: R$ 89,90 no Pix. Vazio = já está pago', value: p.cobrar || '' }),
  };
  const tam = h('select', { id: n('tam') }, TAMANHOS.map(([v, t]) => h('option', { value: v }, t)));
  tam.value = p.tamanho || 'pequeno';
  const troca = h('input', { id: n('troca'), type: 'checkbox', checked: Boolean(p.troca) });
  const fragil = h('input', { id: n('fragil'), type: 'checkbox', checked: Boolean(p.fragil) });
  const ler = () => Object.assign(p, {
    endereco: end.el.value.trim(), compl: f.compl.el.value.trim(), refer: f.refer.el.value.trim(),
    recebe: f.recebe.el.value.trim(), tel: f.tel.el.value.trim(), instr: f.instr.el.value.trim(),
    ate: f.ate.el.value, cobrar: f.cobrar.el.value.trim(), tamanho: tam.value, troca: troca.checked, fragil: fragil.checked,
  });
  const no = h('div', { class: 'cartao' },
    h('div', { class: 'cab-parada' }, h('h2', null, total > 1 ? `Entrega ${i + 1}` : 'Entrega'),
      total > 1 && h('button', { type: 'button', class: 'leve', onclick: () => { ler(); aoRemover(); } }, 'Remover')),
    h('label', { for: n('end') }, 'Endereço de entrega'), end.nos,
    f.compl.nos, f.refer.nos, f.recebe.nos, f.tel.nos, f.instr.nos, f.ate.nos,
    h('label', { for: n('tam') }, 'Tamanho da mercadoria'), tam,
    h('label', { class: 'marcar', for: n('fragil') }, fragil, 'Frágil — motoboy avisado para ter cuidado'),
    h('label', { class: 'marcar', for: n('troca') }, troca, 'Troca / ida e volta (motoboy traz algo de volta para a loja)'),
    f.cobrar.nos);
  return { no, ler, foco: () => end.el.focus({ preventScroll: true }) };
}

function telaEntregas(mensagem = '') {
  if (!paradas.length) paradas = [{}];
  const cartoes = paradas.map((p, i) => cartaoParada(p, i, paradas.length, () => {
    cartoes.forEach((c) => c.ler());
    paradas.splice(i, 1);
    telaEntregas();
  }));
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const seguir = h('button', { class: 'primario', type: 'submit' }, 'Ver valor');
  const mais = h('button', {
    type: 'button', class: 'mais', 'aria-label': 'Adicionar outra entrega',
    onclick: () => { cartoes.forEach((c) => c.ler()); paradas.push({}); telaEntregas(); },
  }, '+');

  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      cartoes.forEach((c) => c.ler());
      const ruim = paradas.findIndex((p) => p.tel.replace(/\D/g, '').length < 10);
      if (ruim >= 0) { erro.textContent = `Telefone de quem recebe com DDD (entrega ${ruim + 1}).`; return; }
      seguir.disabled = true;
      seguir.textContent = 'Calculando…';
      try {
        cotadas = [];
        for (const p of paradas) {
          const r = await api('POST', '/api/publico/cotar', { coleta: loja.coleta, entrega: { endereco: p.endereco }, telefone: loja.telefone, tamanho: p.tamanho });
          if (r.coleta.lat != null && loja.coleta.lat == null) { loja.coleta = { endereco: loja.coleta.endereco, lat: r.coleta.lat, lon: r.coleta.lon }; gravar(loja); }
          cotadas.push(r);
        }
        telaConfirmar();
      } catch (e) {
        erro.textContent = e.message;
        seguir.disabled = false;
        seguir.textContent = 'Ver valor';
      }
    },
  },
  cartoes.map((c) => c.no),
  h('div', { class: 'linha-mais' }, mais, h('span', null, 'Adicionar outra entrega')),
  seguir, erro);

  moldura(
    h('h1', null, 'Nova entrega'),
    h('div', { class: 'cartao saida' },
      h('div', null,
        h('div', { class: 'nota' }, 'Coleta'),
        h('b', null, loja.coleta?.endereco || ''),
        loja.falar && h('div', { class: 'nota' }, `Falar com: ${loja.falar}`),
        loja.nf && h('div', { class: 'nota' }, `Nota fiscal: CNPJ ${loja.nf.cnpj}`)),
      h('button', { type: 'button', class: 'leve', onclick: () => { cartoes.forEach((c) => c.ler()); telaLoja(); } }, 'Trocar')),
    form);
  cartoes[cartoes.length - 1].foco();
}

function telaConfirmar() {
  const mapaEl = h('div', { class: 'mapa' });
  const lista = h('div', null);
  const totalEl = h('div', { class: 'preco' });
  let mapa = null;

  const desenhar = () => {
    trocar(lista, cotadas.map((c, i) => h('div', { class: 'linha-end' },
      h('div', { class: 'ponto entrega' }, String(i + 1)),
      h('div', { class: 'cresce' }, c.entrega.endereco,
        c.entrega.lat == null && h('div', { class: 'falta' }, 'Não achamos no mapa. Volte e corrija o endereço.'),
        h('div', { class: 'nota' }, [c.km != null ? km(c.km) : '', tamanho(paradas[i].tamanho)[1]].filter(Boolean).join(' · ')),
        c.zona_sul && h('div', { class: 'aviso-sul' }, 'Inclui acréscimo da zona sul de Vila Velha.'),
        paradas[i].troca && h('div', { class: 'aviso-sul' }, 'Ida e volta: o valor da volta é somado na confirmação.'),
        c.tamanho_extra > 0 && h('div', { class: 'aviso-sul' }, `Inclui acréscimo de tamanho: ${reais(c.tamanho_extra)}.`)),
      h('b', null, c.valor != null ? reais(c.valor) : '—'))));
    const soma = cotadas.reduce((s, c) => s + (c.valor || 0), 0);
    trocar(totalEl, h('span', { class: 'nota' }, cotadas.length > 1 ? `Total (${cotadas.length} entregas)` : 'Valor'), h('b', null, reais(soma)));
  };

  const erro = h('div', { class: 'erro', role: 'alert' });
  const enviar = h('button', { class: 'primario', type: 'button' }, cotadas.length > 1 ? 'Confirmar entregas' : 'Confirmar entrega');
  enviar.onclick = async () => {
    erro.textContent = '';
    if (cotadas.some((c) => c.entrega.lat == null || c.coleta.lat == null)) { erro.textContent = 'Tem endereço que não achamos no mapa. Volte e corrija.'; return; }
    enviar.disabled = true;
    enviar.textContent = 'Enviando…';
    const feitos = [];
    try {
      for (let i = 0; i < cotadas.length; i++) feitos.push(await api('POST', '/api/publico/pedidos', montarPedido(i)));
      telaPronto(feitos);
    } catch (e) {
      if (feitos.length) { telaPronto(feitos, `Algumas entregas não foram enviadas: ${e.message}`); return; }
      erro.textContent = e.message;
      enviar.disabled = false;
      enviar.textContent = 'Confirmar';
    }
  };

  moldura(
    h('h1', null, 'Confira o valor'),
    h('div', { class: 'cartao' },
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto coleta' }, 'C'), h('div', null, loja.coleta.endereco)),
      lista, mapaEl,
      h('p', { class: 'nota' }, 'Ponto errado? Arraste o marcador para o lugar certo.'),
      totalEl, enviar, erro,
      h('button', { type: 'button', class: 'leve', onclick: () => telaEntregas() }, 'Voltar e corrigir')));

  mapa = L.map(mapaEl).setView([info.mapa.lat, info.mapa.lon], 12);
  camadaBase(L).addTo(mapa);
  const pontos = [];
  if (loja.coleta.lat != null) {
    L.marker([loja.coleta.lat, loja.coleta.lon], { icon: icone(L, 'ponto coleta', 'C') }).addTo(mapa);
    pontos.push([loja.coleta.lat, loja.coleta.lon]);
  }
  cotadas.forEach((c, i) => {
    if (c.entrega.lat == null) return;
    const m = L.marker([c.entrega.lat, c.entrega.lon], { icon: icone(L, 'ponto entrega', String(i + 1)), draggable: true }).addTo(mapa);
    m.on('dragend', async (ev) => {
      const pos = ev.target.getLatLng();
      c.entrega.lat = pos.lat;
      c.entrega.lon = pos.lng;
      try {
        const r = await api('POST', '/api/publico/cotar', { coleta: loja.coleta, entrega: c.entrega, telefone: loja.telefone, tamanho: paradas[i].tamanho });
        Object.assign(c, { km: r.km, valor: r.valor, zona_sul: r.zona_sul, tamanho_extra: r.tamanho_extra });
      } catch { /* mantém */ }
      desenhar();
    });
    pontos.push([c.entrega.lat, c.entrega.lon]);
  });
  if (pontos.length) mapa.fitBounds(pontos, { padding: [40, 40], maxZoom: 16 });
  desenhar();
}

// Junta a parada no formato do pedido: endereço com complemento, contatos e detalhes em itens (o app separa por " · ").
function montarPedido(i) {
  const p = paradas[i];
  const c = cotadas[i];
  const [, nomeTam, requisito] = tamanho(p.tamanho);
  const partes = [
    p.ate && `⏰ Entregar até ${p.ate}`,
    p.troca && '🔁 TROCA / IDA E VOLTA: trazer de volta para a loja',
    p.cobrar && `💵 COBRAR NA ENTREGA: ${p.cobrar}`,
    p.fragil && '⚠️ FRÁGIL: cuidado no transporte',
    `📏 ${nomeTam}`,
    loja.retirar && `🏬 Coleta: ${loja.retirar}`,
    p.refer && `📍 Referência: ${p.refer}`,
    p.instr && `🏁 Entrega: ${p.instr}`,
    cotadas.length > 1 && `🧭 Parada ${i + 1} de ${cotadas.length}`,
    loja.nf && `🧾 NOTA FISCAL: CNPJ ${loja.nf.cnpj}${loja.nf.email ? ` · ${loja.nf.email}` : ''}`,
  ].filter(Boolean);
  return {
    nome: loja.nome, telefone: loja.telefone, requisito, tamanho: p.tamanho, site: '', email: loja.nf?.email || '',
    descricao: `Loja ${loja.nome} · ${partes.join(' · ')}`.slice(0, 1200),
    coleta: { endereco: loja.coleta.endereco, lat: loja.coleta.lat, lon: loja.coleta.lon, contato: (loja.falar || `${loja.nome} ${loja.telefone}`).slice(0, 120) },
    entrega: {
      endereco: (p.compl ? `${c.entrega.endereco} — ${p.compl}` : c.entrega.endereco).slice(0, 200),
      lat: c.entrega.lat, lon: c.entrega.lon, contato: `${p.recebe} ${p.tel}`.slice(0, 120),
    },
  };
}

function telaPronto(feitos, aviso = '') {
  const r = feitos[0];
  const proximo = {
    whatsapp: 'Mandamos uma mensagem no WhatsApp da loja. Responda 1 para confirmar.',
    painel: 'Recebemos! Confirmamos em instantes e o motoboy sai pra buscar.',
    nenhuma: 'Já estamos chamando o motoboy.',
  }[r.confirmacao] || 'Recebemos o pedido.';
  paradas = [];
  cotadas = null;
  moldura(
    h('h1', null, feitos.length > 1 ? `${feitos.length} entregas recebidas` : `Entrega #${r.id} recebida`),
    h('div', { class: 'cartao' },
      h('p', null, proximo),
      aviso && h('div', { class: 'erro' }, aviso),
      feitos.map((f, i) => h('a', { class: 'botao', href: `/acompanhar/?c=${encodeURIComponent(f.codigo)}` },
        feitos.length > 1 ? `Acompanhar entrega ${i + 1} (#${f.id})` : 'Acompanhar a entrega')),
      h('button', { type: 'button', class: 'primario', onclick: () => telaEntregas() }, 'Fazer outra entrega')));
}

try { info = await api('GET', '/api/publico/info'); } catch { /* usa o padrão */ }
document.title = `Entregas — ${info.empresa}`;
if (!info.ativo) {
  moldura(h('h1', null, 'Pedidos pelo site indisponíveis'), h('p', { class: 'nota' }, 'Fale com a gente pelo WhatsApp.'));
} else if (info.fechado) {
  moldura(h('h1', null, 'Estamos fechados agora'), h('p', { class: 'nota' }, `Nosso horário de atendimento: ${info.fechado}.`));
} else if (!loja?.coleta?.endereco || !loja.falar || loja.nf === undefined || loja.aceite !== REGRAS_VERSAO) {
  telaLoja();
} else {
  telaEntregas();
}
