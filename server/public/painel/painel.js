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
  parado: 'Parado na rota', sem_sinal: 'Sem sinal', gps_falso: 'GPS falso', gps_desligado: 'GPS desligado',
  salto: 'Salto de posição', fora_do_local: 'Confirmou longe do local', troca_aparelho: 'Trocou de aparelho',
  carga_pendente: 'Turno encerrado com carga',
};
const ROTULO_REQUISITO = { qualquer: 'Qualquer', moto: 'Só moto', bau: 'Baú', bag: 'Bag' };
const chip = (texto, classe = '') => h('span', { class: `chip ${classe}` }, texto);
const equipamento = (m) => [m.veiculo === 'bike' ? 'Bike' : 'Moto', m.tem_bau && 'baú', m.tem_bag && 'bag'].filter(Boolean).join(' · ');

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
      try { await fn(); fechar(); atualizar(); } catch (e) { erro.textContent = e.message; } finally { if (botao) botao.disabled = false; }
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

function pararAtualizacao() { clearInterval(temporizador); temporizador = null; }

function telaPrincipal() {
  const abas = [['operacao', 'Operação'], ['motoboys', 'Motoboys'], ['relatorio', 'Relatório'], ['config', 'Configurações']];
  els.conexao = h('span', { class: 'conexao' });
  els.botoesAba = abas.map(([id, nome]) => h('button', { 'data-aba': id, onclick: () => abrirAba(id) }, nome));
  els.mapa = h('div', { id: 'mapa' });
  els.lateral = h('div', { class: 'lateral' });
  els.operacao = h('div', { class: 'operacao' }, els.mapa, els.lateral);
  els.pagina = h('div', { class: 'pagina' });
  trocar(raiz, 
    h('div', { class: 'topo' },
      h('div', { class: 'logo' }, 'Speed ', h('span', null, 'Despacho')),
      els.botoesAba, h('div', { class: 'espaco' }), els.conexao,
      h('button', { onclick: async () => { await api('POST', '/api/admin/logout').catch(() => {}); telaLogin(); } }, 'Sair')),
    els.operacao, els.pagina);

  mapa = L.map(els.mapa, { zoomControl: true }).setView([-23.5505, -46.6333], 12);
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
  if (id === 'config') desenharConfig();
}

async function atualizar() {
  try {
    estado = await api('GET', '/api/admin/estado');
    els.conexao.textContent = '';
  } catch (e) {
    if (e.status !== 401) els.conexao.textContent = 'Sem conexão com o servidor';
    return;
  }
  // Não redesenha por cima de quem está digitando ou com janela aberta.
  if (document.querySelector('dialog[open]')) return;
  if (abaAtual === 'operacao') desenhar();
  if (abaAtual === 'motoboys') desenharMotoboys();
}

// --------------------------------------------------------------- operação
function desenhar() {
  if (!estado) return;
  desenharMapa();
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
    const coleta = [d.coleta_lat, d.coleta_lon];
    const entrega = [d.entrega_lat, d.entrega_lon];
    const info = () => h('div', null,
      h('b', null, `#${d.id} ${d.cliente}`), h('br'),
      `Coleta: ${d.coleta_endereco}`, h('br'), `Entrega: ${d.entrega_endereco}`, h('br'),
      d.motoboy_id ? `Motoboy: ${nomes.get(d.motoboy_id) || '—'}` : 'Aguardando motoboy');
    if (d.status !== 'coletada') {
      L.marker(coleta, { icon: dimensionar(icone(`ponto ${d.status === 'aguardando' ? 'espera' : 'coleta'}`, 'C', 22), 22) })
        .bindPopup(info).addTo(camadas.demandas);
      limites.push(coleta);
    }
    L.marker(entrega, { icon: dimensionar(icone('ponto entrega', 'E', 22), 22) }).bindPopup(info).addTo(camadas.demandas);
    L.polyline([coleta, entrega], { color: '#7c3aed', weight: 2, dashArray: '5 6', opacity: 0.7 }).addTo(camadas.demandas);
    limites.push(entrega);
  }

  for (const m of estado.motoboys) {
    const t = m.turno;
    if (!t || t.lat == null) continue;
    const classe = `pino ${t.status}${alertados.has(m.id) ? ' alertado' : ''}`;
    L.marker([t.lat, t.lon], { icon: dimensionar(icone(classe, iniciais(m.nome), 34), 34), zIndexOffset: 500 })
      .bindPopup(() => h('div', null,
        h('b', null, m.nome), h('br'), `${ROTULO_STATUS[t.status]} · ${t.pendentes} parada(s)`, h('br'),
        `Último sinal ${ha(t.ult_contato ?? t.inicio, estado.agora)}`))
      .addTo(camadas.motoboys);
    limites.push([t.lat, t.lon]);
  }

  if (!enquadrado) {
    enquadrado = true;
    if (limites.length) mapa.fitBounds(limites, { padding: [40, 40], maxZoom: 15 });
    else mapa.setView([estado.mapa.lat, estado.mapa.lon], 12);
  }
}

