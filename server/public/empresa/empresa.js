// Buscas para empresa (link próprio /empresa/?k=CHAVE): a empresa só diz onde buscar e o que é.
// A entrega é sempre no endereço cadastrado dela; cada busca vira um pedido com número, na fatura do mês.
import { h, trocar, api, reais, km } from '/site/base.js';

const raiz = document.getElementById('raiz');
const chave = new URLSearchParams(location.search).get('k') || '';
const CHAVE_FORN = `speed_forn_${chave.slice(0, 8)}`;
const CHAVE_NOME = `speed_empresa_nome_${chave.slice(0, 8)}`;
let empresa = null;
let buscas = [];

const TAMANHOS = [
  ['pequeno', 'Pequeno — cabe na mochila'],
  ['medio', 'Médio — até 20 cm'],
  ['grande', 'Grande (G) — até 40 cm'],
  ['maior', 'Gigante (GG) — mais de 40 cm'],
];
const lerJson = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? padrao; } catch { return padrao; } };
const gravarJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
const fornecedores = () => lerJson(CHAVE_FORN, {});

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, 'SPEED', h('span', null, 'BOY')),
      h('div', { class: 'sub' }, empresa ? `${empresa.coleta ? 'Entregas' : 'Buscas'} — ${empresa.nome}` : 'Pedidos para empresas'))),
    h('main', null, conteudo));
}

// Campo de endereço com sugestões do Google Maps (buscadas pelo servidor).
function campoEndereco(id, valor) {
  const el = h('input', { id, maxlength: 200, autocomplete: 'off', placeholder: 'Rua, número, bairro, cidade', value: valor || '' });
  const lista = h('div', { class: 'sugestoes', hidden: true });
  let espera = null;
  let ultima = '';
  el.addEventListener('input', () => {
    clearTimeout(espera);
    const q = el.value.trim();
    if (q.length < 4) { lista.hidden = true; return; }
    espera = setTimeout(async () => {
      ultima = q;
      try {
        const r = await api('GET', `/api/publico/sugerir?q=${encodeURIComponent(q)}`);
        if (ultima !== q) return;
        trocar(lista, (r.sugestoes || []).map((s) => h('button', { type: 'button', onclick: () => { el.value = s; lista.hidden = true; } }, s)));
        lista.hidden = !(r.sugestoes || []).length;
      } catch { lista.hidden = true; }
    }, 350);
  });
  el.addEventListener('blur', () => setTimeout(() => { lista.hidden = true; }, 200));
  return { el, nos: h('div', { class: 'com-sugestao' }, el, lista) };
}

// Horário de cada pedido: sem horário, entregar até, coletar a partir de, ou agendar dia e hora.
function campoHorario(b, n) {
  const tipo = h('select', { id: n('htipo') }, [['', 'Sem horário — o quanto antes'], ['ate', 'Entregar até…'], ['apartir', 'Coletar a partir de…'], ['agendar', 'Agendar dia e hora']]
    .map(([v, t]) => h('option', { value: v }, t)));
  const hora = h('input', { id: n('hora'), type: 'time', value: b.hora || '' });
  const dia = h('input', { id: n('dia'), type: 'datetime-local', value: b.dia || '' });
  tipo.value = b.htipo || '';
  const ajustar = () => { hora.hidden = !['ate', 'apartir'].includes(tipo.value); dia.hidden = tipo.value !== 'agendar'; };
  tipo.addEventListener('change', ajustar);
  ajustar();
  return { nos: h('div', null, h('label', { for: n('htipo') }, 'Horário'), tipo, hora, dia), ler: () => ({ htipo: tipo.value, hora: hora.value, dia: dia.value }) };
}
const faltaHora = (b) => (['ate', 'apartir'].includes(b.htipo) && !b.hora) || (b.htipo === 'agendar' && !b.dia);
const corpoHorario = (b) => (b.htipo === 'agendar' ? { agendada_para: b.dia } : b.htipo ? { hora_tipo: b.htipo, hora: b.hora } : {});

