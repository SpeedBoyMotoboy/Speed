// Painel do administrador. Sem framework: DOM montado por h(), nunca por innerHTML
// (endereços e nomes vêm de fora e não podem virar HTML).
const L = window.L;
const raiz = document.getElementById('raiz');

function h(tag, attrs, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f == null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}
// Troca o conteúdo aceitando listas e itens vazios (como o h()).
function trocar(el, ...filhos) {
  el.replaceChildren(...filhos.flat(Infinity).filter((f) => f != null && f !== false));
}

class ErroApi extends Error {
  constructor(status, corpo) {
    super(corpo?.mensagem || 'Falha de comunicação com o servidor.');
    this.status = status;
    this.codigo = corpo?.erro;
  }
}
async function api(metodo, caminho, corpo) {
  const r = await fetch(caminho, {
    method: metodo,
    credentials: 'same-origin',
    headers: { 'X-Speed': '1', ...(metodo === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    body: metodo === 'GET' ? undefined : JSON.stringify(corpo || {}),
  });
  const json = await r.json().catch(() => null);
  if (r.status === 401 && !caminho.endsWith('/login')) { telaLogin(); throw new ErroApi(401, json); }
  if (!r.ok) throw new ErroApi(r.status, json);
  return json;
}

// ------------------------------------------------------------ formatação
const doisDig = (n) => String(n).padStart(2, '0');
const hora = (ts) => { const d = new Date(ts); return `${doisDig(d.getHours())}:${doisDig(d.getMinutes())}`; };
const duracao = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${doisDig(min % 60)}`;
};
const ha = (ts, agora) => {
  const s = Math.max(0, Math.round((agora - ts) / 1000));
  return s < 90 ? `há ${s} s` : `há ${duracao(agora - ts)}`;
};
const dataHora = (ts) => { const d = new Date(ts); return `${doisDig(d.getDate())}/${doisDig(d.getMonth() + 1)} ${hora(ts)}`; };
const telefoneFmt = (t) => t.replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const iniciais = (nome) => nome.trim().split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase();

const ROTULO_STATUS = {
  disponivel: 'Disponível', em_rota: 'Em rota', almoco: 'Almoço', sem_sinal: 'Sem sinal',
  sem_local: 'Sem local', aguardando: 'Aguardando', atribuida: 'A coletar', coletada: 'Em entrega',
  entregue: 'Entregue', cancelada: 'Cancelada',
};
const ROTULO_ALERTA = {
  problema: 'Problema na entrega', parado: 'Parado na rota', sem_sinal: 'Sem sinal', gps_falso: 'GPS falso', gps_desligado: 'GPS desligado',
  salto: 'Salto de posição', fora_do_local: 'Confirmou longe do local', troca_aparelho: 'Trocou de aparelho',
  carga_pendente: 'Turno encerrado com carga',
};
const ROTULO_REQUISITO = { qualquer: 'Qualquer', moto: 'Só moto', bau: 'Baú', bag: 'Bag' };
const ROTULO_ORIGEM = { empresa: 'Empresa', site: 'Site', robo: 'WhatsApp', whatsapp: 'WhatsApp', api: 'API' };
const chip = (texto, classe = '') => h('span', { class: `chip ${classe}` }, texto);
const equipamento = (m) => [m.veiculo === 'bike' ? 'Bike' : 'Moto', m.tem_bau && 'baú', m.tem_bag && 'bag', m.tipo === 'avulso' ? 'avulso' : 'diária'].filter(Boolean).join(' · ');

// ---------------------------------------------------------------- diálogo
function dialogo(titulo, montar, { largo = false } = {}) {
  const erro = h('div', { class: 'erro', role: 'alert' });
  const dlg = h('dialog', { class: largo ? 'largo' : '' });
  const fechar = () => { dlg.close(); dlg.remove(); };
  const corpo = h('div', { class: 'corpo' }, h('h2', null, titulo));
  dlg.append(corpo);
  const ctx = {
    fechar,
    erro: (e) => { erro.textContent = e?.message || String(e || ''); },
    // Roda a ação; se der certo fecha e atualiza a tela, se der errado mostra o motivo.
    executar: async (fn, botao) => {
      erro.textContent = '';
      if (botao) botao.disabled = true;
      try { await fn(); fechar(); atualizar(); if (abaAtual === 'whatsapp') desenharWhatsapp(); } catch (e) { erro.textContent = e.message; } finally { if (botao) botao.disabled = false; }
    },
  };
  corpo.append(...[montar(ctx)].flat(Infinity).filter((f) => f != null && f !== false), erro);
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return ctx;
}
function confirmar(titulo, texto, rotulo, acao, perigo = true) {
  dialogo(titulo, (d) => {
    const ok = h('button', { class: perigo ? 'perigo' : 'primario', onclick: () => d.executar(acao, ok) }, rotulo);
    return [h('p', null, texto), h('div', { class: 'linha fim' }, h('button', { onclick: d.fechar }, 'Voltar'), ok)];
  });
}

// ------------------------------------------------------------------ login
function telaLogin() {
  pararAtualizacao();
  const usuario = h('input', { autocomplete: 'username', required: true });
  const senha = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      try {
        await api('POST', '/api/admin/login', { usuario: usuario.value, senha: senha.value });
        telaPrincipal();
      } catch (e) { erro.textContent = e.message; }
    },
  },
  h('h1', null, 'Speed ', h('span', null, 'Despacho')),
  h('label', null, 'Usuário'), usuario,
  h('label', null, 'Senha'), senha,
  h('button', { class: 'primario', type: 'submit' }, 'Entrar'), erro);
  trocar(raiz, h('div', { class: 'login' }, form));
  usuario.focus();
}

// ------------------------------------------------------------ estrutura
let estado = null;
let abaAtual = 'operacao';
let temporizador = null;
let mapa = null;
let camadas = null;
let trilhaAberta = null; // { turnoId, nome }
let enquadrado = false;
const els = {};
// Gavetas (<details>) abertas pelo usuário continuam abertas quando a tela se atualiza.
const gavetas = new Map();
function gaveta(chave, abertaPadrao, atributos, ...filhos) {
  return h('details', {
    ...atributos,
    open: gavetas.has(chave) ? gavetas.get(chave) : abertaPadrao,
    ontoggle: (ev) => gavetas.set(chave, ev.currentTarget.open),
  }, ...filhos);
}
let demandaFocada = null; // id da demanda destacada no mapa
let escolhendoPara = null; // id da demanda com a lista de motoboys aberta
function kmEntre(a, b) {
  const r = Math.PI / 180;
  const x = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
async function designar(demanda, motoboyId) {
  try {
    await api('POST', `/api/admin/demandas/${demanda.id}/atribuir`, { motoboy_id: motoboyId || null });
    escolhendoPara = null;
    mapa.closePopup();
  } catch (e) { els.conexao.textContent = e.message; }
  atualizar();
}
function focarDemanda(d) {
  demandaFocada = demandaFocada === d.id ? null : d.id;
  desenharMapa();
  desenharLateral();
  if (demandaFocada == null || d.coleta_lat == null) return;
  const pts = [[d.coleta_lat, d.coleta_lon], [d.entrega_lat, d.entrega_lon]].filter((p) => p[0] != null);
  mapa.fitBounds(pts, { padding: [60, 60], maxZoom: 16 });
}

function pararAtualizacao() { clearInterval(temporizador); temporizador = null; }

function telaPrincipal() {
  const abas = [['operacao', 'Operação'], ['motoboys', 'Motoboys'], ['whatsapp', 'WhatsApp'], ['ia', 'IA'], ['relatorio', 'Relatório'], ['config', 'Configurações']];
  els.conexao = h('span', { class: 'conexao' });
  els.botoesAba = abas.map(([id, nome]) => h('button', { 'data-aba': id, onclick: () => abrirAba(id) }, nome));
  els.mapa = h('div', { id: 'mapa' });
  els.lateral = h('div', { class: 'lateral' });
  els.operacao = h('div', { class: 'operacao' }, els.mapa, els.lateral);
  els.pagina = h('div', { class: 'pagina' });
  trocar(raiz, 
    h('div', { class: 'topo' },
      h('div', { class: 'logo' }, 'Speed ', h('span', null, 'Despacho')),
      h('nav', { class: 'abas' }, els.botoesAba), h('div', { class: 'espaco' }), els.conexao,
      h('button', { onclick: async () => { await api('POST', '/api/admin/logout').catch(() => {}); telaLogin(); } }, 'Sair')),
    els.operacao, els.pagina);

  mapa = L.map(els.mapa, { zoomControl: true }).setView([-20.3358, -40.2969], 12); // Vila Velha/ES até o estado chegar
  camadaBase().addTo(mapa);
  camadas = { trilha: L.layerGroup().addTo(mapa), demandas: L.layerGroup().addTo(mapa), motoboys: L.layerGroup().addTo(mapa) };
  enquadrado = false;
  abrirAba('operacao');
  pararAtualizacao();
  temporizador = setInterval(atualizar, 5000);
  atualizar();
}
function camadaBase() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© colaboradores do OpenStreetMap',
  });
}

function abrirAba(id) {
  abaAtual = id;
  for (const b of els.botoesAba) b.classList.toggle('ativa', b.dataset.aba === id);
  els.operacao.hidden = id !== 'operacao';
  els.operacao.style.display = id === 'operacao' ? '' : 'none';
  els.pagina.style.display = id === 'operacao' ? 'none' : '';
  if (id === 'operacao') { mapa.invalidateSize(); desenhar(); }
  if (id === 'motoboys') desenharMotoboys();
  if (id === 'relatorio') desenharRelatorio();
  if (id === 'whatsapp') desenharWhatsapp();
  if (id === 'ia') desenharIa();
  if (id === 'config') desenharConfig();
}

// Aviso sonoro quando chega demanda, alerta ou cliente pedindo atendente.
let somCtx = null;
let vistos = null;
function bipe() {
  try {
    somCtx = somCtx || new AudioContext();
    const o = somCtx.createOscillator();
    const g = somCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, somCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, somCtx.currentTime + 0.5);
    o.connect(g).connect(somCtx.destination);
    o.start();
    o.stop(somCtx.currentTime + 0.5);
  } catch { /* navegador sem som liberado */ }
}
function notarNovidades() {
  const agora = new Set([
    ...estado.demandas.filter((d) => ['sem_local', 'aguardando'].includes(d.status)).map((d) => `d${d.id}`),
    ...estado.alertas.filter((a) => a.fim == null).map((a) => `a${a.id}`),
    ...(estado.whatsapp.pendentes ? [`w${estado.whatsapp.pendentes}`] : []),
  ]);
  if (vistos && [...agora].some((k) => !vistos.has(k))) bipe();
  vistos = agora;
  const n = estado.demandas.filter((d) => d.retida && !['entregue', 'cancelada'].includes(d.status)).length + estado.whatsapp.pendentes;
  document.title = `${n ? `(${n}) ` : ''}Speed Despacho`;
  const aba = els.botoesAba.find((b) => b.dataset.aba === 'whatsapp');
  aba.textContent = estado.whatsapp.pendentes ? `WhatsApp (${estado.whatsapp.pendentes})` : 'WhatsApp';
}

async function atualizar() {
  try {
    estado = await api('GET', '/api/admin/estado');
    els.conexao.textContent = estado.whatsapp.falhas ? `WhatsApp: ${estado.whatsapp.falhas} mensagem(ns) não enviada(s)` : '';
    notarNovidades();
  } catch (e) {
    if (e.status !== 401) els.conexao.textContent = 'Sem conexão com o servidor';
    return;
  }
  // Não redesenha por cima de quem está digitando ou com janela aberta.
  if (document.querySelector('dialog[open]')) return;
  if (abaAtual === 'operacao') desenhar();
  if (abaAtual === 'motoboys') desenharMotoboys();
  if (abaAtual === 'whatsapp') els.recarregarWhats?.();
}

// --------------------------------------------------------------- operação
function desenhar() {
  if (!estado) return;
  // Com um balão aberto no mapa (ex.: designar motoboy), não redesenha o mapa para não fechar o balão.
  if (!(mapa._popup && mapa.hasLayer(mapa._popup))) desenharMapa();
  desenharLateral();
}

function icone(classe, texto, tamanho) {
  return L.divIcon({ className: '', html: h('div', { class: classe, style: null }, texto), iconSize: [tamanho, tamanho], iconAnchor: [tamanho / 2, tamanho / 2] });
}
function dimensionar(ic, tamanho) {
  ic.options.html.style.width = `${tamanho}px`;
  ic.options.html.style.height = `${tamanho}px`;
  return ic;
}

function desenharMapa() {
  camadas.motoboys.clearLayers();
  camadas.demandas.clearLayers();
  const limites = [];
  const alertados = new Set(estado.alertas.filter((a) => a.fim == null).map((a) => a.motoboy_id));
  const nomes = new Map(estado.motoboys.map((m) => [m.id, m.nome]));

  for (const d of estado.demandas) {
    if (!['aguardando', 'atribuida', 'coletada'].includes(d.status) || d.coleta_lat == null) continue;
    const focada = d.id === demandaFocada;
    if (demandaFocada != null && !focada) continue; // com uma demanda em foco, só ela aparece
    const coleta = [d.coleta_lat, d.coleta_lon];
    const entrega = [d.entrega_lat, d.entrega_lon];
    const umPonto = kmEntre(coleta, entrega) < 0.05;
    const info = () => h('div', null,
      h('b', null, `#${d.id} ${d.cliente}`), h('br'),
      `Coleta: ${d.coleta_endereco}`, h('br'), `Entrega: ${d.entrega_endereco}`, h('br'),
      d.motoboy_id ? `Motoboy: ${nomes.get(d.motoboy_id) || '—'}` : 'Aguardando motoboy');
    if (d.status !== 'coletada' && !umPonto) {
      L.marker(coleta, { icon: dimensionar(icone(`ponto ${d.status === 'aguardando' ? 'espera' : 'coleta'}`, 'C', 22), 22) })
        .bindPopup(info).addTo(camadas.demandas);
      limites.push(coleta);
    }
    L.marker(entrega, { icon: dimensionar(icone('ponto entrega', umPonto ? '●' : 'E', focada ? 28 : 22), focada ? 28 : 22) }).bindPopup(info).addTo(camadas.demandas);
    if (!umPonto) L.polyline([coleta, entrega], { color: focada ? '#ff5400' : '#7c3aed', weight: focada ? 4 : 2, dashArray: '5 6', opacity: focada ? 0.95 : 0.7 }).addTo(camadas.demandas);
    limites.push(entrega);
  }

  for (const m of estado.motoboys) {
    const t = m.turno;
    if (!t || t.lat == null) continue;
    const classe = `pino ${t.status}${alertados.has(m.id) ? ' alertado' : ''}`;
    L.marker([t.lat, t.lon], { icon: dimensionar(icone(classe, iniciais(m.nome), 34), 34), zIndexOffset: 500 })
      .bindPopup(() => {
        // Demandas ainda sem motoboy, da mais perto para a mais longe dele.
        const livres = estado.demandas
          .filter((d) => ['aguardando'].includes(d.status) && d.coleta_lat != null)
          .map((d) => ({ d, km: kmEntre([t.lat, t.lon], [d.coleta_lat, d.coleta_lon]) }))
          .sort((a, b) => a.km - b.km).slice(0, 6);
        return h('div', null,
          h('b', null, m.nome), h('br'), `${ROTULO_STATUS[t.status]} · ${t.pendentes} parada(s)`, h('br'),
          `Último sinal ${ha(t.ult_contato ?? t.inicio, estado.agora)}`,
          livres.length ? [h('div', { style: 'margin-top:6px;font-weight:600' }, 'Designar para:'),
            livres.map(({ d, km }) => h('div', { style: 'margin-top:4px' },
              h('button', { class: 'pequeno primario', onclick: () => designar(d, m.id) }, `#${d.id}`),
              ` ${d.cliente} · ${km.toFixed(1)} km`, d.retida ? ' (aprova junto)' : ''))]
            : h('div', { class: 'sub', style: 'margin-top:6px' }, 'Nenhuma demanda esperando motoboy.'));
      })
      .addTo(camadas.motoboys);
    limites.push([t.lat, t.lon]);
  }

  if (!enquadrado) {
    enquadrado = true;
    // Ponto localizado errado (ex.: endereço sem cidade achado em outro estado) não arrasta o mapa para longe.
    const centro = [estado.mapa.lat, estado.mapa.lon];
    const perto = limites.filter((p) => kmEntre(centro, p) < 150);
    if (perto.length) mapa.fitBounds(perto, { padding: [40, 40], maxZoom: 15 });
    else mapa.setView([estado.mapa.lat, estado.mapa.lon], 12);
  }
}

