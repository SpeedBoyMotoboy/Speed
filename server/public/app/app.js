// Tela do motoboy. Roda dentro do app Android (que faz o rastreio em segundo plano)
// ou, para teste, direto no navegador (aí o rastreio só funciona com a tela ligada).
const raiz = document.getElementById('raiz');
const nativo = window.SpeedNativo || null;
const CHAVE_TOKEN = 'speed_token';
const CHAVE_ROTA = 'speed_rota_versao';

function h(tag, attrs, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = Boolean(v);
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

let token = localStorage.getItem(CHAVE_TOKEN);
let estado = null;
let ciclo = null;
let formAberto = false; // não redesenhar enquanto o motoboy digita

class ErroApi extends Error {
  constructor(status, corpo) {
    super(corpo?.mensagem || 'Sem conexão. Tente de novo.');
    this.status = status;
    this.codigo = corpo?.erro;
  }
}
async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(metodo === 'GET' ? {} : { 'Content-Type': 'application/json' }),
      },
      body: metodo === 'GET' ? undefined : JSON.stringify(corpo || {}),
    });
  } catch {
    throw new ErroApi(0, null);
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new ErroApi(r.status, json);
  return json;
}

const doisDig = (n) => String(n).padStart(2, '0');
const reais = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hora = (ts) => { const d = new Date(ts); return `${doisDig(d.getHours())}:${doisDig(d.getMinutes())}`; };
const infoNativo = () => { try { return JSON.parse(nativo.info()); } catch { return {}; } };

function idAparelho() {
  if (nativo) return infoNativo().dispositivo || 'android';
  let id = localStorage.getItem('speed_aparelho');
  if (!id) { id = `web-${crypto.randomUUID()}`; localStorage.setItem('speed_aparelho', id); }
  return id;
}

function avisarNovaRota() {
  try { navigator.vibrate?.([300, 150, 300]); } catch { /* sem vibração */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* sem som */ }
}

// ------------------------------------------- rastreio pelo navegador (reserva)
const fila = [];
let observador = null;
let envio = null;
let ultimaPosicao = null;
function iniciarRastreioWeb() {
  if (nativo || observador != null || !navigator.geolocation) return;
  observador = navigator.geolocation.watchPosition((p) => {
    ultimaPosicao = { lat: p.coords.latitude, lon: p.coords.longitude };
    const ponto = { ...ultimaPosicao, ts: Date.now(), precisao: p.coords.accuracy, velocidade: p.coords.speed };
    const ultimo = fila[fila.length - 1];
    if (ultimo && ponto.ts - ultimo.ts < 5000) fila[fila.length - 1] = ponto; else fila.push(ponto);
    if (fila.length > 2000) fila.shift();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  envio = setInterval(enviarFila, 15000);
}
async function enviarFila() {
  const lote = fila.splice(0, fila.length);
  try {
    await api('POST', '/api/motoboy/posicoes', { pontos: lote });
  } catch (e) {
    if (e.status === 401) return encerrado();
    fila.unshift(...lote); // sem internet: guarda e manda depois
  }
  return undefined;
}
function pararRastreioWeb() {
  if (observador != null) navigator.geolocation.clearWatch(observador);
  clearInterval(envio);
  observador = null;
}

// ------------------------------------------------------------------ login
async function telaLogin(mensagem = '') {
  clearInterval(ciclo);
  pararRastreioWeb();
  let termo = { texto: 'Não foi possível carregar o termo. Verifique a internet.', versao: '' };
  try { termo = await api('GET', '/api/termo'); } catch { /* mostra o aviso acima */ }

  const telefone = h('input', { inputmode: 'tel', autocomplete: 'username', placeholder: '(11) 99999-0000', value: localStorage.getItem('speed_telefone') || '' });
  const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'current-password', placeholder: '6 números' });
  const aceito = h('input', { type: 'checkbox', checked: true });
  const erro = h('div', { class: 'erro', role: 'alert' }, mensagem);
  const entrar = h('button', { class: 'primario grande', type: 'submit' }, 'Iniciar turno');
  const pendencias = h('div', { class: 'cartao' });
  let conferencia = null;

  function conferir() {
    if (!nativo) {
      trocar(pendencias, h('div', { class: 'nota' },
        'Modo navegador: a localização só é enviada com esta tela aberta. Para o trabalho, use o app Speed Motoboy no Android.'));
      return;
    }
    const i = infoNativo();
    const itens = [['Permissão de localização', i.permLocal], ['GPS ligado', i.gpsLigado], ['Notificações', i.permNotif], ['Bateria sem restrição', i.bateriaLivre]];
    const falta = itens.some(([, ok]) => !ok);
    trocar(pendencias, 
      itens.map(([nome, ok]) => h('div', { class: 'pendencia' }, nome, h('span', { class: ok ? 'sim' : 'nao' }, ok ? 'OK' : 'Falta'))),
      falta && h('div', { class: 'botoes' }, h('button', { type: 'button', onclick: () => nativo.pedirPermissoes() }, 'Liberar o que falta')));
    entrar.disabled = !(i.permLocal && i.gpsLigado);
  }

  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      if (!aceito.checked) { erro.textContent = 'Marque "Aceito os termos".'; return; }
      entrar.disabled = true;
      try {
        if (!nativo) await pedirLocalizacaoWeb();
        token = null;
        const r = await api('POST', '/api/motoboy/login', {
          telefone: telefone.value, pin: pin.value, aceito_termo: true,
          dispositivo: idAparelho(), origem: nativo ? 'app' : 'navegador',
        });
        token = r.token;
        localStorage.setItem(CHAVE_TOKEN, token);
        localStorage.setItem('speed_telefone', telefone.value);
        localStorage.removeItem(CHAVE_ROTA);
        clearInterval(conferencia);
        if (nativo) nativo.iniciarTurno(token, r.fim_previsto);
        telaTurno();
      } catch (e) {
        erro.textContent = e.message;
        entrar.disabled = false;
      }
    },
  },
  h('label', null, 'Telefone com DDD'), telefone,
  h('label', null, 'Senha'), pin,
  h('label', { class: 'marcar' }, aceito, 'Aceito os termos'),
  h('details', { class: 'ver-termo' }, h('summary', null, 'Ver termos'), h('div', { class: 'termo', tabindex: 0 }, termo.texto)),
  erro, h('div', { class: 'botoes' }, entrar));

  trocar(raiz, 
    h('div', { class: 'topo' }, h('div', { class: 'nome' }, 'Speed ', h('span', null, 'Motoboy')),
      h('div', { class: 'info' }, 'Diária: o login só funciona no dia da convocação. Avulso: entre quando quiser.')),
    h('div', { class: 'conteudo' }, pendencias, form));
  conferir();
  if (nativo) conferencia = setInterval(conferir, 2000);
}