function cartaoBusca(b, i, total) {
  const n = (x) => `b${i}-${x}`;
  const forn = h('input', { id: n('forn'), maxlength: 80, list: 'lista-forn', placeholder: 'Ex.: Sinai Material de Construção', value: b.fornecedor || '' });
  const end = campoEndereco(n('end'), b.endereco);
  forn.addEventListener('change', () => {
    const salvo = fornecedores()[forn.value.trim().toLowerCase()];
    if (salvo && !end.el.value.trim()) end.el.value = salvo;
  });
  const oque = h('input', { id: n('oque'), maxlength: 300, placeholder: 'Ex.: 2 rolamentos e 1 correia (nota já faturada)', value: b.oque || '' });
  const tam = h('select', { id: n('tam') }, TAMANHOS.map(([v, t]) => h('option', { value: v }, t)));
  tam.value = b.tamanho || 'pequeno';
  const falar = h('input', { id: n('falar'), maxlength: 120, placeholder: 'Ex.: balcão, falar com Carlos (opcional)', value: b.falar || '' });
  const hor = campoHorario(b, n);
  b.ler = () => Object.assign(b, { fornecedor: forn.value.trim(), endereco: end.el.value.trim(), oque: oque.value.trim(), tamanho: tam.value, falar: falar.value.trim() }, hor.ler());
  return h('div', { class: 'cartao' },
    h('div', { class: 'cab-parada' }, h('b', null, total > 1 ? `Busca ${i + 1}` : 'Busca'),
      total > 1 && h('button', { type: 'button', class: 'pequeno', onclick: () => { buscas.forEach((x) => x.ler()); buscas.splice(i, 1); telaBuscas(); } }, 'Remover')),
    h('label', { for: n('forn') }, 'Fornecedor (onde buscar)'), forn,
    h('label', { for: n('end') }, 'Endereço do fornecedor'), end.nos,
    h('label', { for: n('oque') }, 'O que o motoboy vai buscar'), oque,
    h('label', { for: n('tam') }, 'Tamanho'), tam,
    h('label', { for: n('falar') }, 'Com quem falar no fornecedor'), falar, hor.nos);
}

function telaBuscas(mensagem = '') {
  if (!buscas.length) buscas.push({});
  const quem = h('input', { id: 'quem', maxlength: 80, placeholder: 'Seu nome', value: lerJson(CHAVE_NOME, '') });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const enviar = h('button', { type: 'submit', class: 'primario' }, 'Enviar para o motoboy');
  const listaForn = h('datalist', { id: 'lista-forn' }, Object.keys(fornecedores()).map((f) => h('option', { value: f })));
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      buscas.forEach((b) => b.ler());
      const ruim = buscas.findIndex((b) => b.endereco.length < 6 || b.oque.length < 2);
      if (ruim >= 0) { erro.textContent = `Preencha o endereço do fornecedor e o que buscar (busca ${ruim + 1}).`; return; }
      const semHora = buscas.findIndex(faltaHora);
      if (semHora >= 0) { erro.textContent = `Informe o horário (busca ${semHora + 1}).`; return; }
      if (quem.value.trim().length < 2) { erro.textContent = 'Informe o nome do vendedor.'; quem.focus(); return; }
      gravarJson(CHAVE_NOME, quem.value.trim());
      const salvos = fornecedores();
      buscas.forEach((b) => { if (b.fornecedor) salvos[b.fornecedor.toLowerCase()] = b.endereco; });
      gravarJson(CHAVE_FORN, salvos);
      enviar.disabled = true;
      enviar.textContent = 'Enviando…';
      const feitos = [];
      try {
        for (const b of buscas) {
          feitos.push(await api('POST', '/api/publico/empresa/pedidos', {
            k: chave, fornecedor: b.fornecedor, oque: b.oque, tamanho: b.tamanho, autoriza: quem.value.trim(), ...corpoHorario(b),
            coleta: { endereco: b.fornecedor ? `${b.fornecedor} · ${b.endereco}` : b.endereco, contato: b.falar },
          }));
        }
        buscas = [];
        telaPronto(feitos);
      } catch (e) {
        erro.textContent = feitos.length ? `${feitos.length} busca(s) enviada(s). As outras deram erro: ${e.message}` : e.message;
        enviar.disabled = false;
        enviar.textContent = 'Enviar para o motoboy';
      }
    },
  },
  h('h1', null, 'Nova busca'),
  h('div', { class: 'cartao' },
    h('div', { class: 'nota' }, 'Entrega em:'), h('b', null, empresa.entrega?.endereco || '—'),
    h('div', { class: 'nota' }, `Cada busca recebe um número e entra na fatura ${empresa.fechamento === 'semanal' ? 'semanal' : 'do mês'} da ${empresa.nome}. O motoboy sai assim que você enviar.`),
    h('button', { type: 'button', class: 'pequeno', onclick: () => telaEntregas() }, 'Ver minhas buscas e total')),
  buscas.map((b, i, l) => cartaoBusca(b, i, l.length)),
  h('div', { class: 'linha-mais', role: 'button', tabindex: 0, onclick: () => { buscas.forEach((b) => b.ler()); buscas.push({}); telaBuscas(); } },
    h('span', { class: 'mais' }, '+'), 'Outra busca'),
  h('div', { class: 'cartao' },
    h('label', { for: 'quem' }, 'Quem está pedindo (o motoboy fala esse nome no fornecedor, se precisar)'), quem,
    erro, enviar),
  listaForn);
  moldura(form);
}


