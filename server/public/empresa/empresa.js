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
  b.ler = () => Object.assign(b, { fornecedor: forn.value.trim(), endereco: end.el.value.trim(), oque: oque.value.trim(), tamanho: tam.value, falar: falar.value.trim() });
  return h('div', { class: 'cartao' },
    h('div', { class: 'cab-parada' }, h('b', null, total > 1 ? `Busca ${i + 1}` : 'Busca'),
      total > 1 && h('button', { type: 'button', class: 'pequeno', onclick: () => { buscas.forEach((x) => x.ler()); buscas.splice(i, 1); telaBuscas(); } }, 'Remover')),
    h('label', { for: n('forn') }, 'Fornecedor (onde buscar)'), forn,
    h('label', { for: n('end') }, 'Endereço do fornecedor'), end.nos,
    h('label', { for: n('oque') }, 'O que o motoboy vai buscar'), oque,
    h('label', { for: n('tam') }, 'Tamanho'), tam,
    h('label', { for: n('falar') }, 'Com quem falar no fornecedor'), falar);
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
      if (quem.value.trim().length < 2) { erro.textContent = 'Informe seu nome.'; quem.focus(); return; }
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
            k: chave, fornecedor: b.fornecedor, oque: b.oque, tamanho: b.tamanho, autoriza: quem.value.trim(),
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
  b.ler = () => Object.assign(b, { recebe: quem.value.trim(), endereco: end.el.value.trim(), fone: fone.value.trim(), oque: oque.value.trim(), tamanho: tam.value });
  return h('div', { class: 'cartao' },
    h('div', { class: 'cab-parada' }, h('b', null, total > 1 ? `Entrega ${i + 1}` : 'Entrega'),
      total > 1 && h('button', { type: 'button', class: 'pequeno', onclick: () => { envios.forEach((x) => x.ler()); envios.splice(i, 1); telaLoja(); } }, 'Remover')),
    h('label', { for: n('quem') }, 'Quem recebe'), quem,
    h('label', { for: n('end') }, 'Endereço de entrega (com número e apartamento)'), end.nos,
    h('label', { for: n('fone') }, 'Telefone de quem recebe'), fone,
    h('label', { for: n('oque') }, 'O que vai'), oque,
    h('label', { for: n('tam') }, 'Tamanho'), tam);
}

function telaLoja(mensagem = '') {
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
      if (quem.value.trim().length < 2) { erro.textContent = 'Informe seu nome.'; quem.focus(); return; }
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
            k: chave, recebe: b.recebe, fone: b.fone, oque: b.oque, tamanho: b.tamanho, autoriza: quem.value.trim(),
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
    h('div', { class: 'nota' }, 'O motoboy busca em:'), h('b', null, empresa.coleta?.endereco || '—'),
    h('div', { class: 'nota' }, `Cada entrega recebe um número e entra no fechamento ${empresa.fechamento === 'semanal' ? 'semanal' : 'do mês'} da ${empresa.nome}. Quem recebe não paga nada.`),
    h('button', { type: 'button', class: 'pequeno', onclick: () => telaEntregas() }, 'Ver minhas entregas e total')),
  envios.map((b, i, l) => cartaoEnvio(b, i, l.length)),
  h('div', { class: 'linha-mais', role: 'button', tabindex: 0, onclick: () => { envios.forEach((b) => b.ler()); envios.push({}); telaLoja(); } },
    h('span', { class: 'mais' }, '+'), 'Outra entrega'),
  h('div', { class: 'cartao' },
    h('label', { for: 'quem' }, 'Quem está pedindo'), quem,
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
          h('b', null, e.valor != null ? reais(e.valor) : '—')),
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
      h('p', null, ehLoja ? 'Recebemos! O motoboy já está sendo chamado.' : 'Recebemos! O motoboy já está sendo chamado. Na hora da retirada, ele informa o nome dele no fornecedor.'),
      feitos.map((f) => h('div', { class: 'linha-end' },
        h('b', null, `#${f.id}`),
        h('span', { class: 'cresce' }, [f.km != null ? km(f.km) : '', f.valor != null ? reais(f.valor) : ''].filter(Boolean).join(' · ') || 'valor na fatura'),
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