function pedirLocalizacaoWeb() {
  return new Promise((ok, falha) => {
    if (!navigator.geolocation) return falha(new Error('Este aparelho não tem localização.'));
    return navigator.geolocation.getCurrentPosition(() => ok(), () => falha(new Error('Libere a localização para iniciar o turno.')),
      { enableHighAccuracy: true, timeout: 20000 });
  });
}

// ------------------------------------------------------------------ turno
function encerrado() {
  clearInterval(ciclo);
  pararRastreioWeb();
  token = null;
  localStorage.removeItem(CHAVE_TOKEN);
  if (nativo) nativo.pararTurno();
  telaLogin('Turno encerrado. Obrigado!');
}

async function buscarEstado() {
  try {
    estado = await api('GET', '/api/motoboy/estado');
    estado.semConexao = false;
  } catch (e) {
    if (e.status === 401) return encerrado();
    if (estado) estado.semConexao = true;
  }
  if (!estado) return undefined;
  const vista = Number(localStorage.getItem(CHAVE_ROTA) ?? -1);
  if (estado.rota_versao > vista) {
    if (vista >= 0 && (estado.rota.length || estado.ofertas.length)) avisarNovaRota();
    localStorage.setItem(CHAVE_ROTA, String(estado.rota_versao));
  }
  if (!formAberto) desenharTurno();
  return undefined;
}

function telaTurno() {
  trocar(raiz, h('div', { class: 'conteudo' }, h('p', { class: 'nota' }, 'Carregando…')));
  iniciarRastreioWeb();
  clearInterval(ciclo);
  ciclo = setInterval(buscarEstado, 8000);
  buscarEstado();
}

function faixaSinal() {
  if (estado.semConexao) return h('div', { class: 'faixa ruim' }, 'Sem internet. Tentando reconectar…');
  if (nativo) {
    const i = infoNativo();
    if (!i.permLocal) return h('div', { class: 'faixa ruim', onclick: () => nativo.pedirPermissoes() }, 'Permissão de localização removida! Toque aqui para liberar. A Speed já foi avisada.');
    if (!i.gpsLigado) return h('div', { class: 'faixa ruim', onclick: () => nativo.abrirAjustesLocal() }, 'GPS desligado! Toque aqui para ligar. A Speed já foi avisada.');
    if (!i.servicoAtivo) { nativo.iniciarTurno(token, estado.turno.fim_previsto); }
  }
  const idade = estado.turno.ult_ts ? estado.agora - estado.turno.ult_ts : null;
  if (idade == null || idade > 90000) return h('div', { class: 'faixa aviso' }, 'Aguardando sinal de localização…');
  return h('div', { class: 'faixa ok' }, 'Localização ativa');
}