function desenharLateral() {
  const { agora } = estado;
  const emTurno = estado.motoboys.filter((m) => m.turno);
  const nomes = new Map(estado.motoboys.map((m) => [m.id, m.nome]));
  const abertas = estado.demandas.filter((d) => ['atribuida', 'coletada'].includes(d.status));
  const fila = estado.demandas.filter((d) => d.status === 'aguardando');
  const semLocal = estado.demandas.filter((d) => d.status === 'sem_local');
  const fechadas = estado.demandas.filter((d) => ['entregue', 'cancelada'].includes(d.status));
  const alertasAbertos = estado.alertas.filter((a) => a.fim == null);
  const alertasHoje = estado.alertas.filter((a) => a.fim != null);

  const cartaoAlerta = (a) => h('div', { class: `cartao ${a.fim == null ? 'alerta' : ''}` },
    h('div', { class: 'titulo' }, `${ROTULO_ALERTA[a.tipo] || a.tipo} — ${a.motoboy}`),
    h('div', { class: 'sub' },
      a.fim == null ? `Começou ${hora(a.inicio)} (${ha(a.inicio, agora)})`
        : a.fim === a.inicio ? `Às ${hora(a.inicio)}` : `${hora(a.inicio)} a ${hora(a.fim)} (${duracao(a.fim - a.inicio)})`),
    a.detalhe && h('div', { class: 'sub' }, a.detalhe));

  const cartaoDemanda = (d) => h('div', { class: 'cartao' },
    h('div', { class: 'titulo' }, `#${d.id} ${d.cliente}`, chip(ROTULO_STATUS[d.status], d.status),
      d.requisito !== 'qualquer' && chip(ROTULO_REQUISITO[d.requisito])),
    h('div', { class: 'sub' }, `C: ${d.coleta_endereco}`),
    h('div', { class: 'sub' }, `E: ${d.entrega_endereco}`),
    d.descricao && h('div', { class: 'sub' }, d.descricao),
    h('div', { class: 'sub' },
      d.motoboy_id ? `${nomes.get(d.motoboy_id) || '—'} · ` : '',
      d.status === 'entregue' ? `entregue ${hora(d.entregue_em)} para ${d.recebedor || '—'}`
        : d.status === 'cancelada' ? `cancelada ${hora(d.cancelada_em)}`
          : d.status === 'coletada' ? `coletada ${hora(d.coletada_em)}`
            : `criada ${hora(d.criada_em)} (${ha(d.criada_em, agora)})`),
    !['entregue', 'cancelada'].includes(d.status) && h('div', { class: 'acoes' },
      d.status === 'sem_local'
        ? h('button', { class: 'pequeno primario', onclick: () => janelaDemanda(d) }, 'Marcar no mapa')
        : h('button', { class: 'pequeno', onclick: () => janelaTrocar(d) }, d.motoboy_id ? 'Trocar motoboy' : 'Escolher motoboy'),
      h('button', {
        class: 'pequeno perigo',
        onclick: () => confirmar('Cancelar demanda', `Cancelar a demanda #${d.id} de ${d.cliente}?`, 'Cancelar demanda',
          () => api('POST', `/api/admin/demandas/${d.id}/cancelar`)),
      }, 'Cancelar')));

  const cartaoMotoboy = (m) => {
    const t = m.turno;
    return h('div', { class: 'cartao' },
      h('div', { class: 'titulo' }, m.nome, chip(ROTULO_STATUS[t.status], t.status),
        t.origem !== 'app' && chip('navegador', 'aguardando')),
      h('div', { class: 'sub' }, `${equipamento(m)} · ${t.pendentes} parada(s) · ${t.km} km`,
        t.bateria != null ? ` · bateria ${t.bateria}%` : ''),
      h('div', { class: 'sub' }, `Turno ${hora(t.inicio)}–${hora(t.fim_previsto)} · último sinal ${ha(t.ult_contato ?? t.inicio, agora)}`,
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
      h('div', null, h('b', null, fila.length + semLocal.length), h('span', null, 'aguardando'))),
    h('button', { class: 'primario', onclick: () => janelaDemanda() }, '+ Nova demanda'),

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
    alertasHoje.length > 0 && h('details', null, h('summary', null, `Alertas encerrados hoje (${alertasHoje.length})`), alertasHoje.map(cartaoAlerta)),

    semLocal.length > 0 && [h('h3', null, 'Sem local no mapa'), semLocal.map(cartaoDemanda)],
    h('h3', null, `Aguardando motoboy (${fila.length})`),
    fila.length ? fila.map(cartaoDemanda) : h('div', { class: 'vazio' }, 'Nada na fila.'),
    h('h3', null, `Em andamento (${abertas.length})`),
    abertas.length ? abertas.map(cartaoDemanda) : h('div', { class: 'vazio' }, 'Nenhuma entrega em andamento.'),
    fechadas.length > 0 && h('details', null, h('summary', null, `Finalizadas hoje (${fechadas.length})`), fechadas.map(cartaoDemanda)),

    h('h3', null, `Motoboys em turno (${emTurno.length})`),
    emTurno.length ? emTurno.map(cartaoMotoboy) : h('div', { class: 'vazio' }, 'Ninguém em turno. Convoque na aba Motoboys.'));
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
function janelaDemanda(existente = null) {
  const pontos = {
    coleta: { lat: existente?.coleta_lat ?? null, lon: existente?.coleta_lon ?? null, marcador: null },
    entrega: { lat: existente?.entrega_lat ?? null, lon: existente?.entrega_lon ?? null, marcador: null },
  };
  let alvo = pontos.coleta.lat == null ? 'coleta' : 'entrega';
  let mini = null;

  dialogo(existente ? `Demanda #${existente.id} — marcar locais` : 'Nova demanda', (dlg) => {
    const cliente = h('input', { maxlength: 120, value: existente?.cliente || '', disabled: Boolean(existente) });
    const requisito = h('select', { disabled: Boolean(existente) },
      Object.entries(ROTULO_REQUISITO).map(([v, r]) => h('option', { value: v, selected: existente?.requisito === v }, r)));
    const descricao = h('input', { maxlength: 500, value: existente?.descricao || '', disabled: Boolean(existente), placeholder: 'O que é, observações' });
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
      const endereco = h('input', { maxlength: 200, value: existente?.[`${qual}_endereco`] || '', placeholder: 'Rua, número, bairro' });
      const contato = h('input', { maxlength: 120, value: existente?.[`${qual}_contato`] || '', disabled: Boolean(existente), placeholder: 'Nome / telefone no local' });
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
      campos[qual] = { endereco, contato, situacao };
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
          await api('PUT', `/api/admin/demandas/${existente.id}/locais`, { coleta: ponto('coleta'), entrega: ponto('entrega') });
        } else {
          await api('POST', '/api/admin/demandas', {
            cliente: cliente.value, requisito: requisito.value, descricao: descricao.value,
            coleta: ponto('coleta'), entrega: ponto('entrega'),
          });
        }
      }, salvar),
    }, existente ? 'Salvar e despachar' : 'Criar e despachar');

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
    }, 0);

    return [
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Cliente'), cliente),
        h('div', null, h('label', null, 'Exige'), requisito)),
      h('label', null, 'Descrição'), descricao,
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
        h('a', {
          class: 'botao primario', href: `https://wa.me/55${m.telefone}?text=${encodeURIComponent(texto)}`,
          target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(dlg.fechar, 200),
        }, 'Avisar pelo WhatsApp'))]);
  } catch (e) { els.conexao.textContent = e.message; }
}