// ── Loja com coleta fixa (ex.: Enxoval): a loja só diz para onde vai e quem recebe ──
const CHAVE_DEST = `speed_dest_${chave.slice(0, 8)}`;
const destinos = () => lerJson(CHAVE_DEST, {});
let envios = [];

function cartaoEnvio(b, i, total) {
  const n = (x) => `e${i}-${x}`;
  const quem = h('input', { id: n('quem'), maxlength: 80, list: 'lista-dest', placeholder: 'Nome de quem recebe', value: b.recebe || '' });
  const end = campoEndereco(n('end'), b.endereco);
  const fone = h('input', { id: n('fone'), maxlength: 30, inputmode: 'tel', placeholder: '(27) 99999-9999', value: b.fone || '' });
  quem.addEventListener('change', () => {
    const s = destinos()[quem.value.trim().toLowerCase()];
    if (!s) return;
    if (!end.el.value.trim()) end.el.value = s.endereco || '';
    if (!fone.value.trim()) fone.value = s.fone || '';
  });
  const oque = h('input', { id: n('oque'), maxlength: 300, placeholder: 'Ex.: 1 sacola com jogo de cama (opcional)', value: b.oque || '' });
  const tam = h('select', { id: n('tam') }, TAMANHOS.map(([v, t]) => h('option', { value: v }, t)));
  tam.value = b.tamanho || 'pequeno';
  const hor = campoHorario(b, n);
  b.ler = () => Object.assign(b, { recebe: quem.value.trim(), endereco: end.el.value.trim(), fone: fone.value.trim(), oque: oque.value.trim(), tamanho: tam.value }, hor.ler());
  return h('div', { class: 'cartao' },
    h('div', { class: 'cab-parada' }, h('b', null, total > 1 ? `Entrega ${i + 1}` : 'Entrega'),
      total > 1 && h('button', { type: 'button', class: 'pequeno', onclick: () => { envios.forEach((x) => x.ler()); envios.splice(i, 1); telaLoja(); } }, 'Remover')),
    h('label', { for: n('quem') }, 'Quem recebe'), quem,
    h('label', { for: n('end') }, 'Endereço de entrega (com número e apartamento)'), end.nos,
    h('label', { for: n('fone') }, 'Telefone de quem recebe'), fone,
    h('label', { for: n('oque') }, 'O que vai'), oque,
    h('label', { for: n('tam') }, 'Tamanho'), tam, hor.nos);
}

// ── Entrega paga pelo cliente: a loja diz as mercadorias e manda um link; o cliente completa e paga ──
let clientePaga = false; // começa sempre desmarcado
const TAM_VOL = [['p', 'P', 'cabe na mão'], ['m', 'M', 'caixa de sapato'], ['g', 'G', 'até 40 cm'], ['gg', 'GG', 'mais de 40 cm']];