function desenharLateral() {
  const { agora } = estado;
  const emTurno = estado.motoboys.filter((m) => m.turno);
  const nomes = new Map(estado.motoboys.map((m) => [m.id, m.nome]));
  const abertas = estado.demandas.filter((d) => ['atribuida', 'coletada'].includes(d.status));
  const retidas = estado.demandas.filter((d) => d.retida && ['aguardando', 'sem_local'].includes(d.status));
  const fila = estado.demandas.filter((d) => d.status === 'aguardando' && !d.retida);
  const semLocal = estado.demandas.filter((d) => d.status === 'sem_local' && !d.retida);
  const fechadas = estado.demandas.filter((d) => ['entregue', 'cancelada'].includes(d.status));
  const alertasAbertos = estado.alertas.filter((a) => a.fim == null);
  const alertasHoje = estado.alertas.filter((a) => a.fim != null);

  const cartaoAlerta = (a) => h('div', { class: `cartao ${a.fim == null ? 'alerta' : ''}` },
    h('div', { class: 'titulo' }, `${ROTULO_ALERTA[a.tipo] || a.tipo} — ${a.motoboy}`),
    h('div', { class: 'sub' },
      a.fim == null ? `Começou ${hora(a.inicio)} (${ha(a.inicio, agora)})`
        : a.fim === a.inicio ? `Às ${hora(a.inicio)}` : `${hora(a.inicio)} a ${hora(a.fim)} (${duracao(a.fim - a.inicio)})`),
    a.detalhe && h('div', { class: 'sub' }, a.detalhe));

  const listaMotoboys = (d) => {
    const ref = d.coleta_lat != null ? [d.coleta_lat, d.coleta_lon] : null;
    const lista = emTurno.filter((m) => m.turno)
      .map((m) => ({ m, km: ref && m.turno.lat != null ? kmEntre(ref, [m.turno.lat, m.turno.lon]) : null }))
      .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9));
    return h('div', { class: 'escolha-motoboy' },
      d.status === 'coletada' && h('div', { class: 'sub' }, 'Atenção: a carga já foi coletada. O novo motoboy precisa pegar com o anterior.'),
      lista.length ? lista.map(({ m, km }) => h('div', { class: 'linha-motoboy' },
        h('span', null, h('b', null, m.nome), ` · ${equipamento(m)} · ${m.turno.pendentes} parada(s)${km != null ? ` · ${km.toFixed(1)} km da coleta` : ''}`),
        h('button', { class: 'pequeno primario', onclick: () => designar(d, m.id) }, m.id === d.motoboy_id ? 'Manter' : 'Designar')))
        : h('div', { class: 'vazio' }, 'Ninguém em turno agora. Convoque na aba Motoboys.'),
      h('div', { class: 'acoes' },
        h('button', { class: 'pequeno', onclick: () => designar(d, null) }, 'Automático'),
        h('button', { class: 'pequeno', onclick: () => { escolhendoPara = null; desenharLateral(); } }, 'Fechar')));
  };

  const cartaoDemanda = (d) => h('div', {
    class: `cartao clicavel${d.id === demandaFocada ? ' focada' : ''}`,
    title: 'Clique para ver no mapa',
    onclick: (ev) => { if (!ev.target.closest('button, a, select, input, details')) focarDemanda(d); },
  },
    h('div', { class: 'titulo' }, `#${d.id} ${d.cliente}`, chip(ROTULO_STATUS[d.status], d.status),
      d.requisito !== 'qualquer' && chip(ROTULO_REQUISITO[d.requisito]),
      d.urgente ? chip('Urgente', 'sem_sinal') : null,
      ROTULO_ORIGEM[d.origem] && chip(ROTULO_ORIGEM[d.origem]),
      d.valor != null && chip(reais(d.valor), 'entregue'),
      d.pagamento === 'pago' && chip('Pago', 'entregue'),
      d.pagamento === 'pendente' && chip(d.comprovante_em ? 'Comprovante enviado' : 'Esperando Pix', 'aguardando'),
      d.ia_ok === 0 && chip('IA: conferir', 'sem_sinal'),
      d.pagamento === 'faturado' && chip('Fatura')),
    (d.servico || d.repasse != null) && h('div', { class: 'sub' },
      [d.servico, d.repasse != null && `repasse avulso ${reais(d.repasse)}`,
        d.status === 'aguardando' && !d.retida && `oferecida a ${d.ofertas} motoboy(s)`].filter(Boolean).join(' · ')),
    h('div', { class: 'sub' }, `C: ${d.coleta_endereco}`),
    h('div', { class: 'sub' }, `E: ${d.entrega_endereco}`),
    d.descricao && h('div', { class: 'sub' }, d.descricao),
    h('div', { class: 'sub' },
      d.motoboy_id ? `${nomes.get(d.motoboy_id) || '—'} · ` : '',
      d.status === 'entregue' ? `entregue ${hora(d.entregue_em)} para ${d.recebedor || '—'}`
        : d.status === 'cancelada' ? `cancelada ${hora(d.cancelada_em)}`
          : d.status === 'coletada' ? `coletada ${hora(d.coletada_em)}`
            : `criada ${hora(d.criada_em)} (${ha(d.criada_em, agora)})`),
    d.status === 'entregue' && h('div', { class: 'acoes' }, d.foto_em
      ? h('button', { class: 'pequeno', onclick: () => verFoto(d) }, '📷 Ver foto da entrega')
      : chip('Sem foto', 'aguardando')),
    d.ia_obs && h('div', { class: 'sub' }, `IA: ${d.ia_obs}`),
    d.cliente_telefone && h('div', { class: 'sub' }, `Cliente: ${telefoneFmt(d.cliente_telefone)}`),
    !['entregue', 'cancelada'].includes(d.status) && h('div', { class: 'acoes' },
      d.pagamento === 'pendente' && h('button', {
        class: 'pequeno primario',
        onclick: () => confirmar('Confirmar pagamento', `O Pix de ${d.valor != null ? reais(d.valor) : '—'} do pedido #${d.id} (${d.cliente}) já caiu na sua conta? Ao confirmar, o pedido é liberado aos motoboys. Confira no app do banco, não só no comprovante.`,
          'Sim, o Pix caiu', () => api('POST', `/api/admin/demandas/${d.id}/pago`), false),
      }, 'Confirmar pagamento'),
      Boolean(d.retida) && d.status !== 'sem_local' && d.pagamento !== 'pendente' && h('button', {
        class: 'pequeno primario',
        onclick: async () => {
          try {
            const r = await api('POST', `/api/admin/demandas/${d.id}/liberar`);
            if (r.resultado === 'cobrar') dialogo('Pedido aprovado', (dlg) => [h('p', null, 'O cliente recebe o Pix agora. O pedido sai para os motoboys quando o pagamento for confirmado.'), h('div', { class: 'linha fim' }, h('button', { class: 'primario', onclick: dlg.fechar }, 'Entendi'))]);
          } catch (e) { els.conexao.textContent = e.message; }
          atualizar();
        },
      }, 'Aprovar'),
      d.status === 'sem_local'
        ? h('button', { class: 'pequeno primario', onclick: () => janelaDemanda(d) }, 'Marcar no mapa')
        : h('button', { class: 'pequeno', onclick: () => janelaEscolher(d) }, d.motoboy_id ? 'Trocar motoboy' : 'Escolher motoboy'),
      d.status === 'aguardando' && !d.motoboy_id && d.repasse != null && h('button', { class: 'pequeno', onclick: () => compartilharDemanda(d) }, 'Compartilhar'),
      d.status !== 'sem_local' && h('button', { class: 'pequeno', onclick: () => janelaDemanda(d) }, 'Editar'),
      d.coleta_lat != null && h('button', {
        class: 'pequeno', title: 'Outro pedido com a mesma coleta e o mesmo cliente: é só marcar o novo destino.',
        onclick: () => janelaDemanda(null, {
          titulo: `Nova entrega com a coleta do #${d.id}`, cliente: d.cliente, requisito: d.requisito, descricao: d.descricao, telefone: d.cliente_telefone,
          coleta: { endereco: d.coleta_endereco, contato: d.coleta_contato, lat: d.coleta_lat, lon: d.coleta_lon },
        }),
      }, '+ Entrega'),
      !['pago', 'pendente'].includes(d.pagamento) && h('button', { class: 'pequeno', onclick: () => janelaValor(d) }, 'Valor'),
      d.codigo && h('button', { class: 'pequeno', onclick: () => linkCliente(d) }, 'Link do cliente'),
      d.codigo && ['aguardando', 'atribuida'].includes(d.status) && h('button', {
        class: 'pequeno', title: 'O cliente passa a ver o motoboy no mapa desde agora (depois da coleta já é automático).',
        onclick: () => localizacaoCliente(d),
      }, d.rastreio_livre ? '📍 Reenviar localização' : '📍 Localização p/ cliente'),
      h('button', { class: 'pequeno', onclick: () => janelaFinalizar(d) }, 'Finalizar'),
      h('button', {
        class: 'pequeno perigo',
        onclick: () => confirmar('Cancelar demanda', `Cancelar a demanda #${d.id} de ${d.cliente}?`, 'Cancelar demanda',
          () => api('POST', `/api/admin/demandas/${d.id}/cancelar`)),
      }, 'Cancelar')),
    escolhendoPara === d.id && !['entregue', 'cancelada'].includes(d.status) && listaMotoboys(d));

  const cartaoMotoboy = (m) => {
    const t = m.turno;
    return h('div', { class: 'cartao' },
      h('div', { class: 'titulo' }, m.nome, chip(ROTULO_STATUS[t.status], t.status),
        m.tipo === 'avulso' && chip('avulso'),
        t.origem !== 'app' && chip('navegador', 'aguardando')),
      h('div', { class: 'sub' }, `${equipamento(m)} · ${t.pendentes} parada(s) · ${t.km} km`,
        t.bateria != null ? ` · bateria ${t.bateria}%` : ''),
      h('div', { class: 'sub' }, `${m.tipo === 'avulso' ? `Online desde ${hora(t.inicio)}` : `Turno ${hora(t.inicio)}–${hora(t.fim_previsto)}`} · último sinal ${ha(t.ult_contato ?? t.inicio, agora)}`,
        t.almoco_ate ? ` · almoço até ${hora(t.almoco_ate)}` : ''),
      h('div', { class: 'acoes' },
        t.lat != null && h('button', { class: 'pequeno', onclick: () => { mapa.setView([t.lat, t.lon], 16); } }, 'Ver no mapa'),
        h('button', { class: 'pequeno', onclick: () => abrirTrilha(t.id, m.nome) }, 'Trajeto de hoje'),
        h('button', {
          class: 'pequeno perigo',
          onclick: () => confirmar('Encerrar turno', `Encerrar agora o turno de ${m.nome}? O rastreamento para e as demandas não coletadas voltam para a fila.`,
            'Encerrar turno', () => api('POST', `/api/admin/turnos/${t.id}/encerrar`)),
        }, 'Encerrar turno')));
  };

  trocar(els.lateral, 
    h('div', { class: 'resumo' },
      h('div', null, h('b', null, emTurno.length), h('span', null, 'em turno')),
      h('div', null, h('b', null, abertas.length), h('span', null, 'em andamento')),
      h('div', null, h('b', null, fila.length + semLocal.length + retidas.length), h('span', null, 'aguardando'))),
    h('button', { class: 'primario', onclick: () => janelaDemanda() }, '+ Nova demanda'),

    estado.pendencias.length > 0 && gaveta('pendencias', !estado.motoboys.length, { class: 'cartao sugestao' },
      h('summary', null, `Falta configurar (${estado.pendencias.length})`),
      h('ul', { class: 'lista' }, estado.pendencias.map((t) => h('li', null, t))),
      h('div', { class: 'acoes' }, h('button', { class: 'pequeno', onclick: () => abrirAba('config') }, 'Abrir Configurações'))),

    estado.whatsapp.pendentes > 0 && h('div', { class: 'cartao alerta' },
      h('div', { class: 'titulo' }, `${estado.whatsapp.pendentes} cliente(s) esperando atendente no WhatsApp`),
      h('div', { class: 'acoes' }, h('button', { class: 'pequeno primario', onclick: () => abrirAba('whatsapp') }, 'Responder'))),

    retidas.length > 0 && [h('h3', null, `Esperando pagamento ou aprovação (${retidas.length})`), retidas.map(cartaoDemanda)],

    trilhaAberta && h('div', { class: 'cartao' },
      h('div', { class: 'titulo' }, `Trajeto: ${trilhaAberta.nome}`),
      h('div', { class: 'sub' }, trilhaAberta.resumo),
      h('div', { class: 'acoes' }, h('button', { class: 'pequeno', onclick: fecharTrilha }, 'Fechar trajeto'))),

    estado.sugestoes.length > 0 && [
      h('h3', null, 'Sugestão de convocação'),
      estado.sugestoes.map((s) => h('div', { class: 'cartao sugestao' },
        h('div', { class: 'titulo' }, `Convocar ${s.nome}`),
        h('div', { class: 'sub' }, `${s.demandas.length} demanda(s) esperando e ninguém em turno para atender. Vez dele no rodízio.`),
        h('div', { class: 'acoes' }, h('button', { class: 'pequeno primario', onclick: () => convocar(s.motoboy_id) }, 'Convocar')))),
    ],

    h('h3', null, `Alertas abertos (${alertasAbertos.length})`),
    alertasAbertos.length ? alertasAbertos.map(cartaoAlerta) : h('div', { class: 'vazio' }, 'Nenhum alerta agora.'),
    alertasHoje.length > 0 && gaveta('alertas_hoje', false, null, h('summary', null, `Alertas encerrados hoje (${alertasHoje.length})`), alertasHoje.map(cartaoAlerta)),

    semLocal.length > 0 && [h('h3', null, 'Sem local no mapa'), semLocal.map(cartaoDemanda)],
    h('h3', null, `Aguardando motoboy (${fila.length})`),
    fila.length ? fila.map(cartaoDemanda) : h('div', { class: 'vazio' }, 'Nada na fila.'),
    h('h3', null, `Em andamento (${abertas.length})`),
    abertas.length ? abertas.map(cartaoDemanda) : h('div', { class: 'vazio' }, 'Nenhuma entrega em andamento.'),
    fechadas.length > 0 && gaveta('finalizadas', false, null, h('summary', null, `Finalizadas hoje (${fechadas.length})`), fechadas.map(cartaoDemanda)),

    h('h3', null, `Motoboys em turno (${emTurno.length})`),
    emTurno.length ? emTurno.map((m) => [cartaoMotoboy(m), entregasDe(m)]) : h('div', { class: 'vazio' }, 'Ninguém em turno. Convoque na aba Motoboys.'));
}