function desenharTurno() {
  const { turno, rota, motoboy, ofertas, ganhos } = estado;
  const [atual, ...proximas] = rota;
  const partes = [];

  // Entregas disponíveis: o primeiro motoboy que aceitar leva.
  for (const o of ofertas) {
    const erro = h('div', { class: 'erro', role: 'alert' });
    const responder = async (acao) => {
      try {
        estado = { ...(await api('POST', '/api/motoboy/oferta', { oferta_id: o.id, acao })), semConexao: false };
        desenharTurno();
      } catch (e) {
        if (e.status === 401) return encerrado();
        erro.textContent = e.message;
        setTimeout(buscarEstado, 1500);
      }
      return undefined;
    };
    partes.push(h('div', { class: 'cartao oferta' },
      h('span', { class: 'etiqueta oferta' }, o.urgente ? 'ENTREGA URGENTE DISPONÍVEL' : 'ENTREGA DISPONÍVEL'),
      o.repasse != null && h('div', { class: 'ganho' }, `Você recebe ${reais(o.repasse)}`),
      h('div', { class: 'detalhe' }, `Coleta: ${o.coleta_endereco}${o.dist_km != null ? ` (a ${String(o.dist_km).replace('.', ',')} km de você)` : ''}`),
      h('div', { class: 'detalhe' }, `Entrega: ${o.entrega_endereco}${o.km != null ? ` (${String(o.km).replace('.', ',')} km)` : ''}`),
      (o.servico || o.descricao) && h('div', { class: 'detalhe' }, [o.servico, o.descricao].filter(Boolean).join(' · ')),
      h('div', { class: 'botoes' },
        h('button', { class: 'grande coleta', onclick: () => responder('aceitar') }, 'Aceitar'),
        h('button', { onclick: () => responder('recusar') }, 'Recusar')),
      erro));
  }

  if (turno.almoco_ate) {
    partes.push(h('div', { class: 'cartao livre' },
      h('h2', null, 'Em almoço'), h('p', { class: 'nota' }, `Até ${hora(turno.almoco_ate)}. Bom apetite!`),
      h('div', { class: 'botoes' }, h('button', { class: 'primario', onclick: () => acaoAlmoco('encerrar') }, 'Voltar do almoço agora'))));
  }

  if (atual) {
    partes.push(cartaoParada(atual));
    if (proximas.length) {
      partes.push(h('div', { class: 'titulo-secao' }, `Depois (${proximas.length})`),
        h('div', { class: 'cartao' }, proximas.map((p) => h('div', { class: 'proxima' },
          h('span', { class: `etiqueta ${p.tipo}` }, p.tipo === 'coleta' ? 'COLETA' : 'ENTREGA'),
          h('div', null, h('div', null, p.endereco), h('div', { class: 'detalhe' }, p.cliente))))));
    }
  } else if (!turno.almoco_ate) {
    partes.push(h('div', { class: 'cartao livre' },
      h('h2', null, ofertas.length ? 'Escolha uma entrega acima' : 'Sem demanda no momento'),
      h('p', { class: 'nota' }, 'Fique com o app ligado. Quando entrar demanda perto de você, o celular avisa.')));
  }

  const carregando = rota.some((p) => p.tipo === 'entrega' && !rota.some((c) => c.tipo === 'coleta' && c.demanda_id === p.demanda_id));
  if (!turno.almoco_usado) {
    partes.push(h('div', { class: 'botoes' },
      h('button', { disabled: carregando, onclick: () => acaoAlmoco('iniciar') },
        carregando ? 'Almoço: entregue o que já coletou primeiro' : 'Iniciar almoço')));
  }

  if (ganhos) {
    partes.push(h('div', { class: 'titulo-secao' }, `Ganhos deste turno: ${reais(ganhos.total)}`),
      ganhos.entregas.length
        ? h('div', { class: 'cartao' }, ganhos.entregas.map((g) => h('div', { class: 'proxima' },
          h('span', { class: 'etiqueta entrega' }, reais(g.repasse || 0)),
          h('div', null, h('div', null, `#${g.id} · ${g.entrega_endereco}`), h('div', { class: 'detalhe' }, `${g.servico ? `${g.servico} · ` : ''}entregue ${hora(g.entregue_em)}`)))))
        : h('p', { class: 'nota' }, 'Cada entrega concluída aparece aqui com o seu valor.'));
  }
  if (motoboy.tipo === 'avulso') {
    const erroFim = h('div', { class: 'erro', role: 'alert' });
    partes.push(h('div', { class: 'botoes' },
      h('button', {
        disabled: !estado.pode_encerrar,
        onclick: async () => {
          if (!window.confirm('Encerrar agora e parar de receber entregas?')) return;
          try { await api('POST', '/api/motoboy/encerrar', {}); encerrado(); } catch (e) { erroFim.textContent = e.message; }
        },
      }, estado.pode_encerrar ? 'Encerrar por hoje' : 'Para encerrar, termine as entregas aceitas')), erroFim);
  }

  trocar(raiz, 
    h('div', { class: 'topo' },
      h('div', { class: 'nome' }, motoboy.nome),
      h('div', { class: 'info' }, motoboy.tipo === 'avulso'
        ? `Online · ${rota.length} parada(s)`
        : `Turno até ${hora(turno.fim_previsto)} · ${rota.length} parada(s)`)),
    faixaSinal(),
    h('div', { class: 'conteudo' }, partes));
}