function contadorVolumes(b) {
  b.volumes = b.volumes || { p: 0, m: 0, g: 0, gg: 0 };
  const resumo = h('div', { class: 'nota' });
  const atualizar = () => {
    const total = TAM_VOL.reduce((s, [k]) => s + b.volumes[k], 0);
    const maior = [...TAM_VOL].reverse().find(([k]) => b.volumes[k] > 0);
    resumo.textContent = total ? `Total: ${total} volume(s) · maior: ${maior[1]}` : 'Toque no + do tamanho de cada mercadoria.';
  };
  const linhas = TAM_VOL.map(([k, t, dica]) => {
    const n = h('b', { class: 'qtd' }, String(b.volumes[k]));
    const mudar = (d) => { b.volumes[k] = Math.max(0, Math.min(99, b.volumes[k] + d)); n.textContent = String(b.volumes[k]); atualizar(); };
    return h('div', { class: 'contador' },
      h('span', { class: 'cresce' }, h('b', null, t), ' ', h('span', { class: 'nota' }, `(${dica})`)),
      h('button', { type: 'button', class: 'pequeno', 'aria-label': `menos ${t}`, onclick: () => mudar(-1) }, '–'), n,
      h('button', { type: 'button', class: 'pequeno', 'aria-label': `mais ${t}`, onclick: () => mudar(1) }, '+'));
  });
  atualizar();
  return [h('label', null, 'Quantas mercadorias?'), ...linhas, resumo];
}

// Assistente em 3 passos: 1) retirada e volumes, 2) quem preenche (cartões), 3) dados ou link pronto.
let assist = { passo: 1, quem: '', b: {} };
const ICONE_ENVIAR = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
const ICONE_LAPIS = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
function icone(svg) { const s = h('span', { class: 'icone-cartao' }); s.innerHTML = svg; return s; }

function barraPassos() {
  const nomes = ['Volumes', 'Quem preenche', 'Link'];
  return h('div', { class: 'passos-loja' },
    h('div', { class: 'barras' }, [1, 2, 3].map((n) => h('span', { class: n <= assist.passo ? 'feita' : '' }))),
    h('div', { class: 'nota' }, `Passo ${assist.passo} de 3 · ${nomes[assist.passo - 1]}`));
}

function passoVolumes(erro) {
  const b = assist.b;
  b.coleta = b.coleta ?? (empresa.coleta?.endereco || '');
  const campoColeta = h('input', { id: 'coleta', maxlength: 200, value: b.coleta, hidden: !b.editandoColeta, 'aria-label': 'Endereço de retirada' });
  const textoColeta = h('b', { hidden: Boolean(b.editandoColeta) }, b.coleta || '—');
  const editar = h('button', { type: 'button', class: 'pequeno' }, b.editandoColeta ? 'Pronto' : 'Editar');
  editar.onclick = () => { b.coleta = campoColeta.value.trim() || b.coleta; b.editandoColeta = !b.editandoColeta; telaConvite(); };
  const oque = h('input', { id: 'oque', maxlength: 300, placeholder: 'Ex.: 1 edredom e 2 almofadas (opcional)', value: b.oque || '' });
  const seguir = h('button', { type: 'button', class: 'primario' }, 'Continuar');
  seguir.onclick = () => {
    b.coleta = campoColeta.value.trim() || b.coleta;
    b.oque = oque.value.trim();
    if (!Object.values(b.volumes || {}).some((x) => x > 0)) { erro.textContent = 'Toque no + do tamanho das mercadorias.'; return; }
    assist.passo = 2;
    telaConvite();
  };
  return [
    h('div', { class: 'cartao' },
      h('div', { class: 'linha-end' }, h('div', { class: 'cresce' }, h('div', { class: 'nota' }, 'Retirada'), textoColeta, campoColeta), editar)),
    h('div', { class: 'cartao' }, ...contadorVolumes(b), h('label', { for: 'oque' }, 'O que vai'), oque),
    erro, seguir,
  ];
}

function passoQuem() {
  const cartao = (quem, svg, titulo, texto) => h('button', {
    type: 'button', class: `cartao-escolha${assist.quem === quem ? ' sel' : ''}`, 'aria-pressed': assist.quem === quem ? 'true' : 'false',
    onclick: () => { assist.quem = quem; assist.passo = 3; telaConvite(); },
  }, icone(svg), h('b', null, titulo), h('span', { class: 'nota' }, texto));
  return [
    h('h2', null, 'Quem preenche os dados do cliente?'),
    h('div', { class: 'grade-escolha' },
      cartao('cliente', ICONE_ENVIAR, 'Cliente preenche', 'Você manda o link e ele completa endereço, nota e pagamento.'),
      cartao('loja', ICONE_LAPIS, `${empresa.nome} preenche`, 'Você já tem nome, endereço e WhatsApp do cliente.')),
    h('button', { type: 'button', onclick: () => { assist.passo = 1; telaConvite(); } }, 'Voltar'),
  ];
}