function janelaMotoboy(m = null) {
  dialogo(m ? `Editar ${m.nome}` : 'Novo motoboy', (dlg) => {
    const nome = h('input', { maxlength: 80, value: m?.nome || '' });
    const telefone = h('input', { inputmode: 'tel', value: m ? telefoneFmt(m.telefone) : '', placeholder: '(11) 99999-0000' });
    const pin = h('input', { inputmode: 'numeric', maxlength: 6, autocomplete: 'off', placeholder: m ? 'Deixe vazio para manter' : '6 números' });
    const veiculo = h('select', null, h('option', { value: 'moto', selected: m?.veiculo !== 'bike' }, 'Moto'), h('option', { value: 'bike', selected: m?.veiculo === 'bike' }, 'Bike'));
    const bau = h('input', { type: 'checkbox', checked: m?.tem_bau });
    const bag = h('input', { type: 'checkbox', checked: m?.tem_bag });
    const ativo = h('input', { type: 'checkbox', checked: m ? m.ativo : true });
    const gerar = h('button', { type: 'button', onclick: () => { pin.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0'); } }, 'Gerar');
    const ok = h('button', {
      class: 'primario',
      onclick: () => dlg.executar(() => {
        const dados = { nome: nome.value, telefone: telefone.value, pin: pin.value, veiculo: veiculo.value, tem_bau: bau.checked, tem_bag: bag.checked, ativo: ativo.checked };
        return m ? api('PUT', `/api/admin/motoboys/${m.id}`, dados) : api('POST', '/api/admin/motoboys', dados);
      }, ok),
    }, 'Salvar');
    return [
      h('label', null, 'Nome'), nome,
      h('div', { class: 'grade2' },
        h('div', null, h('label', null, 'Telefone com DDD (é o login)'), telefone),
        h('div', null, h('label', null, 'Senha do app (6 números)'), h('div', { class: 'linha' }, h('div', { class: 'cresce' }, pin), gerar))),
      h('div', { class: 'nota' }, 'Anote a senha e passe ao motoboy: depois de salvar ela não aparece mais.'),
      h('label', null, 'Veículo'), veiculo,
      h('label', { class: 'marcar' }, bau, 'Tem baú'),
      h('label', { class: 'marcar' }, bag, 'Tem bag'),
      m && h('label', { class: 'marcar' }, ativo, 'Ativo (desmarcar bloqueia o login e encerra o turno)'),
      h('div', { class: 'linha fim' }, h('button', { onclick: dlg.fechar }, 'Voltar'), ok)];
  });
}

function desenharMotoboys() {
  if (!estado) return;
  const situacao = (m) => {
    if (!m.ativo) return chip('Inativo', 'inativo');
    if (m.turno) return chip(`Em turno até ${hora(m.turno.fim_previsto)}`, 'em_rota');
    if (m.convocado_ate) return chip('Convocado, aguardando login', 'convocado');
    return h('span', { class: 'nota' }, m.ultimo_turno ? `Último turno ${dataHora(m.ultimo_turno)}` : 'Nunca fez turno');
  };
  trocar(els.pagina, 
    h('div', { class: 'linha' }, h('h2', { class: 'cresce' }, 'Motoboys'),
      h('button', { class: 'primario', onclick: () => janelaMotoboy() }, '+ Novo motoboy')),
    h('p', { class: 'nota' }, 'O motoboy só consegue fazer login no dia em que for convocado. O turno dura o tempo definido em Configurações.'),
    estado.motoboys.length === 0 ? h('div', { class: 'vazio' }, 'Nenhum motoboy cadastrado ainda.')
      : h('table', null,
        h('thead', null, h('tr', null, ['Nome', 'Telefone', 'Equipamento', 'Situação', ''].map((c) => h('th', null, c)))),
        h('tbody', null, estado.motoboys.map((m) => h('tr', null,
          h('td', null, m.nome), h('td', null, telefoneFmt(m.telefone)), h('td', null, equipamento(m)), h('td', null, situacao(m)),
          h('td', null, h('div', { class: 'linha' },
            m.ativo && !m.turno && !m.convocado_ate && h('button', { class: 'pequeno primario', onclick: () => convocar(m.id) }, 'Convocar'),
            m.convocado_ate && h('button', {
              class: 'pequeno', onclick: async () => { await api('POST', `/api/admin/motoboys/${m.id}/desconvocar`).catch(() => {}); atualizar(); },
            }, 'Cancelar convocação'),
            h('button', { class: 'pequeno', onclick: () => janelaMotoboy(m) }, 'Editar'))))))));
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
      const { linhas } = await api('GET', `/api/admin/relatorio?de=${inicio}&ate=${fim}`);
      const colunas = [['nome', 'Motoboy'], ['diarias', 'Diárias'], ['horas', 'Horas'], ['entregas', 'Entregas'], ['km', 'Km'], ['min_parado', 'Min. parado em alerta'], ['alertas', 'Alertas'], ['valor', 'A pagar']];
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
            h('td', { class: k === 'nome' ? '' : 'num' }, k === 'valor' ? reais(l.valor) : l[k]))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: 7 }, 'Total'), h('td', { class: 'num' }, reais(total))))),
        h('div', { class: 'linha fim' }, h('button', { onclick: baixar }, 'Baixar planilha (CSV)'))]);
    } catch (e) { trocar(saida, h('div', { class: 'erro' }, e.message)); }
  };
  trocar(els.pagina, 
    h('h2', null, 'Relatório de diárias'),
    h('p', { class: 'nota' }, 'A pagar = diárias × (valor da diária + almoço), conforme Configurações.'),
    h('div', { class: 'linha' },
      h('div', null, h('label', null, 'De'), de), h('div', null, h('label', null, 'Até'), ate),
      h('div', null, h('label', null, ' '), h('button', { class: 'primario', onclick: gerar }, 'Gerar'))),
    h('div', { class: 'nota' }, ' '), saida);
  gerar();
}