async function abrirTrilha(turnoId, nome) {
  try {
    const t = await api('GET', `/api/admin/turnos/${turnoId}/trilha`);
    camadas.trilha.clearLayers();
    const linha = t.pontos.map((p) => [p.lat, p.lon]);
    if (linha.length) {
      L.polyline(linha, { color: '#111318', weight: 4, opacity: 0.75 }).addTo(camadas.trilha);
      mapa.fitBounds(linha, { padding: [40, 40], maxZoom: 16 });
    }
    const parado = t.alertas.filter((a) => a.tipo === 'parado')
      .reduce((soma, a) => soma + ((a.fim ?? Date.now()) - a.inicio), 0);
    trilhaAberta = { turnoId, nome, resumo: `${t.pontos.length} pontos · ${t.turno.km.toFixed(1)} km · parado em alerta ${duracao(parado)} · ${t.alertas.length} alerta(s)` };
    desenharLateral();
  } catch (e) { els.conexao.textContent = e.message; }
}
function fecharTrilha() { trilhaAberta = null; camadas.trilha.clearLayers(); desenharLateral(); }

// ----------------------------------------------------- janelas de demanda
function janelaTrocar(d) {
  const emTurno = estado.motoboys.filter((m) => m.turno);
  dialogo(`Demanda #${d.id} — escolher motoboy`, (dlg) => {
    const sel = h('select', null,
      h('option', { value: '' }, 'Automático (sistema escolhe o melhor)'),
      emTurno.map((m) => h('option', { value: m.id, selected: m.id === d.motoboy_id },
        `${m.nome} — ${equipamento(m)} — ${m.turno.pendentes} parada(s)`)));
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(() => api('POST', `/api/admin/demandas/${d.id}/atribuir`, { motoboy_id: sel.value || null }), ok),
    }, 'Salvar');
    return [
      h('p', { class: 'nota' }, d.status === 'coletada'
        ? 'Atenção: a carga já foi coletada. Ao trocar, o novo motoboy precisará coletar de novo (combine a passagem da carga).'
        : 'A escolha manual ignora a regra de baú/bag: confira antes.'),
      h('label', null, 'Motoboy'), sel,
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

// Nova demanda, ou (com `existente`) só marcar os pontos de uma demanda sem local.
// `previa` preenche a partir de uma mensagem do WhatsApp: { cliente, descricao, mensagem_id }.
function janelaDemanda(existente = null, previa = null) {
  const pontos = {
    coleta: { lat: existente?.coleta_lat ?? previa?.coleta?.lat ?? null, lon: existente?.coleta_lon ?? previa?.coleta?.lon ?? null, marcador: null },
    entrega: { lat: existente?.entrega_lat ?? null, lon: existente?.entrega_lon ?? null, marcador: null },
  };
  let alvo = pontos.coleta.lat == null ? 'coleta' : 'entrega';
  let mini = null;

  dialogo(existente ? `Editar demanda #${existente.id}` : previa?.titulo || 'Nova demanda', (dlg) => {
    const cliente = h('input', { maxlength: 120, value: existente?.cliente || previa?.cliente || '' });
    const requisito = h('select', null,
      Object.entries(ROTULO_REQUISITO).map(([v, r]) => h('option', { value: v, selected: (existente?.requisito ?? previa?.requisito) === v }, r)));
    const descricao = h('input', { maxlength: 500, value: existente?.descricao || previa?.descricao?.replace(/\s*\n+\s*/g, ' · ').slice(0, 500) || '', placeholder: 'O que é, observações' });
    const agendar = h('input', { type: 'datetime-local' });
    const tamanhoSel = h('select', null, [['', 'Normal (pequeno ou médio)'], ['g', 'G — até 40 cm (cobra a mais)'], ['gg', 'GG — mais de 40 cm (cobra a mais)']]
      .map(([v, r]) => h('option', { value: v }, r)));
    const campos = {};
    const botoesAlvo = {};

    const marcar = (qual, lat, lon, centralizar) => {
      const p = pontos[qual];
      p.lat = lat; p.lon = lon;
      if (p.marcador) p.marcador.remove();
      p.marcador = L.marker([lat, lon], { icon: dimensionar(icone(`ponto ${qual}`, qual === 'coleta' ? 'C' : 'E', 24), 24) }).addTo(mini);
      campos[qual].situacao.className = 'marcado';
      campos[qual].situacao.textContent = 'Ponto marcado no mapa';
      if (centralizar) mini.setView([lat, lon], 16);
      if (qual === 'coleta' && pontos.entrega.lat == null) escolherAlvo('entrega');
    };
    const escolherAlvo = (qual) => {
      alvo = qual;
      for (const [k, b] of Object.entries(botoesAlvo)) b.classList.toggle('ativa', k === qual);
    };

    const bloco = (qual, titulo) => {
      const endereco = h('input', { maxlength: 200, value: existente?.[`${qual}_endereco`] || previa?.[qual]?.endereco || '', placeholder: 'Rua, número, bairro' });
      const contato = h('input', { maxlength: 120, value: existente?.[`${qual}_contato`] || previa?.[qual]?.contato || '', placeholder: 'Nome / telefone no local' });
      const resultados = h('div', { class: 'resultados' });
      const situacao = h('span', { class: 'falta' }, 'Falta marcar no mapa');
      const buscar = h('button', {
        type: 'button',
        onclick: async () => {
          trocar(resultados, h('div', { class: 'nota' }, 'Buscando…'));
          try {
            const { resultados: lista } = await api('GET', `/api/admin/geocode?q=${encodeURIComponent(endereco.value)}`);
            trocar(resultados, lista.length
              ? lista.map((r) => h('button', { type: 'button', onclick: () => { marcar(qual, r.lat, r.lon, true); trocar(resultados); } }, r.nome))
              : h('div', { class: 'nota' }, 'Não achei. Clique no mapa abaixo para marcar o ponto.'));
          } catch (e) { trocar(resultados, h('div', { class: 'nota' }, e.message)); }
        },
      }, 'Buscar');
      campos[qual] = { endereco, contato, situacao, buscar };
      return h('div', null,
        h('label', null, `${titulo} — endereço`),
        h('div', { class: 'linha' }, h('div', { class: 'cresce' }, endereco), buscar),
        situacao, resultados,
        h('label', null, `${titulo} — contato`), contato);
    };

    const miniEl = h('div', { id: 'mini-mapa' });
    botoesAlvo.coleta = h('button', { type: 'button', onclick: () => escolherAlvo('coleta') }, 'Clique no mapa marca: COLETA');
    botoesAlvo.entrega = h('button', { type: 'button', onclick: () => escolherAlvo('entrega') }, 'Clique no mapa marca: ENTREGA');

    const salvar = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(async () => {
        const ponto = (qual) => ({
          endereco: campos[qual].endereco.value, contato: campos[qual].contato.value,
          lat: pontos[qual].lat, lon: pontos[qual].lon,
        });
        if (pontos.coleta.lat == null || pontos.entrega.lat == null) throw new Error('Marque coleta e entrega no mapa.');
        if (existente) {
          await api('PUT', `/api/admin/demandas/${existente.id}/dados`, {
            cliente: cliente.value, requisito: requisito.value, descricao: descricao.value,
            coleta_contato: campos.coleta.contato.value, entrega_contato: campos.entrega.contato.value,
          });
          const mudou = (qual) => campos[qual].endereco.value !== (existente[`${qual}_endereco`] || '')
            || pontos[qual].lat !== existente[`${qual}_lat`] || pontos[qual].lon !== existente[`${qual}_lon`];
          if (mudou('coleta') || mudou('entrega')) {
            await api('PUT', `/api/admin/demandas/${existente.id}/locais`, { coleta: ponto('coleta'), entrega: ponto('entrega') });
          }
        } else {
          await api('POST', '/api/admin/demandas', {
            cliente: cliente.value, requisito: requisito.value, descricao: descricao.value, mensagem_id: previa?.mensagem_id, telefone: previa?.telefone || undefined, agendada_para: agendar.value || undefined, tamanho: tamanhoSel.value || undefined,
            coleta: ponto('coleta'), entrega: ponto('entrega'),
          });
        }
      }, salvar),
    }, existente ? 'Salvar' : 'Criar e despachar');

    // O mapa só mede o tamanho certo depois que a janela aparece.
    setTimeout(() => {
      const c = mapa.getCenter();
      mini = L.map(miniEl).setView([c.lat, c.lng], Math.max(12, mapa.getZoom()));
      camadaBase().addTo(mini);
      mini.on('click', (ev) => marcar(alvo, ev.latlng.lat, ev.latlng.lng, false));
      for (const qual of ['coleta', 'entrega']) {
        if (pontos[qual].lat != null) marcar(qual, pontos[qual].lat, pontos[qual].lon, false);
      }
      escolherAlvo(alvo);
      // Veio da IA com endereço escrito: já procura no mapa para o admin só escolher.
      for (const qual of ['coleta', 'entrega']) {
        if (previa?.[qual]?.endereco && pontos[qual].lat == null) campos[qual].buscar.click();
      }
    }, 0);

    return [
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Cliente'), cliente),
        h('div', null, h('label', null, 'Exige'), requisito)),
      h('label', null, 'Descrição'), descricao,
      existente && ['atribuida', 'coletada'].includes(existente.status) && h('p', { class: 'nota' }, 'Já tem motoboy: o endereço não muda mais por aqui. Para outro destino, use "+ Entrega" no pedido.'),
      !existente && h('label', null, 'Agendar para (vazio = agora)'), !existente && agendar,
      !existente && h('label', null, 'Tamanho da mercadoria'), !existente && tamanhoSel,
      h('div', { class: 'grade2' }, bloco('coleta', 'Coleta'), bloco('entrega', 'Entrega')),
      h('div', { class: 'alvo' }, botoesAlvo.coleta, botoesAlvo.entrega),
      miniEl,
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), salvar)];
  }, { largo: true });
}