async function gerarConvite(erro, botao, quem) {
  const b = assist.b;
  if (quem.value.trim().length < 2) { erro.textContent = 'Informe o nome do vendedor.'; quem.focus(); return; }
  gravarJson(CHAVE_NOME, quem.value.trim());
  botao.disabled = true;
  botao.textContent = 'Gerando…';
  const daLoja = assist.quem === 'loja';
  try {
    const r = await api('POST', '/api/publico/empresa/convites', {
      k: chave, autoriza: quem.value.trim(), volumes: b.volumes, oque: b.oque, coleta: b.coleta,
      recebe: daLoja ? b.recebe : '', fone: daLoja ? b.fone : '', endereco: daLoja ? b.endereco : '',
    });
    const feito = { ...r, link: r.link.startsWith('http') ? r.link : `${location.origin}${r.link}`, recebe: daLoja ? b.recebe : '', fone: daLoja ? b.fone : '' };
    assist = { passo: 1, quem: '', b: {} };
    telaLinks([feito]);
  } catch (e) {
    erro.textContent = e.message;
    botao.disabled = false;
    botao.textContent = 'Gerar link para o cliente';
  }
}

function passoFinal(erro) {
  const b = assist.b;
  const quem = h('input', { id: 'quem', maxlength: 80, placeholder: 'Seu nome', value: lerJson(CHAVE_NOME, '') });
  const gerar = h('button', { type: 'button', class: 'primario' }, 'Gerar link para o cliente');
  const partes = [];
  if (assist.quem === 'loja') {
    const nome = h('input', { id: 'c-quem', maxlength: 80, list: 'lista-dest', placeholder: 'Nome de quem recebe', value: b.recebe || '' });
    const end = campoEndereco('c-end', b.endereco);
    const fone = h('input', { id: 'c-fone', maxlength: 30, inputmode: 'tel', placeholder: '(27) 99999-0000', value: b.fone || '' });
    nome.addEventListener('change', () => {
      const sv = destinos()[nome.value.trim().toLowerCase()];
      if (sv) { if (!end.el.value.trim()) end.el.value = sv.endereco || ''; if (!fone.value.trim()) fone.value = sv.fone || ''; }
    });
    gerar.onclick = () => {
      Object.assign(b, { recebe: nome.value.trim(), endereco: end.el.value.trim(), fone: fone.value.trim() });
      if (b.recebe) { const sv = destinos(); sv[b.recebe.toLowerCase()] = { endereco: b.endereco, fone: b.fone }; gravarJson(CHAVE_DEST, sv); }
      gerarConvite(erro, gerar, quem);
    };
    partes.push(h('div', { class: 'cartao' },
      h('b', null, 'Dados do cliente'),
      h('div', { class: 'nota' }, 'O cliente ainda confere tudo no link, escolhe na rota ou urgente e paga.'),
      h('label', { for: 'c-quem' }, 'Nome'), nome,
      h('label', { for: 'c-end' }, 'Endereço de entrega'), end.nos,
      h('label', { for: 'c-fone' }, 'WhatsApp'), fone),
      h('datalist', { id: 'lista-dest' }, Object.keys(destinos()).map((f) => h('option', { value: f }))));
  } else {
    gerar.onclick = () => gerarConvite(erro, gerar, quem);
    partes.push(h('div', { class: 'cartao' },
      h('b', null, 'O cliente preenche'),
      h('div', { class: 'nota' }, 'Ao gerar, você recebe o link para mandar. Ele completa endereço e nota fiscal, escolhe na rota ou urgente e paga por Pix.')));
  }
  return [...partes,
    h('div', { class: 'cartao' }, h('label', { for: 'quem' }, 'Vendedor'), quem),
    erro, gerar,
    h('button', { type: 'button', onclick: () => { assist.passo = 2; telaConvite(); } }, 'Voltar')];
}