// ---------------------------------------------------------- configurações
async function desenharConfig() {
  let c;
  try { c = await api('GET', '/api/admin/config'); } catch { return; }
  const campos = {};
  const num = (chave, rotulo, passo = 1) => {
    campos[chave] = h('input', { type: 'number', step: passo, value: c[chave] });
    return h('div', null, h('label', null, rotulo), campos[chave]);
  };
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
      } catch (e) { aviso.textContent = e.message; }
    },
  }, 'Salvar configurações');

  const chaveSaida = h('div', null);
  const atual = h('input', { type: 'password', autocomplete: 'current-password' });
  const nova = h('input', { type: 'password', autocomplete: 'new-password' });
  const avisoSenha = h('div', { class: 'erro' });

  trocar(els.pagina, 
    h('h2', null, 'Configurações'),
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
    h('h3', null, `Termo aceito pelo motoboy a cada login (versão ${c.termo_versao})`),
    campos.termo_texto,
    h('div', { class: 'nota' }, 'Modelo inicial: peça para seu advogado ou contador revisar antes de usar.'),
    h('div', { class: 'linha fim' }, aviso, salvar),

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
}

// ----------------------------------------------------------------- início
api('GET', '/api/admin/estado').then(() => telaPrincipal()).catch(() => telaLogin());
