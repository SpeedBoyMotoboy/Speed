// Tela do motoboy. Roda dentro do app Android (que faz o rastreio em segundo plano)
// ou, para teste, direto no navegador (aí o rastreio só funciona com a tela ligada).
const raiz = document.getElementById('raiz');
const nativo = window.SpeedNativo || null;
// Pelo navegador (sem o app instalado da loja) o Android corta a localização com a tela apagada:
// mantém a tela acesa enquanto a página estiver aberta.
async function manterTelaAcesa() {
  if (nativo || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try { await navigator.wakeLock.request('screen'); } catch { /* aparelho não deixou: segue normal */ }
}
document.addEventListener('visibilitychange', manterTelaAcesa);
manterTelaAcesa();
const CHAVE_TOKEN = 'speed_token';
const CHAVE_ROTA = 'speed_rota_versao';
const CHAVE_PIN = 'speed_pin'; // senha guardada só neste aparelho, para entrar com um toque

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
// App aberto pelo botão "Abrir o app" do navegador: chega com a sessão do login já feito (só dentro do app).
{
  const doLink = /[#&]t=([^&]+)/.exec(location.hash);
  if (nativo && doLink) {
    token = decodeURIComponent(doLink[1]);
    localStorage.setItem(CHAVE_TOKEN, token);
    history.replaceState(null, '', '/app/');
  }
}

// Tema: claro (sol) ou escuro (noite). Sem escolha, segue o celular. A escolha fica guardada no aparelho.
const CHAVE_TEMA = 'speed_tema';
const temaAtual = () => localStorage.getItem(CHAVE_TEMA)
  || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro');
function aplicarTema() {
  const tema = temaAtual();
  document.documentElement.dataset.tema = tema;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tema === 'escuro' ? '#1A1A1A' : '#333F22');
}
function botaoTema(redesenhar) {
  return h('button', {
    class: 'tema', 'aria-label': 'Trocar entre tema claro e escuro',
    onclick: () => { localStorage.setItem(CHAVE_TEMA, temaAtual() === 'escuro' ? 'claro' : 'escuro'); aplicarTema(); redesenhar(); },
  }, temaAtual() === 'escuro' ? 'Tema claro' : 'Tema escuro');
}
aplicarTema();
let estado = null;
let ciclo = null;
let formAberto = false; // não redesenhar enquanto o motoboy digita
let abaParada = 'cliente'; // aba aberta na parada atual (fica entre as atualizações)

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
  // 18/11: toque chamativo — sirene de 2 tons por ~3 s (antes era um bip só) e vibração longa.
  try { navigator.vibrate?.([500, 200, 500, 200, 500, 200, 800]); } catch { /* sem vibração */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ganho = ctx.createGain();
    ganho.gain.value = 0.9;
    ganho.connect(ctx.destination);
    const tons = [880, 1320, 880, 1320, 880, 1320, 880, 1320, 1760, 1760];
    tons.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(ganho);
      osc.start(ctx.currentTime + i * 0.3);
      osc.stop(ctx.currentTime + i * 0.3 + 0.25);
    });
    setTimeout(() => { try { ctx.close(); } catch { /* já fechado */ } }, 4000);
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

  // A senha fica guardada neste aparelho depois do primeiro login: na volta é um toque só.
  const lembrado = { telefone: localStorage.getItem('speed_telefone') || '', pin: localStorage.getItem(CHAVE_PIN) || '' };
  let rapido = Boolean(lembrado.telefone && lembrado.pin);
  const telefone = h('input', { inputmode: 'tel', autocomplete: 'username', placeholder: '(27) 99999-0000', value: lembrado.telefone });
  const pin = h('input', { type: 'password', inputmode: 'numeric', maxlength: 6, autocomplete: 'current-password', placeholder: '6 números', value: lembrado.pin });
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
    entrar.disabled = !(i.permLocal && i.gpsLigado && i.bateriaLivre);
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
        localStorage.setItem(CHAVE_PIN, pin.value);
        localStorage.removeItem(CHAVE_ROTA);
        clearInterval(conferencia);
        if (nativo) nativo.iniciarTurno(token, r.fim_previsto);
        telaTurno();
      } catch (e) {
        erro.textContent = e.message;
        entrar.disabled = false;
        // Senha guardada não vale mais (trocaram no painel): mostra os campos para digitar a nova.
        if (rapido && e.status === 401) {
          localStorage.removeItem(CHAVE_PIN);
          rapido = false;
          pin.value = '';
          campos.hidden = false;
          conta.hidden = true;
        }
      }
    },
  });
  const campos = h('div', { hidden: rapido },
    h('label', null, 'Telefone com DDD'), telefone,
    h('label', null, 'Senha'), pin);
  const conta = h('div', { class: 'conta-lembrada', hidden: !rapido },
    h('div', null, 'Entrar como ', h('b', null, lembrado.telefone)),
    h('button', {
      type: 'button', class: 'leve',
      onclick: () => { localStorage.removeItem(CHAVE_PIN); rapido = false; pin.value = ''; campos.hidden = false; conta.hidden = true; telefone.focus(); },
    }, 'Usar outra conta'));
  form.append(conta, campos,
    h('label', { class: 'marcar' }, aceito, 'Aceito os termos'),
    h('details', { class: 'ver-termo' }, h('summary', null, 'Ver termos'), h('div', { class: 'termo', tabindex: 0 }, termo.texto)),
    erro, h('div', { class: 'botoes' }, entrar));

  trocar(raiz,
    h('div', { class: 'topo' }, h('div', { class: 'nome' }, 'Speed ', h('span', null, 'Motoboy')),
      h('div', { class: 'info' }, 'Toque em Iniciar turno para começar.')),
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

// ── Foto da entrega: reduz no aparelho, guarda na fila e envia; sem internet, tenta de novo a cada atualização ──
const CHAVE_FOTOS = 'speed_fotos';
async function reduzirFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const escala = Math.min(1, 1280 / Math.max(img.width, img.height));
  const tela = document.createElement('canvas');
  tela.width = Math.round(img.width * escala);
  tela.height = Math.round(img.height * escala);
  tela.getContext('2d').drawImage(img, 0, 0, tela.width, tela.height);
  return tela.toDataURL('image/jpeg', 0.7);
}
function filaFotos() { try { return JSON.parse(localStorage.getItem(CHAVE_FOTOS) || '[]'); } catch { return []; } }
function guardarFoto(demandaId, foto) {
  try { localStorage.setItem(CHAVE_FOTOS, JSON.stringify([...filaFotos().filter((f) => f.id !== demandaId), { id: demandaId, foto }])); } catch { /* sem espaço: segue sem foto */ }
}
let enviandoFotos = false;
async function enviarFotos() {
  if (enviandoFotos || !token) return;
  enviandoFotos = true;
  try {
    for (const f of filaFotos()) {
      try {
        await api('POST', '/api/motoboy/foto', { demanda_id: f.id, foto: f.foto });
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 401) break; // sem internet ou sessão: tenta depois
      }
      try { localStorage.setItem(CHAVE_FOTOS, JSON.stringify(filaFotos().filter((x) => x.id !== f.id))); } catch { /* segue */ }
    }
  } finally { enviandoFotos = false; }
}