function telaLinks(feitos) {
  moldura(
    h('h1', null, feitos.length > 1 ? `${feitos.length} links prontos` : 'Link pronto'),
    h('p', { class: 'nota' }, 'Mande para o cliente. Ele completa os dados, escolhe na rota ou urgente, vê o valor e paga por Pix. O motoboy só busca depois do pagamento confirmado.'),
    feitos.map((f, i) => {
      const texto = `Olá! Seu pedido está pronto. Para combinar a entrega com a SpeedBoy, é só abrir este link, conferir o endereço e escolher como prefere receber: ${f.link}`;
      const copiar = h('button', { type: 'button', class: 'primario', onclick: async () => { try { await navigator.clipboard.writeText(f.link); copiar.textContent = 'Link copiado ✓'; } catch { /* copia manual */ } } }, 'Copiar link');
      const zap = f.fone ? `https://wa.me/55${f.fone.replace(/\D/g, '').replace(/^55/, '')}?text=${encodeURIComponent(texto)}` : `https://wa.me/?text=${encodeURIComponent(texto)}`;
      return h('div', { class: 'aviso-quarta' },
        h('b', null, `${feitos.length > 1 ? `Cliente ${i + 1}` : 'Cliente'}${f.recebe ? ` · ${f.recebe}` : ''} · ${f.volumes}`),
        h('input', { readonly: true, value: f.link, onfocus: (ev) => ev.target.select() }),
        h('div', { class: 'botoes' }, copiar, h('a', { class: 'botao', target: '_blank', rel: 'noopener noreferrer', href: zap }, 'Mandar pelo WhatsApp')));
    }),
    h('button', { type: 'button', class: 'primario', onclick: () => { clientePaga = false; telaLoja(); } }, 'Fazer outra entrega'));
}

function interruptorClientePaga() {
  const caixa = h('input', { type: 'checkbox', id: 'cliente-paga', checked: clientePaga });
  caixa.onchange = () => {
    if (!clientePaga) envios.forEach((b) => b.ler?.());
    clientePaga = caixa.checked;
    telaLoja();
  };
  return h('label', { class: 'marcar destaque' }, caixa, h('b', null, ' Entrega paga pelo cliente'));
}

function telaConvite(mensagem = '') {
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const corpo = assist.passo === 1 ? passoVolumes(erro) : assist.passo === 2 ? passoQuem() : passoFinal(erro);
  moldura(
    h('h1', null, 'Nova entrega'),
    h('div', { class: 'cartao' }, interruptorClientePaga(), barraPassos()),
    ...corpo);
}

function telaLoja(mensagem = '') {
  if (clientePaga) return telaConvite(mensagem);
  if (!envios.length) envios.push({});
  const quem = h('input', { id: 'quem', maxlength: 80, placeholder: 'Seu nome', value: lerJson(CHAVE_NOME, '') });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const enviar = h('button', { type: 'submit', class: 'primario' }, 'Chamar motoboy');
  const lista = h('datalist', { id: 'lista-dest' }, Object.keys(destinos()).map((f) => h('option', { value: f })));
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      envios.forEach((b) => b.ler());
      const ruim = envios.findIndex((b) => b.endereco.length < 6 || b.recebe.length < 2);
      if (ruim >= 0) { erro.textContent = `Preencha quem recebe e o endereço com número (entrega ${ruim + 1}).`; return; }
      const semHora = envios.findIndex(faltaHora);
      if (semHora >= 0) { erro.textContent = `Informe o horário (entrega ${semHora + 1}).`; return; }
      if (quem.value.trim().length < 2) { erro.textContent = 'Informe o nome do vendedor.'; quem.focus(); return; }
      gravarJson(CHAVE_NOME, quem.value.trim());
      const salvos = destinos();
      envios.forEach((b) => { salvos[b.recebe.toLowerCase()] = { endereco: b.endereco, fone: b.fone }; });
      gravarJson(CHAVE_DEST, salvos);
      enviar.disabled = true;
      enviar.textContent = 'Enviando…';
      const feitos = [];
      try {
        for (const b of envios) {
          feitos.push(await api('POST', '/api/publico/empresa/pedidos', {
            k: chave, recebe: b.recebe, fone: b.fone, oque: b.oque, tamanho: b.tamanho, autoriza: quem.value.trim(), ...corpoHorario(b),
            entrega: { endereco: b.endereco },
          }));
        }
        envios = [];
        telaPronto(feitos, 'loja');
      } catch (e) {
        erro.textContent = feitos.length ? `${feitos.length} entrega(s) enviada(s). As outras deram erro: ${e.message}` : e.message;
        enviar.disabled = false;
        enviar.textContent = 'Chamar motoboy';
      }
    },
  },
  h('h1', null, 'Nova entrega'),
  h('div', { class: 'cartao' },
    interruptorClientePaga(),
    h('div', { class: 'nota' }, 'O motoboy busca em:'), h('b', null, empresa.coleta?.endereco || '—'),
    h('div', { class: 'nota' }, `Cada entrega recebe um número e entra no fechamento ${empresa.fechamento === 'semanal' ? 'semanal' : 'do mês'} da ${empresa.nome}. Quem recebe não paga nada.`),
    h('button', { type: 'button', class: 'pequeno', onclick: () => telaEntregas() }, 'Ver minhas entregas e total')),
  envios.map((b, i, l) => cartaoEnvio(b, i, l.length)),
  h('div', { class: 'linha-mais', role: 'button', tabindex: 0, onclick: () => { envios.forEach((b) => b.ler()); envios.push({}); telaLoja(); } },
    h('span', { class: 'mais' }, '+'), 'Outra entrega'),
  h('div', { class: 'cartao' },
    h('label', { for: 'quem' }, 'Vendedor'), quem,
    erro, enviar),
  lista);
  moldura(form);
}