// --------------------------------------------------------------- motoboys
async function convocar(id) {
  try {
    await api('POST', `/api/admin/motoboys/${id}/convocar`);
    await atualizar();
    const m = estado.motoboys.find((x) => x.id === id);
    const texto = `Olá, ${m.nome.split(' ')[0]}! A Speed convocou você para o turno de hoje. Abra o app Speed Motoboy e inicie o turno.`;
    dialogo(`${m.nome} convocado`, (dlg) => [
      h('p', null, `A convocação vale até ${hora(m.convocado_ate)} de hoje. O turno de 8 h começa quando ele fizer login.`),
      h('div', { class: 'linha fim' },
        h('button', { onclick: dlg.fechar }, 'Fechar'),
        estado.whatsapp.ligado ? h('span', { class: 'nota' }, 'O aviso já foi enviado pelo WhatsApp automático.') : h('a', {
          class: 'botao primario', href: `https://wa.me/55${m.telefone}?text=${encodeURIComponent(texto)}`,
          target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(dlg.fechar, 200),
        }, 'Avisar pelo WhatsApp'))]);
  } catch (e) { els.conexao.textContent = e.message; }
}

// "Bairro, Cidade" de um endereço gravado (ex.: "R. X, 556 - Centro, Piúma - ES, 29285-000" → "Centro, Piúma").
// Sem cidade reconhecível, devolve ''. Nunca rua, número, nome do cliente ou complemento.
function bairroCidade(endereco) {
  let s = String(endereco || '').split(' — ')[0];
  if (s.includes(' · ')) s = s.slice(s.lastIndexOf(' · ') + 3);
  const m = s.match(/^(.*?)([^,\-]+?)\s*-\s*ES\b/i);
  if (!m) return '';
  const cidade = m[2].trim();
  const partes = m[1].split(/,| - /).map((x) => x.trim()).filter(Boolean);
  let bairro = partes.length > 1 ? partes[partes.length - 1] : '';
  if (/^\d|^(r\.|rua|av\.?|avenida|rod\.?|rodovia|travessa|estrada)\b|^s\/n$/i.test(bairro)) bairro = '';
  return [bairro, cidade].filter(Boolean).join(', ');
}