async function buscarEstado() {
  enviarFotos();
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

// App instalável pelo Chrome (o próprio Chrome cria e assina o app: sem aviso do Play Protect).
// O cartão aparece no navegador do Android, depois do login. "Agora não" esconde por 7 dias.
const CHAVE_APP_DEPOIS = 'speed_app_depois';
let pedidoInstalar = null;
const instalado = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); pedidoInstalar = ev; if (estado && !formAberto) desenharTurno(); });
window.addEventListener('appinstalled', () => { pedidoInstalar = null; if (estado && !formAberto) desenharTurno(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
function cartaoBaixarApp() {
  if (nativo || instalado() || !/android/i.test(navigator.userAgent)) return null;
  let depois = 0;
  try { depois = Number(localStorage.getItem(CHAVE_APP_DEPOIS)) || 0; } catch { /* sem armazenamento */ }
  if (Date.now() < depois) return null;
  const cartao = h('div', { class: 'cartao baixar-app' },
    h('b', null, 'Instale o app Speedy Motoboy'),
    h('div', { class: 'nota' }, 'Um toque e o ícone vai para a tela inicial. Abre em tela cheia, sem baixar arquivo.'),
    h('div', { class: 'botoes' },
      pedidoInstalar
        ? h('button', {
          type: 'button', class: 'primario grande',
          onclick: async () => { const p = pedidoInstalar; pedidoInstalar = null; try { await p.prompt(); } catch { /* cancelou */ } desenharTurno(); },
        }, 'Instalar app')
        : h('div', { class: 'nota' }, 'No Chrome, toque nos 3 pontinhos (⋮) lá em cima e escolha "Instalar app" ou "Adicionar à tela inicial".'),
      h('button', {
        type: 'button',
        onclick: () => {
          try { localStorage.setItem(CHAVE_APP_DEPOIS, String(Date.now() + 7 * 24 * 3600 * 1000)); } catch { /* sem armazenamento */ }
          cartao.remove();
        },
      }, 'Agora não')),
    h('div', { class: 'nota' }, 'Deixe o app aberto na tela enquanto trabalha: é assim que a central vê onde você está.'));
  return cartao;
}

// ── Como receber: chave Pix + ciente do pagamento às quartas. Obrigatório antes de usar o app. ──
function avisoQuarta(ciente) {
  return h('div', { class: 'aviso-quarta' },
    h('div', null, '💰 ', h('b', null, 'O pagamento é feito toda QUARTA-FEIRA'), ', por Pix, em horário comercial.'),
    h('div', null, 'É automático: não precisa cobrar. Entra só a entrega registrada e concluída no app.'),
    h('label', { class: 'marcar' }, ciente, ' Estou ciente de que o pagamento é feito toda quarta-feira, em horário comercial.'));
}
function telaRecebimento(podeVoltar = false) {
  formAberto = true;
  const r = estado?.motoboy?.recebimento || {};
  const chave = h('input', { maxlength: 100, autocomplete: 'off', placeholder: 'CPF, telefone, e-mail ou chave aleatória', value: r.pix_chave || '' });
  const titular = h('input', { maxlength: 80, autocomplete: 'name', placeholder: 'Nome completo do dono da conta', value: r.pix_titular || '' });
  const banco = h('input', { maxlength: 40, placeholder: 'Ex.: Nubank, Caixa, Inter', value: r.pix_banco || '' });
  const ciente = h('input', { type: 'checkbox' });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const salvar = h('button', { class: 'primario grande', type: 'submit' }, 'Salvar e continuar');
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      if (!ciente.checked) { erro.textContent = 'Marque que está ciente do pagamento às quartas-feiras.'; return; }
      salvar.disabled = true;
      try {
        await api('POST', '/api/motoboy/recebimento', { pix_chave: chave.value, pix_titular: titular.value, pix_banco: banco.value, ciente: true });
        formAberto = false;
        buscarEstado();
      } catch (e) { erro.textContent = e.message; salvar.disabled = false; }
    },
  },
  h('label', null, 'Chave Pix'), chave,
  h('label', null, 'Nome de quem é a conta'), titular,
  h('label', null, 'Banco'), banco,
  avisoQuarta(ciente),
  erro,
  h('div', { class: 'botoes' }, salvar,
    podeVoltar && h('button', { type: 'button', onclick: () => { formAberto = false; desenharTurno(); } }, 'Voltar')));
  trocar(raiz,
    h('div', { class: 'topo' }, h('div', { class: 'nome' }, estado?.motoboy?.nome || 'Speed Motoboy'), h('div', { class: 'info' }, 'Como receber seu pagamento')),
    h('div', { class: 'conteudo' }, h('div', { class: 'cartao' },
      h('b', null, 'Onde você quer receber?'),
      h('p', { class: 'nota' }, 'Preencha uma vez. Dá para mudar depois no botão Recebimento.'),
      form)));
}