// ── Minhas entregas (a planilha do fechamento) ──
const PERIODOS = [['semana', 'Esta semana'], ['passada', 'Semana passada'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado']];
const SITUACAO = { aguardando: 'Chamando motoboy', sem_local: 'Conferindo endereço', atribuida: 'Motoboy indo buscar', coletada: 'A caminho', entregue: 'Entregue', cancelada: 'Cancelada' };
const quando = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

async function telaEntregas(periodo = '') {
  const voltar = () => (empresa.coleta ? telaLoja() : telaBuscas());
  moldura(h('h1', null, 'Minhas entregas'), h('p', { class: 'nota' }, 'Carregando…'));
  let r;
  try {
    r = await api('GET', `/api/publico/empresa/entregas?k=${encodeURIComponent(chave)}&periodo=${encodeURIComponent(periodo)}`);
  } catch (e) {
    moldura(h('h1', null, 'Minhas entregas'), h('p', { class: 'erro' }, e.message), h('button', { type: 'button', onclick: voltar }, 'Voltar'));
    return;
  }
  const loja = Boolean(empresa.coleta);
  const baixar = () => {
    const t = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const cab = ['Pedido', 'Data', loja ? 'Destino' : 'Fornecedor', 'Recebedor', 'Km', 'Situação', 'Valor'];
    const linhas = r.entregas.map((e) => [e.id, quando(e.criado_em), t(loja ? e.para : e.de), t(e.quem), e.km != null ? String(e.km).replace('.', ',') : '',
      e.retida ? 'Em análise' : SITUACAO[e.status] || e.status, e.valor != null ? String(e.valor).replace('.', ',') : ''].join(';'));
    linhas.push(['', '', '', '', '', 'TOTAL', String(r.total).replace('.', ',')].join(';'));
    const blob = new Blob([`﻿${[cab.join(';'), ...linhas].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `entregas-${r.periodo}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  };
  moldura(
    h('h1', null, 'Minhas entregas'),
    h('div', { class: 'linha' }, PERIODOS.map(([v, t]) => h('button', { type: 'button', class: v === r.periodo ? 'primario pequeno' : 'pequeno', onclick: () => telaEntregas(v) }, t))),
    h('div', { class: 'cartao' },
      h('b', null, `${r.quantidade} entrega(s) · Total ${reais(r.total)}`),
      h('div', { class: 'nota' }, `Fechamento ${empresa.fechamento === 'semanal' ? 'semanal' : 'mensal'}. Canceladas não entram no total.`)),
    r.entregas.length
      ? r.entregas.map((e) => h('div', { class: 'cartao' },
        h('div', { class: 'linha-end' }, h('b', null, `#${e.id}`), h('span', { class: 'cresce' }, quando(e.criado_em)),
          h('b', null, e.cliente_paga ? 'cliente paga' : e.valor != null ? reais(e.valor) : '—')),
        h('div', null, loja ? `🏁 ${e.para || '—'}` : `📦 ${e.de || '—'}`),
        e.quem && h('div', { class: 'nota' }, e.quem),
        h('div', { class: 'linha-end' }, h('span', { class: 'cresce nota' }, e.retida ? 'Em análise' : SITUACAO[e.status] || e.status),
          e.codigo && e.status !== 'cancelada' && h('a', { class: 'botao', href: `/acompanhar/?c=${encodeURIComponent(e.codigo)}` }, 'Acompanhar'))))
      : h('p', { class: 'nota' }, 'Nenhuma entrega neste período.'),
    h('div', { class: 'linha' },
      r.entregas.length > 0 && h('button', { type: 'button', onclick: baixar }, 'Baixar planilha'),
      h('button', { type: 'button', class: 'primario', onclick: voltar }, loja ? 'Nova entrega' : 'Nova busca')));
}

function telaPronto(feitos, modo = '') {
  const ehLoja = modo === 'loja';
  const nome = ehLoja ? ['entrega', 'entregas', 'Entrega'] : ['busca', 'buscas', 'Busca'];
  moldura(
    h('h1', null, feitos.length > 1 ? `${feitos.length} ${nome[1]} enviadas` : `${nome[2]} #${feitos[0].id} enviada`),
    h('div', { class: 'cartao' },
      h('p', null, feitos.every((f) => f.cliente_paga) ? 'Recebemos! Agora mande o link de pagamento para o cliente.'
        : ehLoja ? 'Recebemos! O motoboy já está sendo chamado.' : 'Recebemos! O motoboy já está sendo chamado. Na hora da retirada, ele informa o nome dele no fornecedor.'),
      feitos.filter((f) => f.cliente_paga).map((f) => {
        const link = `${location.origin}/acompanhar/?c=${encodeURIComponent(f.codigo)}`;
        const texto = `Olá! Segue o link para pagar o frete da sua entrega${f.valor != null ? ` (${reais(f.valor)})` : ''} por Pix. O motoboy sai assim que o pagamento for conferido: ${link}`;
        const copiar = h('button', { type: 'button', class: 'primario', onclick: async () => { try { await navigator.clipboard.writeText(link); copiar.textContent = 'Link copiado ✓'; } catch { /* copia manual */ } } }, 'Copiar link de pagamento');
        return h('div', { class: 'aviso-quarta' },
          h('b', null, `Entrega #${f.id}: o cliente paga${f.valor != null ? ` ${reais(f.valor)}` : ''}`),
          h('div', null, f.valor != null ? 'Mande este link para o cliente. O motoboy só é chamado depois do Pix conferido.' : 'Não achamos o endereço no mapa. A SpeedBoy confere e o valor aparece neste mesmo link.'),
          h('input', { readonly: true, value: link, onfocus: (ev) => ev.target.select() }),
          h('div', { class: 'botoes' }, copiar,
            h('a', { class: 'botao', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/?text=${encodeURIComponent(texto)}` }, 'Mandar pelo WhatsApp')));
      }),
      feitos.map((f) => h('div', { class: 'linha-end' },
        h('b', null, `#${f.id}`),
        h('span', { class: 'cresce' }, [f.km != null ? km(f.km) : '', f.valor != null ? reais(f.valor) : ''].filter(Boolean).join(' · ') || (f.cliente_paga ? 'valor a confirmar' : 'valor na fatura')),
        h('a', { class: 'botao', href: `/acompanhar/?c=${encodeURIComponent(f.codigo)}` }, 'Acompanhar'))),
      h('button', { type: 'button', class: 'primario', onclick: () => (ehLoja ? telaLoja() : telaBuscas()) }, ehLoja ? 'Fazer outra entrega' : 'Fazer outra busca'),
      h('button', { type: 'button', onclick: () => telaEntregas() }, 'Ver minhas entregas e total')));
}

try {
  empresa = await api('GET', `/api/publico/empresa?k=${encodeURIComponent(chave)}`);
  document.title = `${empresa.coleta ? 'Entregas' : 'Buscas'} — ${empresa.nome}`;
  if (empresa.coleta) telaLoja(); else telaBuscas();
} catch (e) {
  moldura(h('h1', null, 'Link inválido'), h('p', { class: 'nota' }, e.message || 'Peça o link certo à SpeedBoy.'));
}
