// Atendimento automático: pedidos pelo site, robô do WhatsApp, avisos ao cliente,
// convocação por mensagem e a fila de envio. Liga o servico.js ao mensageiro e ao robô.
import crypto from 'node:crypto';
import { Erro } from './servico.js';
import { conversar, reais } from './robo.js';
import { interpretar, enviar as enviarPadrao, normalizarTelefone, destinoDe } from './mensageiro.js';
import { coordValida, kmPelasRuas } from './geo.js';
import * as mercadoPago from './mercadopago.js';

const MIN = 60_000;
const VALIDADE_CONVERSA = 30 * MIN;
const VALIDADE_CONFIRMACAO = 60 * MIN;
const TENTATIVAS_MAX = 6;
const PEDIDOS_ABERTOS_MAX = 5;
const ALERTAS_AVISADOS = {
  parado: 'Parado na rota', sem_sinal: 'Sem sinal', gps_falso: 'GPS falso', gps_desligado: 'GPS desligado',
  carga_pendente: 'Turno encerrado com carga',
};
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const hora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function criarAtendimento({ servico, geocodificar = null, enviar = enviarPadrao, pagamentos = mercadoPago, kmRota = kmPelasRuas }) {
  const { q, tx, cfgBruta, auditar, agora } = servico.interno;
  const ligado = () => cfgBruta().whats_provedor !== '';
  const base = () => cfgBruta().url_publica.replace(/\/+$/, '');
  const link = (d) => `${base()}/acompanhar/?c=${d.codigo}`;

  // Primeiro acesso do admin: guarda o endereço do site para montar os links das mensagens.
  function definirOrigem(origem) {
    if (cfgBruta().url_publica || !/^https?:\/\/[^/]+$/.test(origem)) return;
    servico.salvarConfig({ url_publica: origem }, 'sistema');
  }

  // ------------------------------------------------- limite de uso (páginas públicas)
  const usos = new Map();
  function limitar(chave, max, janelaMs) {
    const t = agora();
    const lista = (usos.get(chave) || []).filter((x) => x > t - janelaMs);
    if (lista.length >= max) throw new Erro(429, 'muitas_tentativas', 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    lista.push(t);
    usos.set(chave, lista);
    if (usos.size > 5000) usos.clear();
  }

  // ------------------------------------------------------------ conversas
  function conversaDe(telefone, nome = '', destino = null) {
    let c = q('SELECT * FROM conversas WHERE telefone = ?').get(telefone);
    const t = agora();
    if (!c) {
      const rotulo = `${nome || 'Cliente'} · ${telefone}`.slice(0, 120);
      q(`INSERT INTO conversas (nome, criada_em, atualizada_em, telefone, destino) VALUES (?,?,?,?,?)
         ON CONFLICT(nome) DO UPDATE SET telefone = excluded.telefone, destino = excluded.destino`)
        .run(rotulo, t, t, telefone, destino || destinoDe(telefone));
      c = q('SELECT * FROM conversas WHERE telefone = ?').get(telefone);
    } else if (destino && destino !== c.destino) {
      q('UPDATE conversas SET destino = ? WHERE id = ?').run(destino, c.id);
      c.destino = destino;
    }
    return c;
  }
  function anotar(conversa, autor, texto, direcao) {
    const t = agora();
    q('INSERT OR IGNORE INTO mensagens (conversa_id, ts, autor, texto, direcao) VALUES (?,?,?,?,?)')
      .run(conversa.id, t, autor, texto.slice(0, 4000), direcao);
    q('UPDATE conversas SET atualizada_em = ? WHERE id = ?').run(t, conversa.id);
  }

  // ------------------------------------------------------- fila de envio
  function enfileirar(destino, texto, tipo) {
    if (!ligado() || !destino || !texto) return false;
    const t = agora();
    q('INSERT INTO saida (destino, texto, tipo, criada_em, proxima_em) VALUES (?,?,?,?,?)').run(destino, texto, tipo, t, t);
    return true;
  }
  // Mensagem para um telefone (cliente ou motoboy), registrada na conversa dele.
  // Avisos gerados enquanto o robô ainda está respondendo àquele telefone esperam a resposta sair antes.
  const adiados = new Map();
  function mandar(telefone, texto, tipo, autor = cfgBruta().empresa_nome) {
    if (!ligado() || !telefone) return false;
    if (adiados.has(telefone)) { adiados.get(telefone).push([texto, tipo, autor]); return true; }
    const c = conversaDe(telefone);
    anotar(c, autor, texto, 'saida');
    return enfileirar(c.destino || destinoDe(telefone), texto, tipo);
  }
  const avisarAdmin = (texto) => enfileirar(destinoDe(cfgBruta().admin_telefone || ''), texto, 'admin');

  let enviando = false;
  async function despacharSaida() {
    if (enviando || !ligado()) return 0;
    enviando = true;
    let n = 0;
    try {
      const pendentes = q(`SELECT * FROM saida WHERE enviada_em IS NULL AND tentativas < ? AND proxima_em <= ?
                           ORDER BY id LIMIT 20`).all(TENTATIVAS_MAX, agora());
      for (const m of pendentes) {
        try {
          await enviar(cfgBruta(), m.destino, m.texto);
          q('UPDATE saida SET enviada_em = ?, erro = NULL WHERE id = ?').run(agora(), m.id);
          n++;
        } catch (e) {
          const espera = 30_000 * 2 ** m.tentativas;
          q('UPDATE saida SET tentativas = tentativas + 1, erro = ?, proxima_em = ? WHERE id = ?')
            .run(String(e.message || e).slice(0, 300), agora() + espera, m.id);
        }
      }
    } finally {
      enviando = false;
    }
    return n;
  }

  // -------------------------------------------------------------- clientes
  function lembrarCliente(telefone, nome, coleta, email = '') {
    const t = agora();
    // Cliente fixo mantém o nome que o admin cadastrou.
    q(`INSERT INTO clientes (telefone, nome, criado_em, pedidos, ult_endereco, ult_lat, ult_lon, email) VALUES (?,?,?,1,?,?,?,?)
       ON CONFLICT(telefone) DO UPDATE SET nome = CASE WHEN faturado = 1 THEN nome ELSE excluded.nome END, pedidos = pedidos + 1,
         ult_endereco = excluded.ult_endereco, ult_lat = excluded.ult_lat, ult_lon = excluded.ult_lon,
         email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE email END`)
      .run(telefone, nome, t, coleta.endereco, coleta.lat, coleta.lon, email);
  }
  const abertosDe = (telefone) => q(`SELECT * FROM demandas WHERE cliente_telefone = ?
      AND status IN ('sem_local','aguardando','atribuida','coletada') ORDER BY id DESC`).all(telefone);

  async function acharNoMapa(ponto) {
    if (ponto.lat != null || !geocodificar) return;
    try {
      const [achado] = await geocodificar(ponto.endereco, { cidadeBase: cfgBruta().cidade_base, limite: 1 });
      if (achado) { ponto.lat = achado.lat; ponto.lon = achado.lon; ponto.nome = achado.nome; }
    } catch { /* fica sem ponto: o admin marca no painel */ }
  }
  function motivoRecusa(telefone) {
    const horario = servico.foraDoHorario();
    if (horario) return `No momento estamos fechados. 😴\nNosso horário de atendimento: ${horario}.`;
    if (telefone && abertosDe(telefone).length >= PEDIDOS_ABERTOS_MAX) {
      return 'Você já tem vários pedidos em andamento. Para pedir mais, fale com um atendente.';
    }
    return '';
  }

  // Km pelas ruas quando há chave de rota; senão o servico.js usa linha reta × 1,35.
  async function distancia(coleta, entrega) {
    const chave = cfgBruta().ors_chave;
    if (!chave || coleta.lat == null || entrega.lat == null) return null;
    return kmRota(chave, coleta, entrega);
  }
  const clienteFixo = (telefone) => q('SELECT * FROM clientes WHERE telefone = ? AND faturado = 1').get(telefone) || null;

  // ------------------------------------------------------------ pagamento (Pix)
  async function gerarPix(d) {
    const c = cfgBruta();
    const expira = agora() + Number(c.pagamento_validade_min) * MIN;
    const pix = await pagamentos.criarPix(c.mp_token, {
      valor: d.valor, descricao: `${c.empresa_nome} - entrega #${d.id}`, email: d.email, referencia: d.codigo,
      avisoUrl: base().startsWith('https://') ? `${base()}/api/pagamento/mp?s=${c.whats_segredo}` : null,
      expiraEm: expira,
    });
    servico.registrarPix(d.id, { pagId: pix.id, pix: pix.codigo, qr: pix.qr, expira });
    return { codigo: pix.codigo, qr: pix.qr, expira };
  }
  // Confere no Mercado Pago (nunca confia no aviso recebido). Devolve true se ficou pago.
  const conferidos = new Map();
  async function verificarPagamento(d, { forcar = false } = {}) {
    if (d.pagamento !== 'pendente' || !d.pag_id) return d.pagamento === 'pago';
    if (!forcar && agora() - (conferidos.get(d.id) || 0) < 5000) return false;
    conferidos.set(d.id, agora());
    if (conferidos.size > 2000) conferidos.clear();
    const p = await pagamentos.consultar(cfgBruta().mp_token, d.pag_id);
    if (p.status !== 'approved' || p.referencia !== d.codigo || !(p.valor >= d.valor - 0.01)) return false;
    servico.marcarPago(d.id);
    return true;
  }
  async function webhookPagamento(corpo, url) {
    const id = corpo?.data?.id ?? url.searchParams.get('data.id') ?? url.searchParams.get('id');
    const d = id ? q('SELECT * FROM demandas WHERE pag_id = ?').get(String(id)) : null;
    if (d) await verificarPagamento(d, { forcar: true });
  }
  // Página de acompanhamento: enquanto espera o Pix, confere o pagamento a cada consulta.
  async function pedidoVivo(codigo) {
    const d = typeof codigo === 'string' ? q('SELECT * FROM demandas WHERE codigo = ?').get(codigo) : null;
    if (d && d.pagamento === 'pendente' && d.status !== 'cancelada') await verificarPagamento(d).catch(() => {});
    return servico.pedidoPublico(codigo);
  }
  // Pix vencido sem pagamento: confere uma última vez e cancela o pedido.
  async function expirarPagamentos() {
    const vencidos = q(`SELECT * FROM demandas WHERE pagamento = 'pendente' AND pag_expira < ?
                        AND retida = 1 AND status IN ('sem_local','aguardando')`).all(agora());
    for (const d of vencidos) {
      let pago = false;
      try { pago = await verificarPagamento(d, { forcar: true }); } catch { continue; } // banco fora do ar: tenta na próxima
      if (pago) continue;
      silenciarCancelamento = true;
      try { servico.cancelarDemanda(d.id, 'sistema'); } finally { silenciarCancelamento = false; }
      if (d.cliente_telefone) mandar(d.cliente_telefone, `Pedido #${d.id} cancelado: o Pix não foi pago a tempo. Envie *oi* para pedir de novo.`, 'cliente');
    }
  }

  // ----------------------------------------------------- robô do WhatsApp
  let silenciarCancelamento = false;
  function ajudas(msg) {
    const cliente = q('SELECT * FROM clientes WHERE telefone = ?').get(msg.telefone);
    const nome = msg.nome || cliente?.nome || 'Cliente';
    const minha = (id) => q('SELECT * FROM demandas WHERE id = ? AND cliente_telefone = ?').get(Number(id), msg.telefone);
    return {
      empresa: cfgBruta().empresa_nome,
      fechado: () => motivoRecusa(msg.telefone),
      geocodificar: (texto) => (geocodificar ? geocodificar(texto, { cidadeBase: cfgBruta().cidade_base, limite: 1 }) : []),
      cotar: async (c, e, servicoId) => servico.cotar(c, e, { km: await distancia(c, e), servicoId, telefone: msg.telefone }),
      servicos: () => servico.listarServicos().filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome })),
      pedeEmail: (dados) => pagaNaHora(msg.telefone) && !dados.email && !EMAIL.test(cliente?.email || ''),
      ultimoEndereco: () => (cliente?.ult_endereco && cliente.ult_lat != null
        ? { endereco: cliente.ult_endereco, lat: cliente.ult_lat, lon: cliente.ult_lon } : null),
      pedidos: () => abertosDe(msg.telefone).map((d) => ({ id: d.id, status: d.status, link: link(d) })),
      criarPedido: async (dados) => {
        const contato = `${nome} ${msg.telefone}`;
        const fixo = clienteFixo(msg.telefone);
        const email = dados.email || cliente?.email || '';
        const km = await distancia(dados.coleta, dados.entrega);
        const previa = servico.cotar(dados.coleta, dados.entrega, { km, servicoId: dados.servico_id, telefone: msg.telefone });
        const pagar = pagaNaHora(msg.telefone) && previa.valor != null && EMAIL.test(email);
        const d = servico.criarPedido({
          cliente: nome, telefone: msg.telefone, descricao: dados.descricao, requisito: dados.requisito,
          urgente: true, servico_id: dados.servico_id, km, email,
          coleta: { ...dados.coleta, contato }, entrega: dados.entrega,
        }, 'robo', { retida: pagar, pagamento: fixo ? 'faturado' : '' });
        lembrarCliente(msg.telefone, nome, dados.coleta, email);
        const r = { id: d.id, status: d.status, link: link(d), valor: d.valor, validade_min: Number(cfgBruta().pagamento_validade_min) };
        if (!pagar) return r;
        try {
          return { ...r, pix: (await gerarPix(d)).codigo };
        } catch (e) {
          // Sem Pix agora: o pedido fica esperando aprovação no painel em vez de se perder.
          avisarAdmin(`⚠️ Não consegui gerar o Pix do pedido #${d.id} (${e.message}). Ele está esperando sua aprovação no painel.`);
          return { ...r, status: 'sem_local' };
        }
      },
      confirmarSite: (id) => {
        const d = minha(id);
        if (!d || !servico.liberarDemanda(d.id, 'cliente')) return null;
        return { id: d.id, link: link(d) };
      },
      cancelarSite: (id) => {
        const d = minha(id);
        if (!d || !d.retida || ['entregue', 'cancelada'].includes(d.status)) return;
        silenciarCancelamento = true;
        try { servico.cancelarDemanda(d.id, 'cliente'); } finally { silenciarCancelamento = false; }
      },
    };
  }

  async function tratar(msg) {
    const c = conversaDe(msg.telefone, msg.nome, msg.destino);
    const local = msg.lat != null ? `📍 Localização: ${msg.lat.toFixed(5)}, ${msg.lon.toFixed(5)}` : '';
    anotar(c, msg.nome || msg.telefone, [msg.texto, local].filter(Boolean).join('\n') || '(mídia sem texto)', 'entrada');

    // Motoboy respondendo à convocação: só fica registrado.
    if (q('SELECT id FROM motoboys WHERE telefone = ? AND ativo = 1').get(msg.telefone)) return;
    const voltar = /^\s*menu\s*$/i.test(msg.texto);
    if (cfgBruta().robo_ativo !== '1' || (c.humano && !voltar)) {
      q('UPDATE conversas SET pendente = 1 WHERE id = ?').run(c.id);
      return;
    }
    const validade = c.etapa === 'site' ? VALIDADE_CONFIRMACAO : VALIDADE_CONVERSA;
    const vencida = !c.etapa_em || agora() - c.etapa_em > validade;
    let dados = {};
    try { dados = JSON.parse(c.dados || '{}'); } catch { /* recomeça */ }
    const estado = vencida || c.humano ? { etapa: '', dados: {} } : { etapa: c.etapa, dados };
    adiados.set(msg.telefone, []);
    let r;
    let depois;
    try {
      r = await conversar(estado, msg, ajudas(msg));
    } finally {
      depois = adiados.get(msg.telefone);
      adiados.delete(msg.telefone);
      if (!r) for (const [texto, tipo, autor] of depois) mandar(msg.telefone, texto, tipo, autor); // robô falhou: avisos saem mesmo assim
    }
    tx(() => {
      q('UPDATE conversas SET etapa = ?, dados = ?, etapa_em = ?, humano = ?, pendente = ? WHERE id = ?')
        .run(r.etapa, JSON.stringify(r.dados), agora(), r.humano ? 1 : 0, r.humano ? 1 : 0, c.id);
      for (const texto of r.respostas) {
        anotar(c, 'Robô', texto, 'saida');
        enfileirar(c.destino, texto, 'robo');
      }
      for (const [texto, tipo, autor] of depois) mandar(msg.telefone, texto, tipo, autor);
      if (r.humano) avisarAdmin(`🙋 ${msg.nome || msg.telefone} pediu um atendente no WhatsApp. Responda pelo painel (aba WhatsApp).`);
    });
  }

  // Uma conversa por vez por telefone, para as respostas não se atropelarem.
  const filas = new Map();
  function receber(corpo) {
    const mensagens = interpretar(cfgBruta().whats_provedor, corpo);
    const tarefas = mensagens.map((msg) => {
      const anterior = filas.get(msg.telefone) || Promise.resolve();
      const tarefa = anterior.then(() => tratar(msg)).catch((e) => console.error('[robo]', e));
      filas.set(msg.telefone, tarefa);
      tarefa.finally(() => { if (filas.get(msg.telefone) === tarefa) filas.delete(msg.telefone); });
      return tarefa;
    });
    return Promise.all(tarefas).then(() => despacharSaida()).then(() => mensagens.length);
  }
  function segredoConfere(valor) {
    const certo = cfgBruta().whats_segredo;
    const a = Buffer.from(String(valor || ''));
    const b = Buffer.from(certo);
    return certo !== '' && a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ------------------------------------------------- avisos automáticos
  servico.aoEvento((evento, { demanda: d, motoboy, convocacao, turno, tipo, detalhe }) => {
    const c = cfgBruta();
    const aoCliente = (texto) => {
      if (c.avisos_cliente === '1' && d.cliente_telefone) mandar(d.cliente_telefone, texto, 'cliente');
    };
    if (evento === 'demanda_criada') {
      if (d.status === 'sem_local') avisarAdmin(`📍 Pedido #${d.id} de ${d.cliente} entrou sem local no mapa. Marque o ponto no painel.`);
    } else if (evento === 'demanda_atribuida') {
      aoCliente(`🛵 Pedido #${d.id}: ${motoboy.nome.split(/\s+/)[0]} está a caminho da coleta.\n\nAcompanhe: ${link(d)}`);
    } else if (evento === 'demanda_coletada') {
      aoCliente(`📦 Pedido #${d.id} coletado! Está a caminho da entrega.`);
    } else if (evento === 'demanda_entregue') {
      aoCliente(`✅ Pedido #${d.id} entregue para ${d.recebedor || 'o destinatário'} às ${hora(d.entregue_em)}.\n\nObrigado por escolher a ${c.empresa_nome}!`);
    } else if (evento === 'demanda_cancelada') {
      if (!silenciarCancelamento) aoCliente(`Pedido #${d.id} foi cancelado. Qualquer dúvida, é só chamar por aqui.`);
      if (d.pagamento === 'pago') avisarAdmin(`💸 Pedido #${d.id} foi cancelado depois de pago. Devolva o Pix de ${reais(d.valor)} pelo Mercado Pago.`);
    } else if (evento === 'demanda_paga') {
      aoCliente(`✅ Pagamento do pedido #${d.id} confirmado! Já estamos chamando o motoboy.\n\nAcompanhe: ${link(d)}`);
    } else if (evento === 'cobrar') {
      // Endereço conferido pelo admin: agora há valor, então o cliente recebe o Pix.
      gerarPix(d).then((pix) => {
        if (!d.cliente_telefone) return;
        mandar(d.cliente_telefone, `📍 Endereço do pedido #${d.id} conferido. Valor: *${reais(d.valor)}*. Para liberar o motoboy, pague o Pix (copia e cola na próxima mensagem) em até ${c.pagamento_validade_min} min.\n\nQR code: ${link(d)}`, 'cliente');
        mandar(d.cliente_telefone, pix.codigo, 'cliente');
      }).catch((e) => {
        avisarAdmin(`⚠️ Não consegui gerar o Pix do pedido #${d.id} (${e.message}). Ele está esperando sua aprovação no painel.`);
      });
    } else if (evento === 'pago_cancelado') {
      avisarAdmin(`💸 O Pix do pedido #${d.id} caiu depois de o pedido ser cancelado. Devolva ${reais(d.valor)} pelo Mercado Pago.`);
    } else if (evento === 'oferta') {
      const ganho = turno.tipo === 'avulso' && d.repasse != null ? ` (${reais(d.repasse)} para você)` : '';
      mandar(motoboy.telefone, `🛵 Entrega disponível${ganho}: coleta em ${d.coleta_endereco}. Abra o app Speed Motoboy para aceitar.`, 'oferta');
    } else if (evento === 'sem_aceite') {
      avisarAdmin(`⏰ Pedido #${d.id} de ${d.cliente} está há ${c.oferta_alerta_min} min sem motoboy aceitar. Veja no painel.`);
    } else if (evento === 'convocacao') {
      mandar(motoboy.telefone,
        `Olá, ${motoboy.nome.split(/\s+/)[0]}! A ${c.empresa_nome} convocou você para o turno de hoje. Abra o app Speed Motoboy e inicie o turno.`,
        'convocacao');
      if (convocacao.origem === 'auto') avisarAdmin(`📣 Convocação automática: ${motoboy.nome} foi chamado porque há demanda esperando e ninguém em turno para atender.`);
    } else if (evento === 'alerta' && ALERTAS_AVISADOS[tipo]) {
      const m = q('SELECT nome FROM motoboys WHERE id = ?').get(turno.motoboy_id);
      avisarAdmin(`⚠️ ${ALERTAS_AVISADOS[tipo]} — ${m?.nome || 'motoboy'}. ${detalhe}`);
    }
  });

  // -------------------------------------------------------- pedido pelo site
  function modoConfirmacao() {
    const c = cfgBruta();
    if (c.site_confirmacao === 'whatsapp' && !ligado()) return 'painel';
    if (c.site_confirmacao === 'pagamento' && !c.mp_token) return 'painel';
    return c.site_confirmacao;
  }
  // Paga antes de liberar? (cliente fixo vai para a fatura mensal)
  const pagaNaHora = (telefone) => modoConfirmacao() === 'pagamento' && !clienteFixo(telefone);
  function infoPublica() {
    const c = cfgBruta();
    return {
      empresa: c.empresa_nome, ativo: c.pedidos_site === '1', fechado: servico.foraDoHorario(),
      mapa: { lat: Number(c.mapa_lat), lon: Number(c.mapa_lon) },
      prazo_min: Number(c.urgente_prazo_min), pagamento: modoConfirmacao() === 'pagamento',
      servicos: servico.listarServicos().filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome, adicional: x.adicional })),
    };
  }
  function lerPontoPublico(p) {
    const lat = p?.lat == null || p.lat === '' ? null : Number(p.lat);
    const lon = p?.lon == null || p.lon === '' ? null : Number(p.lon);
    const ok = lat != null && lon != null && coordValida(lat, lon);
    return { endereco: txt(p?.endereco, 200), contato: txt(p?.contato, 120), lat: ok ? lat : null, lon: ok ? lon : null };
  }
  async function cotarPublico(dados, ip) {
    if (cfgBruta().pedidos_site !== '1') throw new Erro(403, 'desligado', 'Pedidos pelo site estão desligados.');
    limitar(`cotar:${ip}`, 30, 15 * MIN);
    const coleta = lerPontoPublico(dados?.coleta);
    const entrega = lerPontoPublico(dados?.entrega);
    for (const [p, nome] of [[coleta, 'coleta'], [entrega, 'entrega']]) {
      if (p.endereco.length < 6) throw new Erro(422, 'endereco_invalido', `Escreva o endereço de ${nome} com rua, número e bairro.`);
      await acharNoMapa(p);
    }
    const cot = servico.cotar(coleta, entrega, {
      km: await distancia(coleta, entrega), servicoId: dados?.servico_id, telefone: normalizarTelefone(dados?.telefone),
    });
    return { coleta, entrega, km: cot.km, valor: cot.valor };
  }
  async function pedidoSite(dados, ip) {
    const c = cfgBruta();
    if (c.pedidos_site !== '1') throw new Erro(403, 'desligado', 'Pedidos pelo site estão desligados.');
    if (txt(dados?.site, 50) !== '') throw new Erro(422, 'invalido', 'Não foi possível enviar o pedido.'); // campo-isca de robôs
    const nome = txt(dados?.nome, 80);
    const telefone = normalizarTelefone(dados?.telefone);
    if (nome.length < 2) throw new Erro(422, 'nome_invalido', 'Informe seu nome.');
    if (!telefone) throw new Erro(422, 'telefone_invalido', 'Informe seu WhatsApp com DDD.');
    const recusa = motivoRecusa(telefone);
    if (recusa) throw new Erro(409, 'recusado', recusa.replace(/\s*😴/, ''));
    limitar(`pedir:${ip}`, 8, 60 * MIN);

    const coleta = lerPontoPublico(dados?.coleta);
    const entrega = lerPontoPublico(dados?.entrega);
    await acharNoMapa(coleta);
    await acharNoMapa(entrega);
    if (!coleta.contato) coleta.contato = `${nome} ${telefone}`;
    const km = await distancia(coleta, entrega);
    const previa = servico.cotar(coleta, entrega, { km, servicoId: dados?.servico_id, telefone });
    const fixo = clienteFixo(telefone);
    const email = txt(dados?.email, 120).toLowerCase();
    // Cliente fixo não paga na hora, mas precisa provar que é ele (qualquer um pode digitar o telefone dele).
    let modo = fixo ? (ligado() ? 'whatsapp' : 'painel') : modoConfirmacao();
    if (modo === 'pagamento') {
      if (!EMAIL.test(email)) throw new Erro(422, 'email_invalido', 'Informe um e-mail válido: o comprovante do Pix vai para ele.');
      if (previa.valor == null) modo = 'painel'; // sem ponto no mapa não há preço: a equipe confere e o Pix vai depois
    }
    const d = servico.criarPedido({
      cliente: fixo?.nome || nome, telefone, descricao: dados?.descricao, requisito: dados?.requisito ?? 'qualquer',
      urgente: true, servico_id: dados?.servico_id, km, email, coleta, entrega,
    }, 'site', { retida: modo !== 'nenhuma', pagamento: fixo ? 'faturado' : '' });
    lembrarCliente(telefone, nome, coleta, email);

    let pix = null;
    if (modo === 'pagamento') {
      try {
        pix = await gerarPix(d);
      } catch (e) {
        modo = 'painel';
        avisarAdmin(`⚠️ Não consegui gerar o Pix do pedido #${d.id} (${e.message}).`);
      }
    }
    if (modo === 'painel') avisarAdmin(`🆕 Pedido #${d.id} de ${d.cliente} chegou pelo site e espera sua aprovação no painel.`);

    if (modo === 'whatsapp') {
      const conversa = conversaDe(telefone, nome);
      q('UPDATE conversas SET etapa = ?, dados = ?, etapa_em = ?, humano = 0 WHERE id = ?')
        .run('site', JSON.stringify({ demanda_id: d.id }), agora(), conversa.id);
      mandar(telefone, [
        `Olá, ${nome.split(/\s+/)[0]}! Recebemos um pedido no site da *${c.empresa_nome}*:`,
        `📦 Coleta: ${d.coleta_endereco}`, `🏁 Entrega: ${d.entrega_endereco}`,
        d.valor != null ? `💰 Valor: ${reais(d.valor)}` : null,
        '', 'Foi você? Responda:', '*1* - Confirmar', '*2* - Cancelar',
      ].filter((l) => l !== null).join('\n'), 'robo', 'Robô');
    }
    return { id: d.id, codigo: d.codigo, status: d.status, valor: d.valor, confirmacao: modo, pix };
  }

  // ------------------------------------------------------ painel do admin
  function resumo() {
    const dia = agora() - 24 * 60 * MIN;
    return {
      whatsapp: {
        ligado: ligado(),
        pendentes: q('SELECT COUNT(*) AS n FROM conversas WHERE pendente = 1').get().n,
        na_fila: q('SELECT COUNT(*) AS n FROM saida WHERE enviada_em IS NULL AND tentativas < ?').get(TENTATIVAS_MAX).n,
        falhas: q('SELECT COUNT(*) AS n FROM saida WHERE enviada_em IS NULL AND tentativas >= ? AND criada_em >= ?').get(TENTATIVAS_MAX, dia).n,
        ultimo_erro: q('SELECT erro FROM saida WHERE erro IS NOT NULL AND criada_em >= ? ORDER BY id DESC LIMIT 1').get(dia)?.erro || '',
      },
    };
  }
  function conversaViva(id) {
    const c = q('SELECT * FROM conversas WHERE id = ?').get(id);
    if (!c || !c.telefone) throw new Erro(404, 'nao_encontrado', 'Essa conversa não é do WhatsApp ao vivo.');
    return c;
  }
  // Resposta digitada no painel: o robô se cala nessa conversa até o cliente mandar "menu".
  function responder(id, texto, ator) {
    const c = conversaViva(id);
    const corpo = txt(texto, 2000);
    if (!corpo) throw new Erro(422, 'texto_vazio', 'Escreva a mensagem.');
    if (!ligado()) throw new Erro(409, 'whats_desligado', 'Ligue o WhatsApp automático em Configurações para responder por aqui.');
    tx(() => {
      anotar(c, 'Atendente', corpo, 'saida');
      enfileirar(c.destino, corpo, 'atendente');
      q('UPDATE conversas SET humano = 1, pendente = 0 WHERE id = ?').run(c.id);
      auditar(ator, 'whatsapp_resposta', c.nome);
    });
    despacharSaida().catch(() => {});
  }
  function modoConversa(id, humano) {
    const c = conversaViva(id);
    q("UPDATE conversas SET humano = ?, pendente = 0, etapa = '', dados = '{}' WHERE id = ?").run(humano ? 1 : 0, c.id);
  }
  async function testar() {
    const c = cfgBruta();
    if (!ligado()) throw new Erro(409, 'whats_desligado', 'Escolha o provedor e salve antes de testar.');
    if (!c.admin_telefone) throw new Erro(422, 'sem_telefone', 'Preencha e salve o WhatsApp do responsável: o teste vai para ele.');
    try {
      await enviar(c, destinoDe(c.admin_telefone), `✅ Teste do ${c.empresa_nome} Despacho: o WhatsApp automático está funcionando.`);
    } catch (e) {
      throw new Erro(502, 'envio_falhou', `Não consegui enviar: ${e.message}`);
    }
    return { ok: true };
  }

  // Pedido do site que o cliente não confirmou no WhatsApp a tempo: cancela.
  function rotina() {
    const limite = agora() - VALIDADE_CONFIRMACAO;
    for (const c of q("SELECT * FROM conversas WHERE etapa = 'site' AND etapa_em < ?").all(limite)) {
      let id = null;
      try { id = JSON.parse(c.dados).demanda_id; } catch { /* sem pedido */ }
      const d = id ? q('SELECT * FROM demandas WHERE id = ?').get(id) : null;
      q("UPDATE conversas SET etapa = '', dados = '{}' WHERE id = ?").run(c.id);
      if (d && d.retida && !['entregue', 'cancelada'].includes(d.status)) {
        silenciarCancelamento = true;
        try { servico.cancelarDemanda(d.id, 'sistema'); } finally { silenciarCancelamento = false; }
        mandar(c.telefone, `Pedido #${d.id} cancelado por falta de confirmação. Envie *oi* para pedir de novo.`, 'cliente');
      }
    }
    q('DELETE FROM saida WHERE criada_em < ?').run(agora() - 30 * 24 * 60 * MIN);
    expirarPagamentos().catch((e) => console.error('[pagamento]', e));
  }

  return {
    definirOrigem, receber, segredoConfere, despacharSaida, rotina,
    infoPublica, cotarPublico, pedidoSite, pedidoVivo, webhookPagamento, expirarPagamentos,
    resumo, responder, modoConversa, testar,
  };
}