function desenharTurno() {
  const { turno, rota, motoboy, ofertas } = estado;
  document.body.classList.remove('tem-barra');
  const [atual, ...proximas] = rota;
  const partes = [];
  // Sem chave Pix ou sem o "estou ciente" do pagamento às quartas: nada mais abre antes disso.
  if (!motoboy.mensal && !motoboy.recebimento?.ciente_em) { telaRecebimento(false); return; }
  // No app: sem tirar a economia de bateria o Android mata o rastreio. Só libera a tela depois de liberar.
  if (nativo && infoNativo().bateriaLivre === false) {
    trocar(raiz,
      h('div', { class: 'topo' }, h('div', { class: 'nome' }, motoboy.nome), h('div', { class: 'info' }, 'Falta liberar a bateria')),
      h('div', { class: 'conteudo' }, h('div', { class: 'cartao baixar-app' },
        h('b', null, 'Tire a economia de bateria do app'),
        h('div', { class: 'nota' }, 'Com a economia ligada, o celular desliga a localização e você aparece sem sinal. Toque no botão e escolha Permitir ou Sem restrições.'),
        h('div', { class: 'botoes' }, h('button', { class: 'primario grande', onclick: () => nativo.pedirPermissoes() }, 'Liberar agora')))));
    return;
  }
  // No Android o app é obrigatório: no navegador, depois do login, só aparece a tela de instalar.
  // Desligado em 19/11: o Google Play Protect bloqueia o APK fora da loja. Volta quando o app estiver na Play Store.
  const APP_OBRIGATORIO = false;
  if (APP_OBRIGATORIO && !nativo && /android/i.test(navigator.userAgent)) {
    const abrir = `intent://entrar?t=${encodeURIComponent(token)}#Intent;scheme=speedy;package=br.com.speedboy.motoboy;end`;
    trocar(raiz,
      h('div', { class: 'topo' }, h('div', { class: 'nome' }, motoboy.nome), h('div', { class: 'info' }, 'Falta instalar o app')),
      h('div', { class: 'conteudo' }, h('div', { class: 'cartao baixar-app' },
        h('b', null, 'Para trabalhar, instale o app Speedy Motoboy'),
        h('div', { class: 'nota' }, 'Com o app, a localização segue com a tela apagada, o aviso de entrega chega na hora e a câmera abre para a foto da entrega.'),
        h('div', { class: 'botoes' },
          h('a', { class: 'botao-link', href: '/app/speed-motoboy.apk', download: 'speedy-motoboy.apk' }, '1. Baixar app (Android)'),
          h('a', { class: 'botao-link claro', href: abrir }, '2. Já instalei: abrir o app')),
        h('div', { class: 'nota' }, 'Ao abrir o arquivo baixado, o Android pede para permitir instalar desta fonte: toque em Configurações e ative. Depois volte aqui e toque no botão 2: o app abre já com o seu login.'),
        h('div', { class: 'nota' }, 'Não conseguiu instalar? Chame a central da SpeedBoy no WhatsApp.'))));
    return;
  }

  if (turno.almoco_ate) {
    partes.push(h('div', { class: 'cartao livre' },
      h('h2', null, 'Em almoço'), h('p', { class: 'nota' }, `Até ${hora(turno.almoco_ate)}. Bom apetite!`),
      h('div', { class: 'botoes' }, h('button', { class: 'primario', onclick: () => acaoAlmoco('encerrar') }, 'Voltar do almoço agora'))));
  }

  if (atual) {
    partes.push(cartaoParada(atual));
    if (estado.previsao_fim) partes.push(h('p', { class: 'previsao' }, `Previsão de terminar a rota: ${hora(estado.previsao_fim)} (5 min por parada)`));
    if (proximas.length) {
      partes.push(h('div', { class: 'titulo-secao' }, `Depois (${proximas.length})`),
        h('div', { class: 'cartao' }, proximas.map((p) => h('div', { class: 'proxima' },
          h('span', { class: `etiqueta ${p.tipo}` }, p.tipo === 'coleta' ? 'COLETA' : 'ENTREGA'),
          h('div', null, h('div', null, p.endereco), h('div', { class: 'detalhe' }, p.cliente))))));
    }
  } else if (!turno.almoco_ate && !ofertas.length) {
    partes.push(h('div', { class: 'cartao livre' },
      h('h2', null, 'Sem demanda no momento'),
      h('p', { class: 'nota' }, 'Fique com o app ligado. Quando entrar demanda perto de você, o celular avisa.')));
  }

  partes.push(...quadro());

  // Almoço (só fixo): fora da tela de entrega ativa. Também fica no perfil.
  if (!atual && !turno.almoco_ate && !turno.almoco_usado && motoboy.tipo !== 'avulso') {
    partes.push(h('div', { class: 'botoes' }, h('button', { onclick: () => acaoAlmoco('iniciar') }, 'Iniciar almoço')));
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
      botaoTema(desenharTurno),
      h('button', { type: 'button', class: 'perfil-topo', 'aria-label': 'Abrir meu perfil', onclick: () => telaPerfil() },
        avatar(motoboy),
        h('div', null,
          h('div', { class: 'nome' }, motoboy.nome),
          h('div', { class: 'info' }, motoboy.tipo === 'avulso'
            ? `Online · ${rota.length} parada(s)`
            : `Turno até ${hora(turno.fim_previsto)} · ${rota.length} parada(s)`)))),
    faixaSinal(),
    h('div', { class: 'conteudo' }, partes));
}