function cartaoParada(p) {
  const coleta = p.tipo === 'coleta';
  const area = h('div', { class: 'botoes' });
  const erro = h('div', { class: 'erro', role: 'alert' });

  const navegar = () => {
    if (nativo) nativo.navegar(p.lat, p.lon);
    else window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`, '_blank', 'noopener');
  };

  function botoesIniciais() {
    formAberto = false;
    trocar(area, 
      h('button', { onclick: navegar }, 'Abrir rota no mapa'),
      h('button', { class: `grande ${p.tipo}`, onclick: () => (coleta ? enviar({}) : pedirRecebedor()) },
        coleta ? 'Coletei' : 'Entreguei'));
  }
  function pedirRecebedor() {
    formAberto = true;
    const nome = h('input', { maxlength: 80, placeholder: 'Nome de quem recebeu' });
    trocar(area, 
      h('label', null, 'Quem recebeu?'), nome,
      h('button', { class: 'grande entrega', onclick: () => enviar({ recebedor: nome.value }) }, 'Confirmar entrega'),
      h('button', { onclick: botoesIniciais }, 'Voltar'));
    nome.focus();
  }
  function pedirMotivo(dados, mensagem) {
    formAberto = true;
    const motivo = h('textarea', { maxlength: 300, rows: 3, placeholder: 'Explique por que está registrando longe do local' });
    trocar(area, 
      h('p', { class: 'erro' }, mensagem),
      h('p', { class: 'nota' }, 'O registro fora do local fica marcado para a Speed conferir.'),
      motivo,
      h('button', { class: `grande ${p.tipo}`, onclick: () => enviar({ ...dados, justificativa: motivo.value }) }, 'Registrar mesmo assim'),
      h('button', { onclick: botoesIniciais }, 'Voltar'));
    motivo.focus();
  }
  async function enviar(dados) {
    erro.textContent = '';
    try {
      estado = { ...(await api('POST', '/api/motoboy/parada', {
        demanda_id: p.demanda_id, tipo: p.tipo, ...dados, lat: ultimaPosicao?.lat, lon: ultimaPosicao?.lon,
      })), semConexao: false };
      formAberto = false;
      desenharTurno();
    } catch (e) {
      if (e.status === 401) return encerrado();
      if (e.codigo === 'fora_do_local') return pedirMotivo(dados, e.message);
      erro.textContent = e.message;
    }
    return undefined;
  }

  botoesIniciais();
  return h('div', { class: `cartao atual ${p.tipo}` },
    h('span', { class: `etiqueta ${p.tipo}` }, coleta ? 'AGORA: COLETA' : 'AGORA: ENTREGA'),
    h('div', { class: 'endereco' }, p.endereco),
    h('div', { class: 'detalhe' }, `Cliente: ${p.cliente}`),
    p.servico && h('div', { class: 'detalhe' }, `Serviço: ${p.servico}`),
    p.repasse != null && h('div', { class: 'detalhe' }, `Você recebe: ${reais(p.repasse)}`),
    p.contato && h('div', { class: 'detalhe' }, `Contato: ${p.contato}`),
    p.descricao && h('div', { class: 'detalhe' }, p.descricao),
    area, erro);
}

async function acaoAlmoco(acao) {
  try {
    estado = { ...(await api('POST', '/api/motoboy/almoco', { acao })), semConexao: false };
    desenharTurno();
  } catch (e) {
    if (e.status === 401) encerrado();
  }
}

if (token) telaTurno(); else telaLogin();