// Só o que descreve a mercadoria, tirado da descrição do pedido: sem nomes de quem coleta/recebe, loja,
// NF/CNPJ, telefone, e-mail, endereço ou cobrança. O dono revisa antes de enviar.
const TAMANHO_TXT = { g: 'Grande (até 40 cm)', gg: 'Gigante (mais de 40 cm)' };
function mercadoria(descricao) {
  const fora = /modalidade|tamanho:|cnpj|cpf|nota|\bnf\b|minuta|loja|coleta|coletar|entreg|pegar|levar|retirar n|despachar|confirmar|refer[eê]ncia|cobrar|parada \d|pix|pagamento|apresentar|devolver|recolh|📏|\(|@|https?:/i;
  return String(descricao || '').replace(/\\/g, ' ').split(/\s*(?:·|\||\n)\s*/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x && !fora.test(x.replace(/\(\d+x\d+(x\d+)?\s*cm\)/gi, '')) && (x.replace(/\D/g, '').length < 8 || /\d+\s*x\s*\d+/i.test(x)))
    .join(' · ').slice(0, 200);
}

// Recrutar motoboy no WhatsApp: trajeto (bairro e cidade), km, valor do motoboy, mercadoria e baú, + link do cadastro.
// Abre uma janela para revisar antes; nunca leva cliente, telefone ou endereço completo.
function compartilharDemanda(d) {
  dialogo(`Compartilhar pedido #${d.id}`, (dlg) => {
    const de = bairroCidade(d.coleta_endereco);
    const para = bairroCidade(d.entrega_endereco);
    const cadastro = `${location.origin.replace('//despacho.', '//speedy.')}/cadastro/`;
    const merc = h('input', { maxlength: 200, value: mercadoria(d.descricao), placeholder: 'Ex.: caixa de 7 kg, 30x25x40 cm' });
    const bau = h('input', { type: 'checkbox', checked: d.requisito === 'bau' || ['g', 'gg'].includes(d.tamanho) });
    const previa = h('textarea', { rows: 13, readonly: true });
    const texto = () => [
      '🛵 *Entrega disponível — SpeedBoy*', '',
      (de || para) && `📍 ${de || 'Grande Vitória'} → ${para || 'Grande Vitória'}`,
      d.km != null && `📏 ${String(d.km).replace('.', ',')} km`,
      merc.value.trim() && `📦 ${merc.value.trim()}`,
      TAMANHO_TXT[d.tamanho] && `📐 Tamanho: ${TAMANHO_TXT[d.tamanho]}`,
      bau.checked && '🧰 *Necessário baú*',
      `💰 *${reais(d.repasse)}*`, '',
      'Essa e muitas outras entregas estão disponíveis todos os dias no app Speedy.', '',
      'Quer rodar com a SpeedBoy? Faça seu cadastro:', cadastro, '',
      'Depois do cadastro, a SpeedBoy confere seus dados e libera seu acesso.',
    ].filter((l) => typeof l === 'string').join('\n');
    const atualizarPrevia = () => { previa.value = texto(); };
    merc.addEventListener('input', atualizarPrevia);
    bau.addEventListener('change', atualizarPrevia);
    atualizarPrevia();
    const ok = h('button', {
      class: 'primario',
      onclick: () => {
        const t = texto();
        try { navigator.clipboard?.writeText(t); } catch { /* sem área de transferência */ }
        window.open(`https://wa.me/?text=${encodeURIComponent(t)}`, '_blank', 'noopener');
        dlg.fechar();
      },
    }, 'Abrir no WhatsApp');
    return [
      h('p', { class: 'nota' }, 'Confira a mercadoria: não pode ter nome, telefone ou endereço de cliente.'),
      h('label', null, 'Mercadoria'), merc,
      h('label', { class: 'marcar' }, bau, ' Necessário baú'),
      h('label', null, 'Mensagem'), previa,
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

// Muda o valor do pedido (ex.: desconto) e o que o motoboy recebe. O motoboy não muda sozinho.
function janelaValor(d) {
  dialogo(`Valor do pedido #${d.id}`, (dlg) => {
    const valor = h('input', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: d.valor ?? '' });
    const repasse = h('input', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: d.repasse ?? '' });
    const motivo = h('input', { maxlength: 200, placeholder: 'Ex.: desconto combinado com o cliente' });
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(() => api('PUT', `/api/admin/demandas/${d.id}/valor`, { valor: valor.value, repasse: repasse.value, motivo: motivo.value }), ok),
    }, 'Salvar valor');
    return [
      h('p', { class: 'nota' }, `${d.cliente}. O que o motoboy recebe não muda sozinho: ajuste abaixo se precisar.`),
      h('label', null, 'Cliente paga (R$)'), valor,
      h('label', null, 'Motoboy recebe (R$)'), repasse,
      h('label', null, 'Motivo (opcional)'), motivo,
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

// Entregas que cada motoboy tem agora (para ver quem está com o quê).
function entregasDe(m) {
  const lista = estado.demandas.filter((d) => d.motoboy_id === m.id && ['atribuida', 'coletada'].includes(d.status));
  if (!lista.length) return null;
  return h('div', { class: 'com-ele' }, lista.map((d) => h('div', { class: 'linha-entrega' },
    chip(d.status === 'coletada' ? 'Levando' : 'Vai coletar', d.status),
    h('span', null, `#${d.id} ${d.cliente} → ${bairroCidade(d.entrega_endereco) || d.entrega_endereco}`))));
}

// Escolher motoboy: janela com um cartão por motoboy. Livres e mais perto primeiro; um toque designa.
function janelaEscolher(d) {
  dialogo(`Escolher motoboy — #${d.id} ${d.cliente}`, (dlg) => {
    const ref = d.coleta_lat != null ? [d.coleta_lat, d.coleta_lon] : null;
    const precisaBau = d.requisito === 'bau';
    const lista = estado.motoboys.filter((m) => m.turno).map((m) => {
      const t = m.turno;
      const km = ref && t.lat != null ? kmEntre(ref, [t.lat, t.lon]) : null;
      const parado = Boolean(t.almoco_ate) || t.status === 'sem_sinal';
      const grupo = parado ? 2 : t.pendentes > 0 ? 1 : 0;
      return { m, t, km, grupo, semBau: precisaBau && !m.tem_bau };
    }).sort((a, b) => a.semBau - b.semBau || a.grupo - b.grupo || (a.km ?? 1e9) - (b.km ?? 1e9));
    const escolher = (id) => { dlg.fechar(); designar(d, id); };
    const cartao = ({ m, t, km, grupo, semBau }) => h('button', { class: `escolha g${grupo}${m.id === d.motoboy_id ? ' atual' : ''}`, onclick: () => escolher(m.id) },
      h('div', { class: 'escolha-topo' }, h('b', null, m.nome),
        h('span', { class: `selo g${grupo}` }, grupo === 0 ? 'LIVRE' : grupo === 1 ? `${t.pendentes} parada(s)` : t.almoco_ate ? 'ALMOÇO' : 'SEM SINAL')),
      h('div', { class: 'escolha-sub' }, [km != null ? `${km.toFixed(1)} km da coleta` : 'sem posição', equipamento(m)].join(' · ')),
      semBau && h('div', { class: 'escolha-aviso' }, 'Pedido precisa de baú: este não tem.'),
      m.id === d.motoboy_id && h('div', { class: 'escolha-sub' }, 'Está com este pedido agora.'),
      entregasDe(m));
    return [
      h('p', { class: 'nota' }, `Coleta: ${bairroCidade(d.coleta_endereco) || d.coleta_endereco}. Toque no motoboy para designar.`),
      d.status === 'coletada' && h('p', { class: 'escolha-aviso' }, 'Atenção: a carga já foi coletada. O novo motoboy precisa pegar com o anterior.'),
      lista.length ? h('div', { class: 'grade-escolha' }, lista.map(cartao)) : h('div', { class: 'vazio' }, 'Ninguém em turno agora. Convoque na aba Motoboys.'),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'),
        h('button', { onclick: () => escolher(null) }, 'Automático (sistema escolhe)'))];
  }, { largo: true });
}

async function verFoto(d) {
  try {
    const r = await api('GET', `/api/admin/demandas/${d.id}/foto`);
    dialogo(`Foto da entrega #${d.id} — ${d.cliente}`, (dlg) => [
      h('p', { class: 'nota' }, `Entregue ${hora(d.entregue_em)} para ${d.recebedor || '—'}`),
      h('img', { src: r.foto, alt: 'Foto da entrega', class: 'foto-entrega' }),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Fechar'))], { largo: true });
  } catch (e) { els.conexao.textContent = e.message; }
}

// Libera o mapa do motoboy para o cliente desde já e manda o link pelo WhatsApp.
async function localizacaoCliente(d) {
  const janela = window.open('', '_blank', 'noopener');
  try { await api('POST', `/api/admin/demandas/${d.id}/rastreio`); } catch (e) { els.conexao.textContent = e.message; if (janela) janela.close(); return; }
  const link = `https://www.speedboy.com.br/acompanhar/?c=${d.codigo}`;
  const texto = `Olá! Aqui é a SpeedBoy. Você já pode acompanhar o motoboy em tempo real, no mapa, por este link: ${link}`;
  try { navigator.clipboard?.writeText(link); } catch { /* sem área de transferência */ }
  const tel = String(d.cliente_telefone || '').replace(/\D/g, '');
  const url = `https://wa.me/${tel ? (tel.length <= 11 ? `55${tel}` : tel) : ''}?text=${encodeURIComponent(texto)}`;
  if (janela) janela.location.href = url; else window.open(url, '_blank', 'noopener');
  atualizar();
}

// Link de acompanhamento do pedido: copia e abre o WhatsApp do cliente com a mensagem pronta.
function linkCliente(d) {
  const link = `https://www.speedboy.com.br/acompanhar/?c=${d.codigo}`;
  const texto = `Olá! Aqui é a SpeedBoy. Acompanhe a sua entrega por este link: ${link}\nO mapa com o motoboy aparece quando ele estiver a caminho do destino.`;
  try { navigator.clipboard?.writeText(link); } catch { /* sem área de transferência */ }
  const tel = String(d.cliente_telefone || '').replace(/\D/g, '');
  const para = tel ? (tel.length <= 11 ? `55${tel}` : tel) : '';
  window.open(`https://wa.me/${para}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
}

function janelaFinalizar(d) {
  dialogo(`Finalizar entrega #${d.id}`, (dlg) => {
    const motivo = h('textarea', { maxlength: 300, rows: 3, placeholder: 'O que ocorreu (opcional). Ex.: motoboy entregou e esqueceu de marcar.' });
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(() => api('POST', `/api/admin/demandas/${d.id}/finalizar`, { motivo: motivo.value }), ok),
    }, 'Finalizar como entregue');
    return [
      h('p', { class: 'nota' }, `${d.cliente}: marca a entrega como concluída com sucesso. Fica registrado que foi finalizada pela central.`),
      h('label', null, 'Motivo'), motivo,
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

function janelaMotoboy(m = null) {
  dialogo(m ? `Editar ${m.nome}` : 'Novo motoboy', (dlg) => {
    const nome = h('input', { maxlength: 80, value: m?.nome || '' });
    const telefone = h('input', { inputmode: 'tel', value: m ? telefoneFmt(m.telefone) : '', placeholder: '(11) 99999-0000' });
    const pin = h('input', { inputmode: 'numeric', maxlength: 6, autocomplete: 'off', placeholder: m ? 'Deixe vazio para manter' : '6 números' });
    const veiculo = h('select', null, h('option', { value: 'moto', selected: m?.veiculo !== 'bike' }, 'Moto'), h('option', { value: 'bike', selected: m?.veiculo === 'bike' }, 'Bike'));
    const tipo = h('select', null,
      h('option', { value: 'diaria', selected: m?.tipo !== 'avulso' }, 'Diária (convocado, cumpre o turno, recebe diária)'),
      h('option', { value: 'avulso', selected: m?.tipo === 'avulso' }, 'Avulso (entra quando quiser, recebe por entrega)'));
    const bau = h('input', { type: 'checkbox', checked: m?.tem_bau });
    const bag = h('input', { type: 'checkbox', checked: m?.tem_bag });
    const ativo = h('input', { type: 'checkbox', checked: m ? m.ativo : true });
    const valorTxt = (v) => (v == null ? '' : String(v).replace('.', ','));
    const diariaP = h('input', { inputmode: 'decimal', placeholder: 'Padrão', value: valorTxt(m?.diaria_valor) });
    const repBaseP = h('input', { inputmode: 'decimal', placeholder: 'Padrão', value: valorTxt(m?.repasse_base) });
    const repKmP = h('input', { inputmode: 'decimal', placeholder: 'Padrão', value: valorTxt(m?.repasse_km) });
    const gerar = h('button', { type: 'button', onclick: () => { pin.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0'); } }, 'Gerar');
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(() => {
        const dados = { nome: nome.value, telefone: telefone.value, pin: pin.value, veiculo: veiculo.value, tipo: tipo.value, tem_bau: bau.checked, tem_bag: bag.checked, ativo: ativo.checked,
          diaria_valor: diariaP.value.trim(), repasse_base: repBaseP.value.trim(), repasse_km: repKmP.value.trim() };
        return m ? api('PUT', `/api/admin/motoboys/${m.id}`, dados) : api('POST', '/api/admin/motoboys', dados);
      }, ok),
    }, 'Salvar');
    return [
      h('label', null, 'Nome'), nome,
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Telefone com DDD (é o login)'), telefone),
        h('div', null, h('label', null, 'Senha do app (6 números)'), h('div', { class: 'linha' }, h('div', { class: 'cresce' }, pin), gerar))),
      h('div', { class: 'nota' }, 'Anote a senha e passe ao motoboy: depois de salvar ela não aparece mais.'),
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Veículo'), veiculo),
        h('div', null, h('label', null, 'Como trabalha'), tipo)),
      h('label', { class: 'marcar' }, bau, 'Tem baú'),
      h('label', { class: 'marcar' }, bag, 'Tem bag'),
      h('h3', null, 'Valor deste motoboy'),
      h('div', { class: 'nota' }, 'Vazio = tabela padrão (Configurações).'),
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Diária (R$)'), diariaP),
        h('div', null, h('label', null, 'Avulso: valor até os km incluídos (R$)'), repBaseP)),
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Avulso: por km a mais (R$)'), repKmP),
        h('div', null)),
      m && h('label', { class: 'marcar' }, ativo, 'Ativo (desmarcar bloqueia o login e encerra o turno)'),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

function mensagemAcesso(nome, telefone, pin, tipo) {
  return `Olá, ${nome.split(' ')[0]}! Seu cadastro na SpeedBoy foi aprovado. ✅\n\n` +
    `Para entrar, toque no link:\n${location.origin}/app/\n\n` +
    `Telefone: ${telefoneFmt(telefone)}\nSenha: ${pin}\n\n` +
    (tipo === 'avulso'
      ? 'Você entra quando quiser. As entregas disponíveis aparecem no app e você aceita as que quiser fazer.'
      : 'Você faz o turno nos dias combinados com a gente. As entregas chegam direto no app.') +
    '\n\nDeixe a localização ligada durante o serviço. Qualquer dúvida, é só chamar aqui.';
}
async function decidirCadastro(c, aceitar) {
  try {
    const r = await api('POST', `/api/admin/candidatos/${c.id}/decidir`, { aceitar });
    await atualizar();
    if (!r.aceito) return;
    const texto = mensagemAcesso(r.nome, r.telefone, r.pin, r.tipo);
    dialogo(`${r.nome} aceito`, (dlg) => [
      h('p', null, 'A conta já está criada no aplicativo. Mande o acesso para ele:'),
      h('p', null, h('strong', null, `Telefone ${telefoneFmt(r.telefone)} · Senha ${r.pin}`)),
      h('p', { class: 'nota' }, 'A senha fica guardada na lista de motoboys, coluna Senha, se ele esquecer.'),
      h('div', { class: 'linha fim' },
        h('button', { onclick: dlg.fechar }, 'Fechar'),
        h('a', { class: 'botao primario', href: `https://wa.me/55${r.telefone}?text=${encodeURIComponent(texto)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Enviar acesso pelo WhatsApp'))]);
  } catch (e) { els.conexao.textContent = e.message; }
}

function desenharMotoboys() {
  if (!estado) return;
  const situacao = (m) => {
    if (!m.ativo) return chip('Inativo', 'inativo');
    if (m.turno) return chip(m.tipo === 'avulso' ? 'Online' : `Em turno até ${hora(m.turno.fim_previsto)}`, 'em_rota');
    if (m.tipo === 'avulso') return h('span', { class: 'nota' }, m.ultimo_turno ? `Avulso · esteve online ${dataHora(m.ultimo_turno)}` : 'Avulso · ainda não entrou');
    if (m.convocado_ate) return chip('Convocado, aguardando login', 'convocado');
    return h('span', { class: 'nota' }, m.ultimo_turno ? `Último turno ${dataHora(m.ultimo_turno)}` : 'Nunca fez turno');
  };
  const linkCadastro = `${location.origin}/cadastro/`;
  const copiarLink = h('button', { class: 'pequeno', onclick: async () => { try { await navigator.clipboard.writeText(linkCadastro); copiarLink.textContent = 'Link copiado ✓'; } catch { /* copia manual */ } } }, 'Copiar link');
  const pendentes = estado.candidatos || [];
  trocar(els.pagina, 
    pendentes.length > 0 && h('div', { class: 'cartao sugestao' },
      h('h3', null, `Cadastros aguardando sua resposta (${pendentes.length})`),
      pendentes.map((c) => h('div', { class: 'linha' },
        h('div', { class: 'cresce' },
          h('div', null, h('strong', null, c.nome), ` · ${c.tipo === 'diaria' ? 'Fixo (diária)' : 'Avulso'}`),
          h('div', { class: 'sub' }, `${telefoneFmt(c.telefone)} · Doc ${c.documento || '—'} · ${c.veiculo === 'bike' ? 'Bike' : `Moto ${c.placa || '—'}`}${c.tem_bau ? ' · baú' : ''}${c.tem_bag ? ' · bag' : ''}`),
          c.indicacao && h('div', { class: 'sub' }, `Indicação / de onde veio: ${c.indicacao}`),
          h('div', { class: 'nota' }, `Recebido ${dataHora(c.criado_em)}`)),
        h('button', { class: 'pequeno primario', onclick: () => decidirCadastro(c, true) }, 'Aceitar'),
        h('button', { class: 'pequeno', onclick: () => confirmar('Recusar cadastro', `Recusar o cadastro de ${c.nome}?`, 'Recusar', () => decidirCadastro(c, false)) }, 'Recusar')))),
    h('div', { class: 'cartao' },
      h('div', { class: 'linha' }, h('div', { class: 'cresce' }, h('strong', null, 'Link de cadastro para novos motoboys'), h('div', { class: 'sub' }, linkCadastro)), copiarLink),
      h('p', { class: 'nota' }, 'Mande esse link no grupo. Quem preencher aparece aqui para você aceitar ou recusar.')),
    h('div', { class: 'linha' }, h('h2', { class: 'cresce' }, 'Motoboys'),
      h('button', { class: 'primario', onclick: () => janelaMotoboy() }, '+ Novo motoboy')),
    h('p', { class: 'nota' }, 'Diária: só faz login no dia em que for convocado e cumpre o turno. Avulso: entra e sai quando quiser, aceita as entregas perto dele e recebe o repasse de cada uma.'),
    estado.motoboys.length === 0 ? h('div', { class: 'vazio' }, 'Nenhum motoboy cadastrado ainda.')
      : h('table', null,
        h('thead', null, h('tr', null, ['Nome', 'Telefone', 'Senha', 'Equipamento', 'Situação', ''].map((c) => h('th', null, c)))),
        h('tbody', null, estado.motoboys.map((m) => h('tr', null,
          h('td', null, m.nome), h('td', null, telefoneFmt(m.telefone)), h('td', null, m.pin_claro || '—'), h('td', null, equipamento(m)), h('td', null, situacao(m)),
          h('td', null, h('div', { class: 'linha' },
            m.ativo && m.tipo !== 'avulso' && !m.turno && !m.convocado_ate && h('button', { class: 'pequeno primario', onclick: () => convocar(m.id) }, 'Convocar'),
            m.convocado_ate && h('button', {
              class: 'pequeno', onclick: async () => { await api('POST', `/api/admin/motoboys/${m.id}/desconvocar`).catch(() => {}); atualizar(); },
            }, 'Cancelar convocação'),
            h('button', { class: 'pequeno', onclick: () => janelaMotoboy(m) }, 'Editar'))))))));
}

// --------------------------------------------------------------- whatsapp
let conversaAberta = null;
const ARQUIVO_MAX = 20 * 1024 * 1024;

function lerArquivoBase64(arquivo) {
  return new Promise((ok, falha) => {
    const leitor = new FileReader();
    leitor.onload = () => ok(String(leitor.result).split(',')[1] || '');
    leitor.onerror = () => falha(new Error('Não consegui ler o arquivo.'));
    leitor.readAsDataURL(arquivo);
  });
}

async function desenharWhatsapp(mensagemAviso = '') {
  const aviso = h('div', { class: 'nota' }, mensagemAviso);
  const entrada = h('input', { type: 'file', accept: '.txt,.zip,text/plain,application/zip', multiple: true, hidden: true });
  entrada.addEventListener('change', async () => {
    const arquivos = [...entrada.files];
    entrada.value = '';
    const resultado = [];
    for (const arq of arquivos) {
      if (arq.size > ARQUIVO_MAX) { resultado.push(`${arq.name}: maior que 20 MB. Exporte "sem mídia".`); continue; }
      aviso.textContent = `Enviando ${arq.name}…`;
      try {
        const r = await api('POST', '/api/admin/whatsapp', { arquivo: arq.name, conteudo: await lerArquivoBase64(arq) });
        resultado.push(`${r.nome}: ${r.lidas} mensagens lidas, ${r.novas} novas.`);
        conversaAberta = r.conversa_id;
      } catch (e) { resultado.push(`${arq.name}: ${e.message}`); }
    }
    desenharWhatsapp(resultado.join(' '));
  });

  let conversas = [];
  try { ({ conversas } = await api('GET', '/api/admin/whatsapp')); } catch { return; }
  if (abaAtual !== 'whatsapp') return;
  if (!conversas.some((c) => c.id === conversaAberta)) conversaAberta = conversas[0]?.id ?? null;

  const lista = conversas.map((c) => h('div', {
    class: `cartao clicavel ${c.id === conversaAberta ? 'sugestao' : ''}`,
    onclick: () => { conversaAberta = c.id; desenharWhatsapp(); },
  },
  h('div', { class: 'titulo' }, c.nome,
    c.pendente ? chip('Esperando atendente', 'sem_sinal')
      : c.pausa_ate > Date.now() ? chip('Atendendo pelo app', 'aguardando')
        : c.telefone && chip(c.humano ? 'Atendente' : 'Robô', c.humano ? 'aguardando' : 'entregue')),
  h('div', { class: 'sub' }, `${c.total} mensagens`, c.primeira ? ` · ${dataHora(c.primeira)} a ${dataHora(c.ultima)}` : ''),
  c.demandas > 0 && h('div', { class: 'sub' }, `${c.demandas} viraram demanda`)));

  const busca = h('input', { placeholder: 'Buscar nas mensagens (ex.: coleta, rua, nome)' });
  const mensagens = h('div', null);
  const conversa = conversas.find((c) => c.id === conversaAberta);
  const resposta = h('input', { maxlength: 2000, placeholder: 'Responder ao cliente pelo WhatsApp' });
  const avisoResposta = h('div', { class: 'erro' });
  const mandarResposta = async () => {
    avisoResposta.textContent = '';
    try {
      await api('POST', `/api/admin/whatsapp/${conversaAberta}/responder`, { texto: resposta.value });
      resposta.value = '';
      await atualizar();
      desenharWhatsapp();
    } catch (e) { avisoResposta.textContent = e.message; }
  };
  resposta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') mandarResposta(); });
  const aoVivo = conversa?.telefone && h('div', { class: 'cartao' },
    h('div', { class: 'linha' }, h('div', { class: 'cresce' }, resposta), h('button', { class: 'primario', onclick: mandarResposta }, 'Enviar')),
    h('div', { class: 'linha' },
      h('span', { class: 'nota cresce' }, conversa.humano
        ? 'Atendente no comando: o robô não responde nesta conversa.'
        : 'O robô está respondendo. Ao enviar uma mensagem, você assume a conversa.'),
      h('button', {
        class: 'pequeno',
        onclick: async () => { await api('POST', `/api/admin/whatsapp/${conversaAberta}/modo`, { humano: !conversa.humano }).catch(() => {}); await atualizar(); desenharWhatsapp(); },
      }, conversa.humano ? 'Devolver ao robô' : 'Assumir conversa')),
    avisoResposta);
  const carregar = async () => {
    if (!conversaAberta) { trocar(mensagens, h('div', { class: 'vazio' }, 'Nenhuma conversa ainda.')); return; }
    try {
      const r = await api('GET', `/api/admin/whatsapp/${conversaAberta}?q=${encodeURIComponent(busca.value)}`);
      trocar(mensagens,
        r.mensagens.length === 0 && h('div', { class: 'vazio' }, 'Nenhuma mensagem encontrada.'),
        r.mensagens.map((m) => h('div', { class: `cartao ${m.direcao === 'saida' ? 'saida' : ''}` },
          h('div', { class: 'titulo' }, m.autor || 'Aviso do WhatsApp', h('span', { class: 'nota' }, dataHora(m.ts)),
            m.demanda_id && chip(`Demanda #${m.demanda_id}`, 'entregue')),
          h('div', { class: 'sub texto-msg' }, m.texto),
          m.autor && !m.demanda_id && m.direcao !== 'saida' && h('div', { class: 'acoes' }, h('button', {
            class: 'pequeno primario',
            onclick: () => janelaDemanda(null, { cliente: conversa?.nome || m.autor, descricao: m.texto, mensagem_id: m.id }),
          }, 'Criar demanda')))));
    } catch (e) { trocar(mensagens, h('div', { class: 'erro' }, e.message)); }
  };
  els.recarregarWhats = () => { if (!busca.value) carregar(); };
  let espera = null;
  busca.addEventListener('input', () => { clearTimeout(espera); espera = setTimeout(carregar, 300); });

  trocar(els.pagina,
    h('div', { class: 'linha' }, h('h2', { class: 'cresce' }, 'Conversas do WhatsApp'),
      h('button', { class: 'primario', onclick: () => entrada.click() }, 'Importar conversa')),
    entrada,
    h('p', { class: 'nota' }, estado?.whatsapp.ligado
      ? 'WhatsApp automático ligado: as conversas aparecem aqui ao vivo e o robô atende sozinho. Você pode assumir qualquer conversa.'
      : 'WhatsApp automático desligado (ligue em Configurações para o robô atender sozinho). Enquanto isso, dá para importar conversas exportadas.'),
    h('details', null, h('summary', null, 'Como importar uma conversa antiga'),
      h('p', { class: 'nota' }, 'No celular: abra a conversa → ⋮ Mais → Exportar conversa → Sem mídia (no iPhone: toque no nome do contato → Exportar conversa). Mande o arquivo para você e importe aqui (.txt ou .zip). Importar de novo a mesma conversa só acrescenta as mensagens novas.')),
    aviso,
    h('div', { class: 'grade-whats' },
      h('div', null, h('h3', null, `Conversas (${conversas.length})`), lista),
      h('div', null,
        h('div', { class: 'linha' }, h('h3', { class: 'cresce' }, 'Mensagens (mais recentes primeiro)'),
          conversaAberta && h('button', {
            class: 'pequeno',
            onclick: async (ev) => {
              const botao = ev.currentTarget;
              botao.disabled = true;
              botao.textContent = 'A IA está lendo…';
              try {
                const r = await api('POST', `/api/admin/whatsapp/${conversaAberta}/analisar`, {});
                dialogo('Análise da conversa', (dlg) => [cartoesAnalise(r, conversa?.nome), h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Fechar'))], { largo: true });
              } catch (e) { trocar(mensagens, h('div', { class: 'erro' }, e.message)); }
              botao.disabled = false;
              botao.textContent = 'Analisar com IA';
            },
          }, 'Analisar com IA'),
          conversaAberta && h('button', {
            class: 'pequeno perigo',
            onclick: () => confirmar('Excluir conversa', 'Apagar esta conversa e as mensagens importadas? As demandas já criadas continuam.', 'Excluir',
              async () => { await api('DELETE', `/api/admin/whatsapp/${conversaAberta}`); conversaAberta = null; }),
          }, 'Excluir conversa')),
        aoVivo, busca, mensagens)));
  carregar();
}

// --------------------------------------------------------------------- IA
// Foto vira JPEG de até 1800 px antes de subir: fica leve e sem os dados escondidos da câmera.
async function prepararArquivoIa(arquivo) {
  const ehImagem = arquivo.type.startsWith('image/');
  if (ehImagem) {
    try {
      const bitmap = await createImageBitmap(arquivo);
      const escala = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
      const tela = h('canvas', { width: Math.round(bitmap.width * escala), height: Math.round(bitmap.height * escala) });
      tela.getContext('2d').drawImage(bitmap, 0, 0, tela.width, tela.height);
      const blob = await new Promise((ok) => tela.toBlob(ok, 'image/jpeg', 0.85));
      if (blob) return { nome: arquivo.name, conteudo: await lerArquivoBase64(blob) };
    } catch { /* formato que o navegador não abre: tenta mandar como está */ }
  }
  if (arquivo.size > 12 * 1024 * 1024) throw new Error(`${arquivo.name}: maior que 12 MB.`);
  return { nome: arquivo.name, conteudo: await lerArquivoBase64(arquivo) };
}

// Mostra o que a IA achou: resposta, alertas, comprovante e pedidos prontos para virar demanda.
function cartoesAnalise(r, clientePadrao = '') {
  const cp = r.comprovante;
  return h('div', null,
    r.avisos?.map((a) => h('div', { class: 'nota' }, a)),
    r.resposta && h('div', { class: 'cartao sugestao' }, h('div', { class: 'titulo' }, 'Resposta'), h('div', { class: 'sub texto-msg' }, r.resposta)),
    h('div', { class: 'cartao' }, h('div', { class: 'titulo' }, 'Resumo'), h('div', { class: 'sub texto-msg' }, r.resumo || 'Sem resumo.')),
    r.alertas.length > 0 && h('div', { class: 'cartao alerta' },
      h('div', { class: 'titulo' }, `Atenção (${r.alertas.length})`), h('ul', { class: 'lista' }, r.alertas.map((a) => h('li', null, a)))),
    cp && h('div', { class: 'cartao' },
      h('div', { class: 'titulo' }, 'Comprovante de pagamento',
        cp.valor != null && chip(reais(cp.valor), 'entregue'),
        chip(cp.confere_recebedor ? 'Recebedor confere' : 'Recebedor diferente', cp.confere_recebedor ? 'entregue' : 'sem_sinal')),
      h('div', { class: 'sub' }, `Recebedor: ${cp.recebedor || '—'} · Pagador: ${cp.pagador || '—'}`),
      h('div', { class: 'sub' }, `Data: ${cp.data_hora || '—'} · Transação: ${cp.identificador || '—'}`),
      h('div', { class: 'nota' }, 'A IA lê a imagem; ela não vê sua conta. Confira no app do banco antes de liberar.'),
      h('div', { class: 'acoes' }, cp.pedidos_compativeis.length
        ? cp.pedidos_compativeis.map((id) => h('button', {
          class: 'pequeno primario',
          onclick: () => confirmar('Confirmar pagamento', `O Pix do pedido #${id} já caiu na sua conta? Ao confirmar, o pedido é liberado aos motoboys.`,
            'Sim, o Pix caiu', () => api('POST', `/api/admin/demandas/${id}/pago`), false),
        }, `Confirmar pagamento do pedido #${id}`))
        : h('span', { class: 'nota' }, 'Nenhum pedido esperando Pix com esse valor.'))),
    h('h3', null, `Pedidos encontrados (${r.pedidos.length})`),
    r.pedidos.length === 0 && h('div', { class: 'vazio' }, 'Nenhum pedido em aberto neste material.'),
    r.pedidos.map((p) => h('div', { class: 'cartao' },
      h('div', { class: 'titulo' }, p.cliente || clientePadrao || 'Cliente não identificado',
        p.servico && chip(p.servico), p.requisito !== 'qualquer' && chip(ROTULO_REQUISITO[p.requisito])),
      h('div', { class: 'sub' }, `C: ${p.coleta_endereco || '—'}${p.coleta_contato ? ` (${p.coleta_contato})` : ''}`),
      h('div', { class: 'sub' }, `E: ${p.entrega_endereco || '—'}${p.entrega_contato ? ` (${p.entrega_contato})` : ''}`),
      p.descricao && h('div', { class: 'sub' }, p.descricao),
      p.telefone && h('div', { class: 'sub' }, `Telefone: ${p.telefone}`),
      p.observacao && h('div', { class: 'sub falta' }, p.observacao),
      h('div', { class: 'acoes' }, h('button', {
        class: 'pequeno primario',
        onclick: () => janelaDemanda(null, {
          cliente: p.cliente || clientePadrao, descricao: [p.servico, p.descricao].filter(Boolean).join(' · '), requisito: p.requisito,
          coleta: { endereco: p.coleta_endereco, contato: p.coleta_contato }, entrega: { endereco: p.entrega_endereco, contato: p.entrega_contato },
        }),
      }, 'Criar demanda')))));
}

let analiseAberta = null;
async function desenharIa(mensagem = '') {
  let analises = [];
  try { ({ analises } = await api('GET', '/api/admin/analises')); } catch { return; }
  if (abaAtual !== 'ia') return;
  const escolhidos = h('div', { class: 'nota' }, 'Nenhum arquivo escolhido.');
  const entrada = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,.pdf,.txt,.zip,application/pdf,text/plain,application/zip' });
  entrada.addEventListener('change', () => {
    escolhidos.textContent = entrada.files.length ? [...entrada.files].map((f) => f.name).join(', ') : 'Nenhum arquivo escolhido.';
  });
  const pergunta = h('input', { maxlength: 1000, placeholder: 'Opcional. Ex.: quais pedidos ainda estão em aberto? Este comprovante confere?' });
  const aviso = h('div', { class: 'erro' }, mensagem);
  const enviar = h('button', {
    class: 'primario',
    onclick: async () => {
      aviso.textContent = '';
      if (!entrada.files.length) { aviso.textContent = 'Escolha pelo menos um arquivo.'; return; }
      enviar.disabled = true;
      enviar.textContent = 'A IA está lendo…';
      try {
        const arquivos = [];
        for (const f of entrada.files) arquivos.push(await prepararArquivoIa(f));
        analiseAberta = await api('POST', '/api/admin/analises', { arquivos, pergunta: pergunta.value });
        desenharIa();
      } catch (e) {
        aviso.textContent = e.message;
        enviar.disabled = false;
        enviar.textContent = 'Analisar';
      }
    },
  }, 'Analisar');
  const aberta = analiseAberta && (analises.find((a) => a.id === analiseAberta.id) || analiseAberta);

  trocar(els.pagina,
    h('h2', null, 'Analisar com IA'),
    h('p', { class: 'nota' }, 'Envie fotos (print de conversa, pedido anotado, comprovante de Pix), PDF ou conversa exportada do WhatsApp (.txt ou .zip). A IA lê, lista os pedidos prontos para virar demanda e confere comprovantes. O arquivo não fica guardado: só o resultado.'),
    !estado?.ia.ligada && h('div', { class: 'cartao alerta' },
      h('div', { class: 'titulo' }, 'A IA está instalada, mas desligada: falta a chave'),
      h('ol', { class: 'lista' },
        h('li', null, 'Entre em console.anthropic.com com sua conta.'),
        h('li', null, 'Em Billing, coloque crédito (é pago por uso, separado da assinatura do Claude).'),
        h('li', null, 'Em API Keys, clique em Create Key e copie a chave (começa com sk-ant-; aparece uma vez só).'),
        h('li', null, 'Em Configurações → Conferência dos pedidos por IA: cole a chave, salve e clique em "Testar a IA".')),
      h('div', { class: 'acoes' }, h('button', { class: 'pequeno primario', onclick: () => abrirAba('config') }, 'Abrir Configurações'))),
    estado?.ia.erro && h('div', { class: 'cartao alerta' }, h('div', { class: 'titulo' }, 'Último erro da IA'), h('div', { class: 'sub' }, estado.ia.erro)),
    h('div', { class: 'cartao' },
      entrada,
      h('div', { class: 'linha' }, h('button', { onclick: () => entrada.click() }, 'Escolher arquivos (até 6)'), escolhidos),
      h('label', null, 'O que você quer saber?'), pergunta,
      h('div', { class: 'linha fim' }, aviso, enviar)),
    aberta && [h('h3', null, `Resultado: ${aberta.titulo}`), aberta.pergunta && h('div', { class: 'nota' }, `Pergunta: ${aberta.pergunta}`), cartoesAnalise(aberta)],
    h('h3', null, `Análises anteriores (${analises.length})`),
    analises.length === 0 ? h('div', { class: 'vazio' }, 'Nenhuma análise ainda.')
      : analises.map((a) => h('div', {
        class: `cartao clicavel ${a.id === aberta?.id ? 'sugestao' : ''}`,
        onclick: () => { analiseAberta = a; desenharIa(); window.scrollTo(0, 0); },
      },
      h('div', { class: 'titulo' }, a.titulo, a.comprovante && chip('comprovante'), a.pedidos.length > 0 && chip(`${a.pedidos.length} pedido(s)`, 'em_rota')),
      h('div', { class: 'sub' }, `${dataHora(a.criada_em)} · ${a.resumo.slice(0, 160)}`))));
}

// -------------------------------------------------------------- relatório
const diaLocal = (d) => `${d.getFullYear()}-${doisDig(d.getMonth() + 1)}-${doisDig(d.getDate())}`;
function desenharRelatorio() {
  const hoje = new Date();
  const de = h('input', { type: 'date', value: diaLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)) });
  const ate = h('input', { type: 'date', value: diaLocal(hoje) });
  const saida = h('div', null);
  const gerar = async () => {
    const inicio = new Date(`${de.value}T00:00:00`).getTime();
    const fim = new Date(`${ate.value}T00:00:00`).getTime() + 24 * 3600 * 1000;
    try {
      const { linhas, clientes, entregas } = await api('GET', `/api/admin/relatorio?de=${inicio}&ate=${fim}`);
      const colunas = [['nome', 'Motoboy'], ['diarias', 'Diárias'], ['horas', 'Horas'], ['entregas', 'Entregas'], ['km', 'Km'], ['min_parado', 'Min. parado em alerta'], ['alertas', 'Alertas'], ['repasses', 'Repasses'], ['valor', 'A pagar']];
      const dinheiro = (v) => (v == null ? '—' : reais(v));
      const baixarEntregas = () => {
        const cab = ['Pedido', 'Entregue em', 'Cliente', 'Serviço', 'Km', 'Motoboy', 'Tipo', 'Pagamento', 'Valor', 'Repasse', 'Fica'];
        const n = (v) => (v == null ? '' : String(v).replace('.', ','));
        const t = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const csv = [cab.join(';'), ...entregas.map((e) => [e.id, dataHora(e.entregue_em), t(e.cliente), t(e.servico), n(e.km), t(e.motoboy), e.tipo || '', e.pagamento, n(e.valor), n(e.repasse), n(e.margem)].join(';'))].join('\r\n');
        const a = h('a', { href: URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv' })), download: `speed-entregas-${de.value}-a-${ate.value}.csv` });
        document.body.append(a); a.click(); a.remove();
      };
      const total = linhas.reduce((s, l) => s + l.valor, 0);
      const baixar = () => {
        const csv = [colunas.map((c) => c[1]).join(';'),
          ...linhas.map((l) => colunas.map(([k]) => (k === 'nome' ? `"${l.nome.replace(/"/g, '""')}"` : String(l[k]).replace('.', ','))).join(';'))].join('\r\n');
        const a = h('a', { href: URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv' })), download: `speed-${de.value}-a-${ate.value}.csv` });
        document.body.append(a); a.click(); a.remove();
      };
      trocar(saida, linhas.length === 0 ? h('div', { class: 'vazio' }, 'Nenhum turno no período.') : [
        h('table', null,
          h('thead', null, h('tr', null, colunas.map(([k, r]) => h('th', { class: k === 'nome' ? '' : 'num' }, r)))),
          h('tbody', null, linhas.map((l) => h('tr', null, colunas.map(([k]) =>
            h('td', { class: k === 'nome' ? '' : 'num' }, k === 'valor' || k === 'repasses' ? reais(l[k]) : l[k]))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: 8 }, 'Total'), h('td', { class: 'num' }, reais(total))))),
        h('div', { class: 'linha fim' }, h('button', { onclick: baixar }, 'Baixar planilha (CSV)'))],
      h('h3', null, 'Entregas por cliente (a cobrar)'),
      clientes.length === 0 ? h('div', { class: 'vazio' }, 'Nenhuma entrega concluída no período.')
        : h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Cliente'), h('th', null, 'WhatsApp'), h('th', { class: 'num' }, 'Entregas'), h('th', { class: 'num' }, 'Km'), h('th', { class: 'num' }, 'Valor'))),
          h('tbody', null, clientes.map((c) => h('tr', null,
            h('td', null, c.cliente), h('td', null, c.telefone ? telefoneFmt(c.telefone) : '—'),
            h('td', { class: 'num' }, c.entregas), h('td', { class: 'num' }, c.km), h('td', { class: 'num' }, reais(c.valor))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: 4 }, 'Total'), h('td', { class: 'num' }, reais(clientes.reduce((s, c) => s + c.valor, 0)))))),
      h('h3', null, 'Entrega por entrega (valor, repasse e o que fica)'),
      entregas.length === 0 ? h('div', { class: 'vazio' }, 'Nenhuma entrega concluída no período.') : [
        h('table', null,
          h('thead', null, h('tr', null, ['Pedido', 'Cliente', 'Serviço', 'Motoboy'].map((c) => h('th', null, c)), ['Valor', 'Repasse', 'Fica'].map((c) => h('th', { class: 'num' }, c)))),
          h('tbody', null, entregas.slice(0, 200).map((e) => h('tr', null,
            h('td', null, `#${e.id} · ${dataHora(e.entregue_em)}`), h('td', null, e.cliente), h('td', null, e.servico || '—'),
            h('td', null, e.motoboy || '—', e.tipo === 'avulso' ? ' (avulso)' : ''),
            h('td', { class: 'num' }, dinheiro(e.valor)), h('td', { class: 'num' }, reais(e.repasse)), h('td', { class: 'num' }, dinheiro(e.margem))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: 4 }, `Total (${entregas.length} entregas)`),
            h('td', { class: 'num' }, reais(entregas.reduce((s, e) => s + (e.valor || 0), 0))),
            h('td', { class: 'num' }, reais(entregas.reduce((s, e) => s + e.repasse, 0))),
            h('td', { class: 'num' }, reais(entregas.reduce((s, e) => s + (e.margem || 0), 0)))))),
        h('div', { class: 'linha fim' }, h('button', { onclick: baixarEntregas }, 'Baixar entregas (CSV)'))]);
    } catch (e) { trocar(saida, h('div', { class: 'erro' }, e.message)); }
  };
  trocar(els.pagina, 
    h('h2', null, 'Relatório'),
    h('p', { class: 'nota' }, 'A pagar = diárias × (valor da diária + almoço) + repasses das entregas feitas como avulso.'),
    h('div', { class: 'linha' },
      h('div', null, h('label', null, 'De'), de), h('div', null, h('label', null, 'Até'), ate),
      h('div', null, h('label', null, ' '), h('button', { class: 'primario', onclick: gerar }, 'Gerar'))),
    h('div', { class: 'nota' }, ' '), saida);
  gerar();
}

// ---------------------------------------------------------- configurações
async function desenharConfig() {
  let c;
  let servicos = [];
  let clientes = [];
  try {
    c = await api('GET', '/api/admin/config');
    ({ servicos } = await api('GET', '/api/admin/servicos'));
    ({ clientes } = await api('GET', '/api/admin/clientes'));
  } catch { return; }
  const avisoLista = h('div', { class: 'erro' });
  const janelaServico = (sv = null) => dialogo(sv ? 'Editar tipo de serviço' : 'Novo tipo de serviço', (dlg) => {
    const nome = h('input', { maxlength: 60, value: sv?.nome || '' });
    const adicional = h('input', { type: 'number', step: 0.01, min: 0, value: sv?.adicional ?? 0 });
    const pct = h('input', { type: 'number', step: 1, min: 0, max: 100, value: sv?.repasse_pct ?? '', placeholder: `Padrão (${c.repasse_pct}%)` });
    const ativo = h('input', { type: 'checkbox', checked: sv ? sv.ativo : true });
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(async () => {
        await api('POST', '/api/admin/servicos', { id: sv?.id, nome: nome.value, adicional: adicional.value, repasse_pct: pct.value, ativo: ativo.checked });
        desenharConfig();
      }, ok),
    }, 'Salvar');
    return [
      h('label', null, 'Nome (o cliente vê)'), nome,
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Soma no preço (R$)'), adicional),
        h('div', null, h('label', null, 'Repasse ao avulso (%)'), pct)),
      h('label', { class: 'marcar' }, ativo, 'Ativo (aparece para o cliente)'),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
  const janelaCliente = (cl = null) => dialogo(cl ? `Cliente ${cl.nome}` : 'Novo cliente fixo', (dlg) => {
    const nome = h('input', { maxlength: 120, value: cl?.nome || '' });
    const telefone = h('input', { inputmode: 'tel', value: cl ? telefoneFmt(cl.telefone) : '', disabled: Boolean(cl), placeholder: '(27) 99999-0000' });
    const email = h('input', { type: 'email', maxlength: 120, value: cl?.email || '' });
    const pct = h('input', { type: 'number', step: 1, min: 1, max: 300, value: cl?.preco_pct ?? 100 });
    const faturado = h('input', { type: 'checkbox', checked: cl ? cl.faturado : true });
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(async () => {
        await api('POST', '/api/admin/clientes', { nome: nome.value, telefone: telefone.value, email: email.value, preco_pct: pct.value, faturado: faturado.checked });
        desenharConfig();
      }, ok),
    }, 'Salvar');
    return [
      h('label', null, 'Nome da empresa ou pessoa'), nome,
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'WhatsApp (identifica o cliente)'), telefone),
        h('div', null, h('label', null, 'E-mail'), email)),
      h('label', null, 'Paga quanto da tabela? (%)'), pct,
      h('div', { class: 'nota' }, '100 = preço cheio. 80 = 20% de desconto.'),
      h('label', { class: 'marcar' }, faturado, 'Fatura mensal (não paga Pix na hora)'),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
  const campos = {};
  const num = (chave, rotulo, passo = 1) => {
    campos[chave] = h('input', { type: 'number', step: passo, value: c[chave] });
    return h('div', null, h('label', null, rotulo), campos[chave]);
  };
  const texto = (chave, rotulo, attrs = {}) => {
    campos[chave] = h('input', { value: c[chave] ?? '', ...attrs });
    return h('div', null, h('label', null, rotulo), campos[chave]);
  };
  const opcao = (chave, rotulo, opcoes = [['1', 'Sim'], ['0', 'Não']]) => {
    campos[chave] = h('select', null, opcoes.map(([v, r]) => h('option', { value: v, selected: c[chave] === v }, r)));
    return h('div', null, h('label', null, rotulo), campos[chave]);
  };
  const base = c.url_publica || location.origin;
  const webhook = `${base}/api/whatsapp/webhook?s=${c.whats_segredo}`;
  const avisoTeste = h('div', { class: 'nota' });
  const avisoIa = h('div', { class: 'nota' });
  campos.cidades_atendidas = h('input', { maxlength: 200, value: c.cidades_atendidas });
  campos.cidade_base = h('input', { maxlength: 120, value: c.cidade_base, placeholder: 'Ex.: Campinas, SP' });
  campos.termo_texto = h('textarea', { maxlength: 8000, value: c.termo_texto });
  const aviso = h('div', { class: 'erro' });
  const salvar = h('button', {
    class: 'primario',
    onclick: async () => {
      aviso.textContent = '';
      try {
        await api('PUT', '/api/admin/config', Object.fromEntries(Object.entries(campos).map(([k, el]) => [k, el.value])));
        aviso.textContent = 'Salvo.';
        enquadrado = false;
        atualizar();
      } catch (e) { aviso.textContent = e.message; }
    },
  }, 'Salvar configurações');

  const chaveSaida = h('div', null);
  const atual = h('input', { type: 'password', autocomplete: 'current-password' });
  const nova = h('input', { type: 'password', autocomplete: 'new-password' });
  const avisoSenha = h('div', { class: 'erro' });

  trocar(els.pagina, 
    h('h2', null, 'Configurações'),
    h('div', { class: 'linha fim barra-salvar' }, aviso, salvar),
    h('p', { class: 'nota' }, 'Toque em um título para abrir. "Salvar configurações" grava tudo de uma vez.'),
    h('h3', null, 'Turno e pagamento'),
    h('div', { class: 'grade3' },
      num('horas_turno', 'Duração do turno (horas)', 0.5), num('almoco_min', 'Almoço (minutos)'),
      num('prorrogacao_max_min', 'Prorrogação máx. com carga (min)'),
      num('diaria_valor', 'Valor da diária (R$)', 0.01), num('almoco_valor', 'Valor do almoço (R$)', 0.01),
      num('retencao_dias', 'Guardar localização por (dias)')),
    h('h3', null, 'Controle de rota'),
    h('div', { class: 'grade3' },
      num('parado_min', 'Alerta: parado na rota após (min)'), num('espera_parada_min', 'Espera tolerada na coleta/entrega (min)'),
      num('sem_sinal_min', 'Alerta: sem sinal após (min)'),
      num('cerca_m', 'Distância máx. para confirmar parada (m)'), num('bike_max_km', 'Trecho máximo para bike (km)', 0.5),
      num('capacidade', 'Demandas por motoboy antes de sugerir outro')),
    h('h3', null, 'Mapa'),
    h('div', { class: 'grade3' },
      h('div', null, h('label', null, 'Cidade base (ajuda a busca de endereço)'), campos.cidade_base),
      num('mapa_lat', 'Centro do mapa — latitude', 0.0001), num('mapa_lon', 'Centro do mapa — longitude', 0.0001)),
    h('div', { class: 'linha' }, h('button', {
      class: 'pequeno',
      onclick: () => { const p = mapa.getCenter(); campos.mapa_lat.value = p.lat.toFixed(4); campos.mapa_lon.value = p.lng.toFixed(4); },
    }, 'Usar o centro atual do mapa da Operação')),
    h('h3', null, 'Preço da entrega urgente (o cliente vê no site e no WhatsApp)'),
    h('div', { class: 'grade3' },
      num('preco_base', 'Valor base (R$)', 0.01), num('preco_km_incluso', 'Km já incluídos no valor base', 0.5),
      num('preco_km', 'Valor por km a mais (R$)', 0.01), num('preco_minimo', 'Valor mínimo (R$)', 0.01),
      num('preco_zona_sul', 'Acréscimo zona sul de Vila Velha (R$)', 0.01),
      num('urgente_pct', 'Urgente: % a mais', 1), num('urgente_min', 'Urgente: mínimo a mais (R$)', 0.01),
      num('urgente_repasse_pct', 'Urgente: % do extra para o motoboy', 1),
      num('tam_g_pct', 'Tamanho G (até 40 cm): % a mais (não vale em corrida longa)', 1), num('tam_gg_pct', 'Tamanho GG (mais de 40 cm): % a mais (não vale em corrida longa)', 1),
      num('tam_repasse_pct', 'Tamanho: % do extra para o motoboy', 1),
      num('longa_km1', 'Corrida longa 1: acima de (km)', 1), num('longa_preco1', 'Corrida longa 1: R$ por km acima do limite', 0.01),
      num('longa_km2', 'Corrida longa 2: acima de (km)', 1), num('longa_preco2', 'Corrida longa 2: R$ por km acima do limite', 0.01),
      num('longa_repasse_pct', 'Corrida longa: % do total para o motoboy', 1),
      num('repasse_base', 'Motoboy avulso recebe: valor base (R$)', 0.01), num('repasse_km', 'Motoboy avulso: por km a mais (R$)', 0.01),
      num('urgente_prazo_min', 'Prazo prometido na página (min)'),
      texto('google_chave', c.google_chave_definida ? 'Chave do Google Maps (já salva; vazio mantém)' : 'Chave do Google Maps (acha endereço e loja pelo nome)', { type: 'password', autocomplete: 'off', value: '' }),
      texto('ors_chave', c.ors_chave_definida ? 'Chave de rota (já salva; vazio mantém)' : 'Chave de rota pelas ruas (opcional)', { type: 'password', autocomplete: 'off', value: '' })),
    h('div', { class: 'nota' }, 'Preço = valor base + km a mais (respeitando o mínimo) + o adicional do tipo de serviço. Sem chave de rota a distância é linha reta × 1,35; com chave gratuita do openrouteservice.org é a distância pelas ruas.'),

    h('h3', null, 'Tipos de serviço (complexidade da demanda)'),
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Serviço'), h('th', { class: 'num' }, 'Soma no preço'), h('th', { class: 'num' }, 'Repasse ao avulso'), h('th', null, ''))),
      h('tbody', null, servicos.map((sv) => h('tr', null,
        h('td', null, sv.nome, !sv.ativo && chip('desligado', 'inativo')),
        h('td', { class: 'num' }, reais(sv.adicional)),
        h('td', { class: 'num' }, sv.repasse_pct == null ? `padrão (${c.repasse_pct}%)` : `${sv.repasse_pct}%`),
        h('td', null, h('button', { class: 'pequeno', onclick: () => janelaServico(sv) }, 'Editar')))))),
    h('div', { class: 'linha' }, h('button', { class: 'pequeno', onclick: () => janelaServico() }, '+ Novo tipo de serviço'), avisoLista),

    h('h3', null, 'Motoboy avulso: repasse e ofertas'),
    h('div', { class: 'grade3' },
      num('repasse_pct', 'Repasse padrão ao avulso (% do valor)'), num('repasse_minimo', 'Repasse mínimo por entrega (R$)', 0.01),
      num('oferta_raio_km', 'Oferecer a quem está até (km) da coleta', 0.5),
      num('oferta_alerta_min', 'Avisar se ninguém aceitar em (min)'), num('avulso_max_horas', 'Avulso fica online no máximo (horas)')),
    h('div', { class: 'nota' }, 'A oferta vai para todos os motoboys dentro dessa distância da coleta. A cada 1,5 min sem ninguém aceitar, a distância dobra (até 8 vezes) e mais motoboys recebem. Atenção: o repasse mínimo do motoboy tem que ser menor que o valor mínimo cobrado do cliente, senão a entrega dá prejuízo.'),

    h('h3', null, 'Pagamento por Pix'),
    h('div', { class: 'nota' }, 'Opção 1 — sua chave Pix (sem taxa): o cliente paga direto na sua conta e manda o comprovante; você confirma no painel ou respondendo "pago 12" no WhatsApp.'),
    h('div', { class: 'grade3' },
      opcao('pix_tipo', 'Tipo da chave', [['cnpj', 'CNPJ'], ['cpf', 'CPF'], ['telefone', 'Celular'], ['email', 'E-mail'], ['aleatoria', 'Chave aleatória']]),
      texto('pix_chave', 'Chave Pix', { maxlength: 80 }),
      texto('pix_nome', 'Nome de quem recebe (como no banco)', { maxlength: 25 }),
      texto('pix_cidade', 'Cidade da conta', { maxlength: 15, placeholder: 'Vila Velha' }),
      texto('empresa_whatsapp', 'WhatsApp que recebe o comprovante', { inputmode: 'tel', placeholder: '(27) 99999-0000' }),
      num('pagamento_validade_min', 'Lembrar/expirar o Pix após (min)')),
    h('div', { class: 'nota' }, 'Opção 2 — Mercado Pago (automático, taxa de 0,99% por Pix): o sistema confirma sozinho, sem você conferir.'),
    h('div', { class: 'grade3' },
      texto('mp_token', c.mp_token_definido ? 'Access Token (já salvo; vazio mantém)' : 'Access Token de produção (opcional)', { type: 'password', autocomplete: 'off', value: '' })),
    h('div', { class: 'nota' }, 'Depois escolha a opção em "Pedidos pelo site → Antes de despachar um pedido do site".'),

    h('h3', null, 'Conferência dos pedidos por IA'),
    h('div', { class: 'grade3' },
      opcao('ia_ativa', 'IA confere cada pedido antes de liberar'),
      texto('ia_chave', c.ia_chave_definida ? 'Chave da API (já salva; vazio mantém)' : 'Chave da API da Anthropic (sk-ant-...) ou ponte:TOKEN', { type: 'password', autocomplete: 'off', value: '' }),
      opcao('ia_modelo', 'Modelo', [['claude-opus-5-5', 'Claude Opus 5.5 (mais capaz)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (intermediário)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (mais barato)']])),
    h('label', null, 'Cidades atendidas'), campos.cidades_atendidas,
    h('div', { class: 'nota' }, 'A IA lê endereços e descrição (nunca nome ou telefone do cliente), identifica o tipo de serviço e segura para você conferir o que parecer errado. Se ela estiver fora do ar ou sem crédito, os pedidos seguem as regras normais. Gere a chave em console.anthropic.com → API Keys (precisa de crédito na conta). Salve antes de testar.'),
    h('div', { class: 'linha' },
      h('button', {
        onclick: async () => {
          avisoIa.textContent = 'Consultando a IA…';
          try { avisoIa.textContent = (await api('POST', '/api/admin/ia-teste')).mensagem; } catch (e) { avisoIa.textContent = e.message; }
        },
      }, 'Testar a IA'), avisoIa),
    estado?.ia.erro && h('div', { class: 'erro' }, `Último erro da IA: ${estado.ia.erro}`),

    h('h3', null, 'Clientes (marque os fixos para fatura mensal)'),
    clientes.length === 0 ? h('div', { class: 'vazio' }, 'Nenhum cliente ainda. Quem pede pelo site ou WhatsApp aparece aqui sozinho.')
      : h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Cliente'), h('th', null, 'WhatsApp'), h('th', { class: 'num' }, 'Pedidos'), h('th', null, 'Cobrança'), h('th', null, ''))),
        h('tbody', null, clientes.slice(0, 100).map((cl) => h('tr', null,
          h('td', null, cl.nome), h('td', null, telefoneFmt(cl.telefone)), h('td', { class: 'num' }, cl.pedidos),
          h('td', null, cl.faturado ? chip(`Fatura · ${cl.preco_pct}% da tabela`, 'entregue') : 'Pix na hora'),
          h('td', null, h('button', { class: 'pequeno', onclick: () => janelaCliente(cl) }, 'Editar')))))),
    h('div', { class: 'linha' }, h('button', { class: 'pequeno', onclick: () => janelaCliente() }, '+ Novo cliente fixo')),

    h('h3', null, 'Pedidos pelo site'),
    h('div', { class: 'grade3' },
      texto('empresa_nome', 'Nome que aparece para o cliente', { maxlength: 60 }),
      opcao('pedidos_site', 'Aceitar pedidos pelo site'),
      opcao('site_confirmacao', 'Antes de despachar um pedido do site', [
        ['pix', 'Cliente paga no meu Pix e manda o comprovante'], ['pagamento', 'Pix automático do Mercado Pago (taxa 0,99%)'], ['painel', 'Eu aprovo no painel'], ['whatsapp', 'Cliente confirma no WhatsApp (automático)'], ['nenhuma', 'Despacha direto (sem conferir)']]),
      texto('atendimento_inicio', 'Atende a partir de (vazio = sempre)', { type: 'time' }),
      texto('atendimento_fim', 'Atende até', { type: 'time' }),
      opcao('rastreio_cliente', 'Cliente vê o motoboy no mapa')),
    h('div', { class: 'nota' }, 'Link para divulgar aos clientes:'),
    h('div', { class: 'codigo' }, `${base}/pedir/`),
    h('div', { class: 'nota' }, '"Cliente vê o motoboy no mapa": antes de ligar, inclua isso no termo do motoboy (abaixo).'),

    h('h3', null, 'WhatsApp automático (robô de pedidos, avisos ao cliente e convocação)'),
    h('div', { class: 'cartao alerta' },
      h('div', { class: 'titulo' }, 'Só conexão oficial da Meta'),
      h('div', { class: 'sub' }, 'Nunca ligue o número por QR code do WhatsApp Web (Evolution, Baileys, whatsapp-web.js, Whapi e afins): a Meta pode banir o número. Use a WhatsApp Cloud API em coexistência: o mesmo número continua no app WhatsApp Business do celular e a API funciona junto.')),
    h('div', { class: 'grade3' },
      opcao('whats_provedor', 'Conexão', [['', 'Desligado'], ['meta', 'WhatsApp Cloud API oficial da Meta (coexistência)'], ['webhook', 'Outro (n8n, Make) ligado a provedor OFICIAL']]),
      texto('whats_url', 'Endereço da API (vazio = Meta direto)', { maxlength: 300, placeholder: 'https://graph.facebook.com/v21.0' }),
      texto('whats_instancia', 'ID do número (Phone Number ID)', { maxlength: 120 }),
      texto('whats_token', c.whats_token_definido ? 'Token de acesso (já salvo; vazio mantém)' : 'Token de acesso permanente', { type: 'password', autocomplete: 'off', value: '' }),
      texto('whats_app_secret', c.whats_app_secret_definido ? 'App Secret (já salvo; vazio mantém)' : 'App Secret (confere a assinatura da Meta)', { type: 'password', autocomplete: 'off', value: '' }),
      num('robo_pausa_horas', 'Robô fica calado após resposta pelo app (horas)'),
      texto('admin_telefone', 'WhatsApp do responsável (recebe avisos)', { inputmode: 'tel', placeholder: '(11) 99999-0000' }),
      texto('url_publica', 'Endereço deste sistema (para os links)', { maxlength: 200, placeholder: location.origin }),
      opcao('robo_ativo', 'Robô atende e monta o pedido sozinho'),
      opcao('avisos_cliente', 'Avisar o cliente a cada etapa'),
      opcao('convocacao_obrigatoria', 'Motoboy de diária só entra se for convocado'),
      opcao('convocacao_auto', 'Convocar motoboy sozinho quando faltar gente'),
      num('convocacao_auto_max', 'Máx. de convocações automáticas por dia'),
      num('convocacao_auto_espera_min', 'Demanda esperando há (min) para convocar')),
    h('div', { class: 'nota' }, 'Na Meta: cadastre este endereço como URL de retorno do webhook; o "token de verificação" é o trecho depois de s=. Assine os campos messages e smb_message_echoes (este último é o que avisa quando alguém responde pelo app do celular; aí o robô se cala naquela conversa). Fora da janela de 24 h a Meta só aceita modelo aprovado: avisos e convocações para quem não escreveu recentemente podem não chegar.'),
    h('div', { class: 'codigo' }, webhook),
    h('div', { class: 'nota' }, 'Cada convocação automática gera uma diária: o limite por dia protege seu caixa. Salve antes de testar.'),
    h('div', { class: 'linha' },
      h('button', {
        onclick: async () => {
          avisoTeste.textContent = 'Enviando…';
          try { await api('POST', '/api/admin/whatsapp-teste'); avisoTeste.textContent = 'Mensagem de teste enviada para o WhatsApp do responsável.'; } catch (e) { avisoTeste.textContent = e.message; }
        },
      }, 'Enviar mensagem de teste'), avisoTeste),
    estado?.whatsapp.ultimo_erro && h('div', { class: 'erro' }, `Último erro de envio: ${estado.whatsapp.ultimo_erro}`),

    h('h3', null, `Termo aceito pelo motoboy a cada login (versão ${c.termo_versao})`),
    campos.termo_texto,
    h('div', { class: 'nota' }, 'Modelo inicial: peça para seu advogado ou contador revisar antes de usar.'),

    h('h3', null, 'Entrada automática de demandas (app de clientes, Make, WhatsApp)'),
    h('p', { class: 'nota' }, c.api_chave_definida ? 'Já existe uma chave ativa. Gerar outra cancela a anterior.' : 'Nenhuma chave gerada ainda.'),
    h('button', {
      onclick: async () => {
        try {
          const { chave } = await api('POST', '/api/admin/chave-api');
          trocar(chaveSaida, 
            h('p', { class: 'nota' }, 'Copie agora: a chave não será mostrada de novo.'),
            h('div', { class: 'codigo' }, chave),
            h('p', { class: 'nota' }, 'Como enviar uma demanda:'),
            h('div', { class: 'codigo' }, `POST ${location.origin}/api/entrada/demandas\nX-Api-Key: (a chave acima)\nContent-Type: application/json\n\n{ "cliente": "Loja X", "requisito": "bau", "descricao": "2 caixas",\n  "coleta":  { "endereco": "Rua A, 100", "contato": "Maria" },\n  "entrega": { "endereco": "Rua B, 200", "contato": "João" } }`));
        } catch (e) { trocar(chaveSaida, h('div', { class: 'erro' }, e.message)); }
      },
    }, 'Gerar nova chave'),
    chaveSaida,

    h('h3', null, 'Senha do painel'),
    h('div', { class: 'grade3' },
      h('div', null, h('label', null, 'Senha atual'), atual),
      h('div', null, h('label', null, 'Nova senha (mín. 10 caracteres)'), nova),
      h('div', null, h('label', null, ' '), h('button', {
        onclick: async () => {
          try { await api('POST', '/api/admin/senha', { atual: atual.value, nova: nova.value }); telaLogin(); } catch (e) { avisoSenha.textContent = e.message; }
        },
      }, 'Trocar senha'))),
    avisoSenha);

  // Cada seção (h3) vira uma gaveta fechada: a página fica curta e abre só o que interessa.
  let atualGaveta = null;
  for (const no of [...els.pagina.children]) {
    if (no.tagName === 'H3') {
      const titulo = no.textContent;
      const chave = `cfg:${titulo.replace(/\(.*$/, '').trim()}`;
      atualGaveta = gaveta(chave, false, { class: 'cartao gaveta-config' }, h('summary', null, titulo));
      no.replaceWith(atualGaveta);
    } else if (atualGaveta) {
      atualGaveta.append(no);
    }
  }
}

// ----------------------------------------------------------------- início
api('GET', '/api/admin/estado').then(() => telaPrincipal()).catch(() => telaLogin());

// Permite instalar o painel como aplicativo no celular (ícone na tela inicial, tela cheia).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