// ── Perfil do motoboy: foto, dados, corridas, Pix (avulso/diária) e almoço (fixo) ──
let fotoCache = { em: null, url: null };
const iniciais = (nome) => String(nome || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
function avatar(m, grande = false) {
  const el = h('span', { class: `avatar${grande ? ' grande' : ''}` }, iniciais(m.nome));
  if (m.foto_em) {
    const pinta = (url) => { el.textContent = ''; el.append(h('img', { src: url, alt: '' })); };
    if (fotoCache.em === m.foto_em && fotoCache.url) pinta(fotoCache.url);
    else api('GET', '/api/motoboy/foto').then((r) => { fotoCache = { em: m.foto_em, url: r.foto }; pinta(r.foto); }).catch(() => {});
  }
  return el;
}
async function telaPerfil() {
  formAberto = true;
  const voltar = () => { formAberto = false; desenharTurno(); };
  const topo = h('div', { class: 'topo' }, h('div', { class: 'nome' }, 'Meu perfil'), h('div', { class: 'info' }, estado?.motoboy?.nome || ''));
  const corpo = h('div', { class: 'conteudo' }, h('p', { class: 'nota' }, 'Carregando…'));
  trocar(raiz, topo, corpo);
  let p;
  try { p = await api('GET', '/api/motoboy/perfil'); } catch (e) {
    if (e.status === 401) { encerrado(); return; }
    trocar(corpo, h('div', { class: 'erro' }, e.message), h('div', { class: 'botoes' }, h('button', { onclick: voltar }, 'Voltar')));
    return;
  }
  const m = { ...p.motoboy, mensal: estado?.motoboy?.mensal };
  const avulso = m.tipo === 'avulso';
  const erro = h('div', { class: 'erro', role: 'alert' });
  const arquivo = h('input', { type: 'file', accept: 'image/*', class: 'oculto',
    onchange: async () => {
      const f = arquivo.files?.[0];
      if (!f) return;
      erro.textContent = '';
      try {
        const foto = await reduzirFoto(f);
        await api('POST', '/api/motoboy/foto', { foto });
        fotoCache = { em: null, url: null };
        if (estado?.motoboy) estado.motoboy.foto_em = Date.now();
        await buscarEstado();
        telaPerfil();
      } catch (e) { erro.textContent = e.message; }
    } });
  const linha = (rot, val) => h('div', { class: 'info-linha' }, h('span', { class: 'info-rot' }, rot), h('span', { class: 'info-val' }, val));
  const turno = estado?.turno || {};
  const r = p.recebimento;
  trocar(corpo,
    h('div', { class: 'cartao perfil' },
      h('div', { class: 'perfil-cabeca' },
        avatar({ ...m, foto_em: m.foto_em }, true),
        h('div', null, h('div', { class: 'perfil-nome' }, m.nome),
          h('button', { type: 'button', class: 'leve trocar-foto', onclick: () => arquivo.click() }, m.foto_em ? 'Trocar foto' : 'Colocar foto'))),
      arquivo, erro,
      h('div', { class: 'info' },
        linha('Telefone', m.telefone),
        linha('Veículo', m.veiculo || '-'),
        linha('Tipo', m.mensal ? 'Mensal' : avulso ? 'Avulso' : 'Diária'))),
    h('div', { class: 'cartao' },
      h('div', { class: 'titulo-secao' }, 'Suas corridas'),
      h('div', { class: 'resumo-perfil' },
        h('div', null, h('b', null, String(p.resumo.hoje)), h('span', null, 'hoje')),
        h('div', null, h('b', null, String(p.resumo.dias30)), h('span', null, 'em 30 dias')),
        avulso && h('div', { class: 'a-receber' }, h('b', null, reais(p.resumo.a_receber)), h('span', null, 'a receber na quarta')),
        avulso && h('div', null, h('b', null, reais(p.resumo.valor_hoje)), h('span', null, 'hoje')),
        avulso && h('div', null, h('b', null, reais(p.resumo.valor_30)), h('span', null, 'em 30 dias'))),
      p.corridas.length
        ? p.corridas.map((c) => h('div', { class: 'proxima' },
          h('span', { class: 'etiqueta entrega' }, avulso ? reais(c.repasse || 0) : `#${c.id}`),
          h('div', null, h('div', null, c.endereco), h('div', { class: 'detalhe' }, `${c.cliente}${c.servico ? ` · ${c.servico}` : ''} · ${diaHora(c.entregue_em)}`))))
        : h('p', { class: 'nota' }, 'Suas entregas concluídas aparecem aqui.')),
    m.mensal
      ? h('div', { class: 'cartao' }, h('div', { class: 'titulo-secao' }, 'Pagamento'), h('p', { class: 'nota' }, 'Pagamento mensal, todo dia 10.'))
      : h('div', { class: 'cartao' },
        h('div', { class: 'titulo-secao' }, 'Recebimento (Pix)'),
        h('div', { class: 'info' },
          linha('Chave Pix', r.pix_chave || 'Não informada'),
          linha('Titular', r.pix_titular || '-'),
          linha('Banco', r.pix_banco || '-')),
        h('p', { class: 'nota' }, 'Pagamento toda quarta-feira, em horário comercial.'),
        h('div', { class: 'botoes' }, h('button', { class: 'leve', onclick: () => telaRecebimento(true) }, 'Alterar Pix'))),
    !avulso && !turno.almoco_usado && !turno.almoco_ate && h('div', { class: 'botoes' },
      h('button', { onclick: () => { formAberto = false; acaoAlmoco('iniciar'); } }, 'Iniciar almoço')),
    h('div', { class: 'botoes' }, h('button', { class: 'primario grande', onclick: voltar }, 'Voltar para a rota')));
}

// ── Quadro de entregas: ofertas agrupadas por loja/coleta e entregas agendadas ──
const minutos = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${doisDig(m % 60)}` : `${m} min`);
const kmTxt = (v) => `${String(v).replace('.', ',')} km`;
const diaHora = (ts) => {
  const d = new Date(ts);
  const hoje = new Date();
  return d.toDateString() === hoje.toDateString() ? `HOJE ${hora(ts)}` : `${doisDig(d.getDate())}/${doisDig(d.getMonth() + 1)} ${hora(ts)}`;
};
let grupoAberto = null;
function quadro() {
  const { ofertas, agendadas = [] } = estado;
  if (!ofertas.length && !agendadas.length) return [];
  const grupos = new Map();
  for (const o of ofertas) {
    const k = `${o.cliente || ''}|${o.coleta_endereco}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(o);
  }
  return [h('div', { class: 'titulo-secao' }, 'Quadro de entregas'),
    ...[...grupos].map(([k, lista]) => cartaoGrupo(k, lista)),
    ...agendadas.map(cartaoAgendada)];
}
function desenharMapa(el, coleta, entregas) {
  const L = window.L;
  if (!L) { el.remove(); return; }
  const mapa = L.map(el, { zoomControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
  const pino = (classe, texto) => L.divIcon({ className: '', html: `<div class="pino ${classe}">${texto}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  const pontos = [];
  if (coleta.lat != null) { L.marker([coleta.lat, coleta.lon], { icon: pino('coleta', 'C') }).addTo(mapa); pontos.push([coleta.lat, coleta.lon]); }
  entregas.forEach((e, i) => {
    if (e.lat == null) return;
    L.marker([e.lat, e.lon], { icon: pino('entrega', `E${i + 1}`) }).addTo(mapa);
    pontos.push([e.lat, e.lon]);
  });
  if (pontos.length) mapa.fitBounds(pontos, { padding: [30, 30], maxZoom: 15 });
}
function cartaoGrupo(chave, lista) {
  const erro = h('div', { class: 'erro', role: 'alert' });
  const o0 = lista[0];
  const naRota = lista.every((o) => o.na_rota);
  const temValor = lista.some((o) => o.repasse != null);
  const total = lista.reduce((s, o) => s + (o.repasse || 0), 0);
  const tempo = lista.reduce((s, o) => s + (o.tempo_min || 0), 0);
  const responder = async (acao) => {
    try {
      for (const o of lista) estado = { ...(await api('POST', '/api/motoboy/oferta', { oferta_id: o.id, acao })), semConexao: false };
      grupoAberto = null;
      desenharTurno();
    } catch (e) {
      if (e.status === 401) return encerrado();
      erro.textContent = e.message;
      setTimeout(buscarEstado, 1500);
    }
    return undefined;
  };
  const aberto = grupoAberto === chave;
  const mapaEl = aberto ? h('div', { class: 'mapa-quadro' }) : null;
  const rotulo = naRota ? 'NA SUA ROTA' : o0.urgente ? 'URGENTE' : o0.dist_km != null ? `A ${kmTxt(o0.dist_km).toUpperCase()} DE VOCÊ` : 'DISPONÍVEL';
  const no = h('div', { class: `cartao oferta${naRota ? ' na-rota' : ''}` },
    h('div', { class: 'linha-topo' },
      h('span', { class: `etiqueta ${naRota ? 'rota' : 'oferta'}` }, rotulo),
      temValor && h('span', { class: 'ganho' }, `${naRota ? '+ ' : ''}${reais(total)}`)),
    h('div', { class: 'endereco pequeno' }, `${o0.cliente || 'Cliente'} · ${lista.length} entrega${lista.length > 1 ? 's' : ''}`),
    h('div', { class: 'detalhe' }, `Coleta: ${o0.coleta_endereco}`),
    !aberto && lista.length === 1 && h('div', { class: 'detalhe' }, `Entrega: ${o0.entrega_endereco}${o0.km != null ? ` (${kmTxt(o0.km)})` : ''}`),
    tempo > 0 && h('div', { class: 'tempo' }, `${naRota ? '+ ' : ''}${minutos(tempo)}`),
    aberto && lista.map((o, i) => h('div', { class: 'proxima' },
      h('span', { class: 'etiqueta entrega' }, `E${i + 1}`),
      h('div', null, h('div', null, o.entrega_endereco),
        h('div', { class: 'detalhe' }, [o.km != null && kmTxt(o.km), o.valor_cliente != null && `cliente ${reais(o.valor_cliente)}`, o.repasse != null && (o.valor_cliente !== undefined ? `motoboy ${reais(o.repasse)}` : reais(o.repasse)), o.descricao].filter(Boolean).join(' · '))))),
    mapaEl,
    h('div', { class: 'botoes' },
      h('button', { class: 'grande coleta', onclick: () => responder('aceitar') }, lista.length > 1 ? `Pegar as ${lista.length}` : 'Pegar'),
      h('button', { onclick: () => { grupoAberto = aberto ? null : chave; desenharTurno(); } }, aberto ? 'Fechar' : 'Ver entregas')),
    h('button', { class: 'leve', onclick: () => responder('recusar') }, 'Não quero'),
    erro);
  if (mapaEl) {
    setTimeout(() => desenharMapa(mapaEl, { lat: o0.coleta_lat, lon: o0.coleta_lon },
      lista.map((o) => ({ lat: o.entrega_lat, lon: o.entrega_lon }))), 60);
  }
  return no;
}
function cartaoAgendada(a) {
  const erro = h('div', { class: 'erro', role: 'alert' });
  const agir = async (acao) => {
    try {
      estado = { ...(await api('POST', '/api/motoboy/agendada', { demanda_id: a.demanda_id, acao })), semConexao: false };
      desenharTurno();
    } catch (e) {
      if (e.status === 401) return encerrado();
      erro.textContent = e.message;
      setTimeout(buscarEstado, 1500);
    }
    return undefined;
  };
  return h('div', { class: 'cartao agendada' },
    h('div', { class: 'linha-topo' },
      h('span', { class: 'etiqueta agendada' }, `AGENDADA · ${diaHora(a.agendada_para)}`),
      a.repasse != null && h('span', { class: 'ganho' }, reais(a.repasse))),
    h('div', { class: 'endereco pequeno' }, a.cliente),
    h('div', { class: 'detalhe' }, `Coleta: ${a.coleta_endereco}`),
    h('div', { class: 'detalhe' }, `Entrega: ${a.entrega_endereco}${a.km != null ? ` (${kmTxt(a.km)})` : ''}`),
    estado.previsao_fim && h('div', { class: 'tempo' }, `Sua rota atual termina por volta de ${hora(estado.previsao_fim)}`),
    a.minha
      ? h('p', { class: 'nota' }, a.pode_confirmar
        ? `Reservada para você. Confirme até ${hora(a.confirmar_ate)}. Sem confirmar, ela volta para o quadro.`
        : `Reservada para você. A confirmação abre às ${hora(a.confirmar_ate - 3600000)} e vai até ${hora(a.confirmar_ate)}.`)
      : h('p', { class: 'nota' }, `Reservou? Confirme até ${hora(a.confirmar_ate)}. Sem confirmar, ela volta para o quadro.`),
    h('div', { class: 'botoes' },
      a.minha && a.pode_confirmar && h('button', { class: 'grande coleta', onclick: () => agir('confirmar') }, 'Confirmar que vou fazer'),
      a.minha && h('button', { onclick: () => agir('soltar') }, 'Não vou conseguir'),
      !a.minha && h('button', { class: 'primario', onclick: () => agir('reservar') }, `Reservar para ${hora(a.agendada_para)}`)),
    erro);
}

// Informações da parada em linhas separadas: prazo em destaque, contato com botões, observações em lista.
// Parada atual dividida em duas abas: o que o motoboy precisa para achar a pessoa (endereço, recado, contato)
// e o resto (loja, valores, observações).
function lerParada(p) {
  const partes = String(p.descricao || '').split(/\s+·\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const prazo = partes.filter((s) => /^(⏰|prazo\b)/i.test(s));
  const recado = partes.filter((s) => /^📍/.test(s)).map((s) => s.replace(/^📍\s*(na entrega:|na coleta:)?\s*/i, ''));
  const obs = partes.filter((s) => !prazo.includes(s) && !/^📍/.test(s));
  const achou = String(p.contato || '').match(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/);
  const fone = achou ? achou[0].replace(/\D/g, '') : '';
  const nome = String(p.contato || '').replace(achou ? achou[0] : '', '').replace(/[·\s-]+$/, '').replace(/^[·\s-]+/, '').trim();
  return { prazo, recado, obs, nome, f55: fone && (fone.length > 11 ? fone : `55${fone}`) };
}
function abaCliente(p, d) {
  const coleta = p.tipo === 'coleta';
  return h('div', { class: 'aba-cliente' },
    p.agendada_para && h('div', { class: 'prazo' }, `Agendada: ${diaHora(p.agendada_para)}`),
    ...d.prazo.map((s) => h('div', { class: 'prazo' }, s)),
    h('div', { class: 'end-grande' }, p.endereco),
    d.recado.map((s) => h('div', { class: 'na-entrega' }, h('b', null, coleta ? 'Na coleta: ' : 'Na entrega: '), s)),
    (d.nome || d.f55) && h('div', { class: 'quem' },
      h('div', { class: 'info-rot' }, coleta ? 'Falar com' : 'Quem recebe'),
      d.nome && h('div', { class: 'nome' }, d.nome),
      d.f55 && h('div', { class: 'acoes-2' },
        h('a', { class: 'info-botao', href: `tel:+${d.f55}` }, 'Ligar'),
        h('a', { class: 'info-botao whats', href: `https://wa.me/${d.f55}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'))),
    p.fachada && botaoFachada(p.demanda_id));
}
function abaDetalhes(p, d) {
  const linha = (rot, val) => h('div', { class: 'info-linha' }, h('span', { class: 'info-rot' }, rot), h('span', { class: 'info-val' }, val));
  return h('div', { class: 'info' },
    linha('Pedido', `#${p.demanda_id}`),
    linha('Cliente', p.cliente),
    p.servico && linha('Serviço', p.servico),
    p.valor_cliente != null && linha('Cliente paga', reais(p.valor_cliente)),
    p.repasse != null && linha(p.valor_cliente !== undefined ? 'Motoboy recebe' : 'Você recebe', reais(p.repasse)),
    d.obs.length > 0 && h('div', { class: 'info-obs' },
      h('div', { class: 'info-rot' }, 'Observações'),
      ...d.obs.map((s) => h('div', { class: 'info-item' }, `• ${s}`))));
}
function blocoInfo(p) {
  const partes = String(p.descricao || '').split(/\s+·\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const prazo = partes.filter((s) => /^(⏰|prazo\b)/i.test(s));
  const obs = partes.filter((s) => !prazo.includes(s));
  const achou = String(p.contato || '').match(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/);
  const fone = achou ? achou[0].replace(/\D/g, '') : '';
  const f55 = fone && (fone.length > 11 ? fone : `55${fone}`);
  const linha = (rot, val) => h('div', { class: 'info-linha' },
    h('span', { class: 'info-rot' }, rot), h('span', { class: 'info-val' }, val));
  return h('div', { class: 'info' },
    p.agendada_para && h('div', { class: 'prazo' }, `Agendada: ${diaHora(p.agendada_para)}`),
    ...prazo.map((s) => h('div', { class: 'prazo' }, s)),
    linha('Cliente', p.cliente),
    p.servico && linha('Serviço', p.servico),
    p.valor_cliente != null && linha('Cliente paga', reais(p.valor_cliente)),
    p.repasse != null && linha(p.valor_cliente !== undefined ? 'Motoboy recebe' : 'Você recebe', reais(p.repasse)),
    p.contato && linha(p.tipo === 'coleta' ? 'Falar com' : 'Entregar a', p.contato),
    f55 && h('div', { class: 'info-acoes' },
      h('a', { class: 'info-botao', href: `tel:+${f55}` }, '📞 Ligar'),
      h('a', { class: 'info-botao', href: `https://wa.me/${f55}`, target: '_blank', rel: 'noopener' }, '💬 WhatsApp')),
    obs.length > 0 && h('div', { class: 'info-obs' },
      h('div', { class: 'info-rot' }, 'Observações'),
      ...obs.map((s) => h('div', { class: 'info-item' }, `• ${s}`))),
    p.fachada && botaoFachada(p.demanda_id));
}
// Foto da fachada que o cliente mandou: abre na hora, dentro do cartão.
function botaoFachada(demandaId) {
  const lugar = h('div', { class: 'fachada' });
  const botao = h('button', {
    type: 'button', class: 'leve',
    onclick: async () => {
      botao.disabled = true;
      botao.textContent = 'Carregando a foto…';
      try {
        const r = await api('GET', `/api/motoboy/fachada/${demandaId}`);
        trocar(lugar, h('img', { src: r.foto, alt: 'Fachada do local de entrega', class: 'foto-fachada' }));
      } catch { botao.disabled = false; botao.textContent = '🏠 Ver foto da fachada (tente de novo)'; }
    },
  }, '🏠 Ver foto da fachada');
  trocar(lugar, botao);
  return lugar;
}

function cartaoParada(p) {
  const coleta = p.tipo === 'coleta';
  const area = h('div', { class: 'botoes' });
  const erro = h('div', { class: 'erro', role: 'alert' });

  const navegar = () => {
    if (nativo) nativo.navegar(p.lat, p.lon);
    else window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`, '_blank', 'noopener');
  };

  const ALERTA = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
  // Fora dos botões iniciais (formulários abertos) a área volta para dentro do cartão.
  const soltarBarra = () => { area.classList.remove('barra-fixa'); document.body.classList.remove('tem-barra'); };
  // "Deu problema" pequeno no topo do cartão, longe do Entreguei.
  const prob = h('button', { type: 'button', class: 'problema', onclick: () => { prob.hidden = true; soltarBarra(); problema(1); } });
  prob.innerHTML = ALERTA;
  prob.append(' Deu problema');
  function botoesIniciais() {
    formAberto = false;
    prob.hidden = false;
    area.classList.add('barra-fixa');
    document.body.classList.add('tem-barra');
    trocar(area, ...[
      !coleta && p.aguarda_pix && h('div', { class: 'faixa aviso' }, '💰 Cliente ainda não pagou o Pix. Só finalize depois que a central confirmar.'),
      h('button', { class: `grande ${p.tipo}`, onclick: () => { soltarBarra(); return coleta ? enviar({}) : pedirRecebedor(); } },
        coleta ? 'Coletei' : 'Entreguei')].filter(Boolean));
  }
  // "Deu problema": a Speedy guia o motoboy — quem recebe, depois a loja, por fim a central.
  function problema(passo) {
    formAberto = true;
    const fone = (s) => {
      const m = String(s || '').match(/(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}/);
      if (!m) return '';
      const d = m[0].replace(/\D/g, '');
      return d.length > 11 ? d : `55${d}`;
    };
    const contatos = (rot, f, msg) => (f
      ? h('div', { class: 'info-acoes' },
        h('a', { class: 'info-botao', href: `tel:+${f}` }, `Ligar: ${rot}`),
        h('a', { class: 'info-botao', href: `https://wa.me/${f}?text=${encodeURIComponent(msg)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp pronto'))
      : h('p', { class: 'nota' }, `Sem telefone de ${rot} neste pedido.`));
    const onde = coleta ? 'no local da coleta' : 'no local da entrega';
    const fLoja = coleta ? '' : fone(p.coleta_contato);
    if (passo === 1) {
      trocar(area,
        h('p', { class: 'speedy' }, `Speedy: você já ligou para ${coleta ? 'o contato da coleta' : 'quem recebe'}?`),
        contatos(coleta ? 'coleta' : 'quem recebe', fone(p.contato),
          `Olá! Sou o motoboy da SpeedBoy e estou ${onde} (${p.endereco}). Pode me atender?`),
        h('button', { onclick: () => problema(fLoja ? 2 : 3) }, 'Já tentei, ninguém atende'),
        h('button', { onclick: botoesIniciais }, 'Resolvido, voltar'));
    } else if (passo === 2) {
      trocar(area,
        h('p', { class: 'speedy' }, 'Speedy: agora tente a loja que enviou.'),
        contatos('loja', fLoja, `Olá! Sou o motoboy da SpeedBoy. Estou na entrega em ${p.endereco} e ninguém atende. Consegue falar com o cliente?`),
        h('button', { onclick: () => problema(3) }, 'Também não resolveu'),
        h('button', { onclick: botoesIniciais }, 'Resolvido, voltar'));
    } else {
      const texto = h('textarea', { maxlength: 300, rows: 3, placeholder: 'Conte em uma frase o que aconteceu' });
      const chamar = h('button', {
        class: 'primario',
        onclick: async () => {
          erro.textContent = '';
          chamar.disabled = true;
          try {
            await api('POST', '/api/motoboy/problema', { demanda_id: p.demanda_id, tipo: p.tipo, texto: texto.value });
            trocar(area,
              h('p', { class: 'speedy' }, 'Speedy: avisei a central. Aguarde no local: vão te dizer se volta com a entrega ou se deixa em outro lugar.'),
              h('button', { onclick: botoesIniciais }, 'Voltar'));
          } catch (e) {
            if (e.status === 401) { encerrado(); return; }
            erro.textContent = e.message;
            chamar.disabled = false;
          }
        },
      }, 'Chamar a central');
      trocar(area,
        h('p', { class: 'speedy' }, 'Speedy: vou chamar a central da SpeedBoy.'),
        texto, chamar, h('button', { onclick: botoesIniciais }, 'Voltar'));
    }
  }
  function pedirRecebedor() {
    formAberto = true;
    const nome = h('input', { maxlength: 80, placeholder: 'Nome de quem recebeu' });
    // Foto da entrega: obrigatória onde a câmera abre (navegador ou app novo). App antigo segue sem foto.
    const podeFoto = !nativo || Boolean(infoNativo().camera);
    let foto = null;
    const aviso = h('div', { class: 'nota' }, 'Tire a foto da entrega (mercadoria entregue ou fachada).');
    const arquivo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'oculto' });
    const tirar = h('button', { type: 'button', class: 'grande foto', onclick: () => arquivo.click() }, '📷 Tirar foto da entrega');
    arquivo.addEventListener('change', async () => {
      const f = arquivo.files && arquivo.files[0];
      if (!f) return;
      try {
        foto = await reduzirFoto(f);
        tirar.textContent = '✅ Foto tirada (toque para trocar)';
        aviso.textContent = '';
      } catch { aviso.textContent = 'Não consegui ler a foto. Tente de novo.'; }
    });
    const confirmar = () => {
      if (podeFoto && !foto) { aviso.textContent = 'Falta a foto da entrega.'; aviso.className = 'erro'; return; }
      if (foto) guardarFoto(p.demanda_id, foto);
      enviar({ recebedor: nome.value });
    };
    trocar(area, 
      h('label', null, 'Quem recebeu?'), nome,
      podeFoto && tirar, podeFoto && arquivo, podeFoto && aviso,
      h('button', { class: 'grande entrega', onclick: confirmar }, 'Confirmar entrega'),
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
  // Botão do Maps no topo e duas abas: cliente/endereço e detalhes.
  const d = lerParada(p);
  const mapa = h('button', { type: 'button', class: 'abrir-maps', onclick: navegar }, 'Abrir no Maps');
  const conteudo = h('div', null);
  const botaoAba = (qual, texto) => h('button', { type: 'button', role: 'tab', class: abaParada === qual ? 'ativa' : '', 'aria-selected': abaParada === qual ? 'true' : 'false',
    onclick: () => { abaParada = qual; desenharAba(); } }, texto);
  const abas = h('div', { class: 'abas', role: 'tablist' });
  function desenharAba() {
    trocar(abas, botaoAba('cliente', coleta ? 'Local e contato' : 'Cliente e endereço'), botaoAba('detalhes', coleta ? 'Detalhes' : 'Entrega'));
    trocar(conteudo, abaParada === 'cliente' ? abaCliente(p, d) : abaDetalhes(p, d));
  }
  desenharAba();
  return h('div', { class: `cartao atual ${p.tipo}` },
    h('div', { class: 'linha-topo' }, h('span', { class: `etiqueta ${p.tipo}` }, coleta ? 'AGORA: COLETA' : 'AGORA: ENTREGA'), prob),
    mapa,
    abas, conteudo,
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
