// Atendimento automático: pedidos pelo site, robô do WhatsApp, avisos ao cliente,
// convocação por mensagem e a fila de envio. Liga o servico.js ao mensageiro e ao robô.
import crypto from 'node:crypto';
import { Erro } from './servico.js';
import { conversar, reais } from './robo.js';
import { interpretar, enviar as enviarPadrao, normalizarTelefone, destinoDe, assinaturaMetaConfere } from './mensageiro.js';
import { coordValida, kmPelasRuas } from './geo.js';
import * as mercadoPago from './mercadopago.js';
import { brCode } from './pix.js';
import { criarIA } from './ia.js';
import { lerConversa, textoDoZip } from './whatsapp.js';

const MIN = 60_000;
const VALIDADE_CONVERSA = 30 * MIN;
const VALIDADE_CONFIRMACAO = 60 * MIN;
const TENTATIVAS_MAX = 6;
const PEDIDOS_ABERTOS_MAX = 5;
const ALERTAS_AVISADOS = {
  parado: 'Parado na rota', sem_sinal: 'Sem sinal', gps_falso: 'GPS falso', gps_desligado: 'GPS desligado',
  carga_pendente: 'Turno encerrado com carga', problema: 'PROBLEMA NA ENTREGA',
};
const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const hora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ARQUIVOS_MAX = 6;
const IMAGEM_MAX = 4.5 * 1024 * 1024;
const PDF_MAX = 12 * 1024 * 1024;
const TEXTO_IA_MAX = 80_000; // letras de conversa por análise
const MENSAGENS_IA_MAX = 500;
const ANALISES_GUARDADAS = 200;

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const DISSE_QUE_PAGOU = /\b(paguei|pago|comprovante|transferi|pix feito|fiz o pix|ja fiz|enviado)\b/;

export function criarAtendimento({
  servico, geocodificar = null, enviar = enviarPadrao, pagamentos = mercadoPago, kmRota = kmPelasRuas, ia = criarIA(),
}) {
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
          // O id devolvido pela Meta serve para reconhecer o eco desta mesma mensagem, se vier.
          const id = await enviar(cfgBruta(), m.destino, m.texto);
          q('UPDATE saida SET enviada_em = ?, erro = NULL, msg_id = ? WHERE id = ?').run(agora(), id || null, m.id);
          n++;
        } catch (e) {
          // Erro definitivo (ex.: fora da janela de 24 h): não adianta tentar de novo.
          const espera = 30_000 * 2 ** m.tentativas;
          q('UPDATE saida SET tentativas = ?, erro = ?, proxima_em = ? WHERE id = ?')
            .run(e.definitivo ? TENTATIVAS_MAX : m.tentativas + 1, String(e.message || e).slice(0, 300), agora() + espera, m.id);
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
    if (servico.modoPagamento() === 'pix') {
      // Pix direto na conta da empresa: o código já leva o valor e o número do pedido.
      const codigo = brCode({ chave: c.pix_chave, nome: c.pix_nome || c.empresa_nome, cidade: c.pix_cidade, valor: d.valor, txid: `PEDIDO${d.id}` });
      servico.registrarPix(d.id, { pagId: '', pix: codigo, qr: '', expira });
      avisarAdmin(`💰 Pedido #${d.id} de ${d.cliente}: esperando Pix de ${reais(d.valor)}. Quando o dinheiro cair na conta, responda *pago ${d.id}* aqui (ou confirme no painel). Para cancelar: *cancelar ${d.id}*.`);
      return { codigo, qr: '', expira, manual: true };
    }
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
      if (!d.pag_id) {
        // Pix na chave da empresa: o sistema não enxerga a conta, então não cancela sozinho. Lembra o responsável uma vez.
        q('UPDATE demandas SET pag_expira = NULL WHERE id = ?').run(d.id);
        avisarAdmin(`⏰ Pedido #${d.id} de ${d.cliente} ainda sem confirmação do Pix de ${reais(d.valor)}. Responda *pago ${d.id}* se o dinheiro caiu, ou *cancelar ${d.id}*.`);
        continue;
      }
      let pago = false;
      try { pago = await verificarPagamento(d, { forcar: true }); } catch { continue; } // banco fora do ar: tenta na próxima
      if (pago) continue;
      silenciarCancelamento = true;
      try { servico.cancelarDemanda(d.id, 'sistema'); } finally { silenciarCancelamento = false; }
      if (d.cliente_telefone) mandar(d.cliente_telefone, `Pedido #${d.id} cancelado: o Pix não foi pago a tempo. Envie *oi* para pedir de novo.`, 'cliente');
    }
  }

  // ------------------------------------------------- conferência por IA
  const iaLigada = () => cfgBruta().ia_ativa === '1' && cfgBruta().ia_chave !== '';
  // Manda à IA só o necessário (sem nome nem telefone). Devolve a análise ou null se ela não pôde avaliar.
  async function conferirIA({ coleta, entrega, km, servicoId, descricao }, opcoes) {
    if (!iaLigada()) return null;
    const c = cfgBruta();
    const tipos = servico.listarServicos().filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome }));
    const ponto = (p) => ({
      endereco_escrito: p.endereco,
      local_no_mapa: p.lat != null ? (p.nome || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`) : null,
    });
    const r = await ia.conferir(c, {
      cidades_atendidas: c.cidades_atendidas, tipos_de_servico: tipos,
      pedido: {
        coleta: ponto(coleta), entrega: ponto(entrega), distancia_km: km,
        tipo_escolhido_id: servicoId || null, descricao: String(descricao || ''),
      },
    }, opcoes);
    if (r && r.servico_id && !tipos.some((x) => x.id === r.servico_id)) r.servico_id = null; // id inventado: ignora
    return r;
  }
  async function testarIA() {
    if (!cfgBruta().ia_chave) throw new Erro(422, 'sem_chave', 'Cole a chave da IA e salve antes de testar.');
    const cartorio = servico.listarServicos().find((x) => x.ativo);
    try {
      const r = await conferirIA({
        coleta: { endereco: 'Rua Henrique Laranja, 325, Centro, Vila Velha', lat: -20.3358, lon: -40.2969, nome: 'Rua Henrique Laranja, Centro, Vila Velha, ES' },
        entrega: { endereco: 'Av. Princesa Isabel, 500, Centro, Vitória', lat: -20.3195, lon: -40.338, nome: 'Avenida Princesa Isabel, Centro, Vitória, ES' },
        km: 6.3, servicoId: cartorio?.id, descricao: 'Reconhecer firma no cartório e entregar o documento no escritório',
      }, { lancar: true });
      const nome = servico.listarServicos().find((x) => x.id === r.servico_id)?.nome || 'não identificou';
      return { ok: true, mensagem: `IA respondeu. Pedido de exemplo: ${r.aprovado ? 'aprovado' : 'para conferir'}; serviço: ${nome}; resumo: ${r.resumo}` };
    } catch (e) {
      throw new Erro(502, 'ia_falhou', e.message);
    }
  }

  // --------------------------------------- análise de arquivos pela IA
  // Tipo pelo conteúdo (não pela extensão): foto, PDF, ou texto/zip de conversa do WhatsApp.
  function prepararArquivo(a, avisos) {
    const nome = txt(a?.nome, 120) || 'arquivo';
    const buf = Buffer.from(String(a?.conteudo || ''), 'base64');
    if (!buf.length) throw new Erro(422, 'arquivo_vazio', `${nome}: arquivo vazio.`);
    const inicio = buf.subarray(0, 12);
    const mime = inicio[0] === 0xff && inicio[1] === 0xd8 ? 'image/jpeg'
      : inicio.subarray(1, 4).toString('latin1') === 'PNG' ? 'image/png'
        : inicio.subarray(0, 4).toString('latin1') === 'GIF8' ? 'image/gif'
          : inicio.subarray(0, 4).toString('latin1') === 'RIFF' && inicio.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : '';
    if (mime) {
      if (buf.length > IMAGEM_MAX) throw new Erro(413, 'arquivo_grande', `${nome}: foto grande demais (máximo 4,5 MB).`);
      return { nome, tipo: 'imagem', mime, base64: buf.toString('base64') };
    }
    if (inicio.subarray(0, 5).toString('latin1') === '%PDF-') {
      if (buf.length > PDF_MAX) throw new Erro(413, 'arquivo_grande', `${nome}: PDF grande demais (máximo 12 MB).`);
      return { nome, tipo: 'pdf', base64: buf.toString('base64') };
    }
    let bruto;
    try {
      bruto = buf.readUInt32LE(0) === 0x04034b50 ? textoDoZip(buf) : buf.toString('utf8');
    } catch (e) {
      throw new Erro(422, 'arquivo_invalido', `${nome}: não consegui abrir (${e.message}).`);
    }
    if (bruto.includes('\u0000')) {
      throw new Erro(422, 'tipo_invalido', `${nome}: tipo de arquivo não aceito. Envie foto, PDF ou conversa do WhatsApp (.txt ou .zip).`);
    }
    const mensagens = lerConversa(bruto);
    if (mensagens.length) return { nome, tipo: 'texto', texto: textoDaConversa(nome, mensagens, avisos) };
    if (bruto.length > TEXTO_IA_MAX) avisos.push(`${nome}: texto longo, analisei só o final (${TEXTO_IA_MAX.toLocaleString('pt-BR')} de ${bruto.length.toLocaleString('pt-BR')} letras).`);
    return { nome, tipo: 'texto', texto: bruto.slice(-TEXTO_IA_MAX) };
  }
  // Conversa em linhas "[dia/mês hora] autor: texto". Se for longa, fica com o final e avisa (nada é cortado em silêncio).
  function textoDaConversa(nome, mensagens, avisos) {
    const linhas = mensagens.map((m) => {
      const d = new Date(m.ts);
      const quando = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hora(m.ts)}`;
      return `[${quando}] ${m.autor || 'aviso do WhatsApp'}: ${m.texto}`;
    });
    let usadas = linhas.slice(-MENSAGENS_IA_MAX);
    while (usadas.length > 1 && usadas.reduce((n, l) => n + l.length + 1, 0) > TEXTO_IA_MAX) usadas = usadas.slice(Math.ceil(usadas.length / 10));
    if (usadas.length < linhas.length) avisos.push(`${nome}: conversa longa, analisei as últimas ${usadas.length} de ${linhas.length} mensagens.`);
    return usadas.join('\n');
  }
  function contextoIA() {
    const c = cfgBruta();
    return {
      empresa: c.empresa_nome, cidades_atendidas: c.cidades_atendidas,
      tipos_de_servico: servico.listarServicos().filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome })),
      recebedor_dos_pagamentos: { nome: c.pix_nome || c.empresa_nome, chave_pix: c.pix_chave },
      // Só número e valor: nome de cliente não vai para a IA por este caminho.
      pedidos_esperando_pagamento: q(`SELECT id, valor FROM demandas WHERE pagamento = 'pendente'
        AND status IN ('sem_local','aguardando') ORDER BY id DESC LIMIT 30`).all(),
      data_de_hoje: new Date(agora()).toLocaleDateString('pt-BR'),
    };
  }
  async function analisarProntos(prontos, avisos, titulo, pergunta, ator) {
    if (!iaLigada()) throw new Erro(409, 'ia_desligada', 'Ligue a IA e cole a chave em Configurações para analisar arquivos.');
    let r;
    try {
      r = await ia.analisar(cfgBruta(), { arquivos: prontos, contexto: contextoIA(), pergunta: txt(pergunta, 1000) });
    } catch (e) {
      throw new Erro(502, 'ia_falhou', e.message);
    }
    const tipos = new Map(servico.listarServicos().map((x) => [x.id, x.nome]));
    const resultado = {
      ...r, avisos,
      pedidos: r.pedidos.map((p) => ({ ...p, servico_id: tipos.has(p.servico_id) ? p.servico_id : null, servico: tipos.get(p.servico_id) || '' })),
      comprovante: r.comprovante && {
        ...r.comprovante,
        // Pedidos esperando Pix com o mesmo valor do comprovante.
        pedidos_compativeis: r.comprovante.valor == null ? [] : q(`SELECT id FROM demandas WHERE pagamento = 'pendente'
          AND status IN ('sem_local','aguardando') AND ABS(valor - ?) < 0.005 ORDER BY id`).all(r.comprovante.valor).map((d) => d.id),
      },
    };
    const id = Number(q('INSERT INTO analises (criada_em, ator, titulo, pergunta, resultado) VALUES (?,?,?,?,?)')
      .run(agora(), ator, txt(titulo, 200), txt(pergunta, 1000), JSON.stringify(resultado)).lastInsertRowid);
    auditar(ator, 'ia_analise', txt(titulo, 200));
    q('DELETE FROM analises WHERE id <= ?').run(id - ANALISES_GUARDADAS);
    return { id, criada_em: agora(), titulo: txt(titulo, 200), pergunta: txt(pergunta, 1000), ...resultado };
  }
  // Fotos, PDFs e conversas enviados pelo painel.
  async function analisarArquivos({ arquivos, pergunta }, ator) {
    const lista = Array.isArray(arquivos) ? arquivos : [];
    if (!lista.length) throw new Erro(422, 'sem_arquivo', 'Escolha pelo menos um arquivo.');
    if (lista.length > ARQUIVOS_MAX) throw new Erro(422, 'muitos_arquivos', `No máximo ${ARQUIVOS_MAX} arquivos por vez.`);
    const avisos = [];
    const prontos = lista.map((a) => prepararArquivo(a, avisos));
    return analisarProntos(prontos, avisos, prontos.map((p) => p.nome).join(', '), pergunta, ator);
  }
  // Conversa que já está no sistema (importada ou ao vivo).
  async function analisarConversa(conversaId, pergunta, ator) {
    const c = q('SELECT * FROM conversas WHERE id = ?').get(conversaId);
    if (!c) throw new Erro(404, 'nao_encontrado', 'Conversa não encontrada.');
    const mensagens = q('SELECT ts, autor, texto FROM mensagens WHERE conversa_id = ? ORDER BY ts, id').all(conversaId);
    if (!mensagens.length) throw new Erro(422, 'sem_mensagens', 'Essa conversa não tem mensagens.');
    const avisos = [];
    const texto = textoDaConversa(c.nome, mensagens, avisos);
    return analisarProntos([{ nome: `Conversa do WhatsApp com ${c.nome}`, tipo: 'texto', texto }], avisos, `Conversa: ${c.nome}`, pergunta, ator);
  }
  const listarAnalises = () => q('SELECT * FROM analises ORDER BY id DESC LIMIT 30').all()
    .map(({ resultado, ...a }) => ({ ...a, ...JSON.parse(resultado) }));

  // Comprovante que chegou como foto no WhatsApp: a IA lê e manda a leitura ao responsável (quem libera é ele).
  async function lerComprovante(d, midia) {
    const r = await ia.analisar(cfgBruta(), {
      arquivos: [{ nome: 'comprovante enviado pelo cliente', tipo: midia.mime === 'application/pdf' ? 'pdf' : 'imagem', mime: midia.mime, base64: midia.base64 }],
      contexto: contextoIA(), pergunta: `Este é o comprovante do pedido #${d.id}, de ${reais(d.valor)}. Confere?`,
    });
    const cp = r.comprovante;
    if (!cp) {
      avisarAdmin(`🤖 Li o arquivo enviado para o pedido #${d.id} e não parece um comprovante de pagamento. ${r.resumo}`);
      return;
    }
    const linhas = [
      `🤖 Leitura do comprovante do pedido #${d.id}:`,
      `Valor: ${cp.valor != null ? reais(cp.valor) : 'não consegui ler'}${cp.valor != null && Math.abs(cp.valor - d.valor) < 0.005 ? ' (confere)' : ` ⚠️ o pedido é de ${reais(d.valor)}`}`,
      `Recebedor: ${cp.recebedor || 'não consegui ler'}${cp.confere_recebedor ? ' (confere)' : ' ⚠️ não parece ser a empresa'}`,
      cp.data_hora && `Data: ${cp.data_hora}`,
      ...r.alertas.map((x) => `⚠️ ${x}`),
      `Confira no banco e responda *pago ${d.id}* para liberar.`,
    ];
    avisarAdmin(linhas.filter(Boolean).join('\n'));
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
      iaLigada,
      // A IA lê a descrição: escolhe o tipo de serviço e diz se alguém precisa conferir.
      analisar: async (dados) => {
        const km = await distancia(dados.coleta, dados.entrega);
        return conferirIA({ coleta: dados.coleta, entrega: dados.entrega, km, servicoId: dados.servico_id, descricao: dados.descricao });
      },
      // O Mercado Pago exige e-mail do pagador; o Pix na chave da empresa não.
      pedeEmail: (dados) => servico.modoPagamento() === 'mp' && pagaNaHora(msg.telefone) && !dados.email && !EMAIL.test(cliente?.email || ''),
      ultimoEndereco: () => (cliente?.ult_endereco && cliente.ult_lat != null
        ? { endereco: cliente.ult_endereco, lat: cliente.ult_lat, lon: cliente.ult_lon } : null),
      pedidos: () => abertosDe(msg.telefone).map((d) => ({ id: d.id, status: d.status, link: link(d) })),
      criarPedido: async (dados) => {
        const contato = `${nome} ${msg.telefone}`;
        const fixo = clienteFixo(msg.telefone);
        const email = dados.email || cliente?.email || '';
        const km = await distancia(dados.coleta, dados.entrega);
        const previa = servico.cotar(dados.coleta, dados.entrega, { km, servicoId: dados.servico_id, telefone: msg.telefone });
        const revisar = Boolean(dados.ia && !dados.ia.aprovado);
        const pagar = !revisar && pagaNaHora(msg.telefone) && previa.valor != null
          && (servico.modoPagamento() === 'pix' || EMAIL.test(email));
        const d = servico.criarPedido({
          cliente: nome, telefone: msg.telefone, descricao: dados.descricao, requisito: dados.requisito,
          urgente: true, servico_id: dados.servico_id, km, email,
          coleta: { ...dados.coleta, contato }, entrega: dados.entrega,
        }, 'robo', { retida: pagar || revisar, pagamento: fixo ? 'faturado' : '', ia: dados.ia || null });
        lembrarCliente(msg.telefone, nome, dados.coleta, email);
        const r = { id: d.id, status: d.status, link: link(d), valor: d.valor, validade_min: Number(cfgBruta().pagamento_validade_min) };
        if (revisar) {
          avisarAdmin(`🔎 A IA pediu conferência do pedido #${d.id} de ${d.cliente}: ${dados.ia.motivos.join('; ') || 'sem detalhe'}. Aprove ou cancele no painel.`);
          return { ...r, revisar: true };
        }
        if (!pagar) return r;
        try {
          const pix = await gerarPix(d);
          return { ...r, pix: pix.codigo, manual: Boolean(pix.manual) };
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

  // Coexistência: a empresa respondeu pelo app WhatsApp Business. Fica registrado e o robô se cala
  // nessa conversa por algumas horas, para não responder em cima de quem está atendendo.
  function ecoDoApp(msg) {
    if (msg.id && q('SELECT 1 FROM saida WHERE msg_id = ?').get(msg.id)) return; // é do próprio sistema
    const c = conversaDe(msg.telefone, '', msg.destino);
    anotar(c, 'Empresa (app)', msg.texto || '(mensagem enviada pelo app)', 'saida');
    const ate = agora() + Number(cfgBruta().robo_pausa_horas) * 60 * MIN;
    q("UPDATE conversas SET pausa_ate = ?, pendente = 0, etapa = '', dados = '{}' WHERE id = ?").run(ate, c.id);
  }

  async function tratar(msg) {
    if (msg.eco) { ecoDoApp(msg); return; }
    const c = conversaDe(msg.telefone, msg.nome, msg.destino);
    const local = msg.lat != null ? `📍 Localização: ${msg.lat.toFixed(5)}, ${msg.lon.toFixed(5)}` : '';
    anotar(c, msg.nome || msg.telefone, [msg.texto, local, msg.midia && '(enviou foto ou arquivo)'].filter(Boolean).join('\n') || '(mídia sem texto)', 'entrada');

    // Responsável confirmando ou cancelando pelo WhatsApp: "pago 12" / "cancelar 12".
    const comando = msg.telefone === cfgBruta().admin_telefone ? /^\s*(pago|cancelar)\s*#?(\d+)\s*$/i.exec(msg.texto) : null;
    if (comando) {
      const id = Number(comando[2]);
      const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
      let resposta;
      if (!d) resposta = `Não achei o pedido #${id}.`;
      else if (comando[1].toLowerCase() === 'pago') {
        resposta = d.pagamento === 'pendente' && servico.marcarPago(id, 'admin:whatsapp')
          ? `✅ Pagamento do pedido #${id} confirmado. Já foi oferecido aos motoboys.`
          : `O pedido #${id} não está esperando pagamento.`;
      } else if (['entregue', 'cancelada'].includes(d.status)) resposta = `O pedido #${id} já foi finalizado.`;
      else { servico.cancelarDemanda(id, 'admin:whatsapp'); resposta = `Pedido #${id} cancelado.`; }
      anotar(c, 'Robô', resposta, 'saida');
      enfileirar(c.destino, resposta, 'admin');
      return;
    }
    // Motoboy respondendo à convocação: só fica registrado.
    if (q('SELECT id FROM motoboys WHERE telefone = ? AND ativo = 1').get(msg.telefone)) return;
    // Alguém da empresa está atendendo esse contato pelo app: só registra, o robô não fala.
    if (c.pausa_ate && c.pausa_ate > agora()) return;
    // Cliente com Pix pendente que manda foto/arquivo ou diz que pagou: é o comprovante.
    const aPagar = q(`SELECT * FROM demandas WHERE cliente_telefone = ? AND pagamento = 'pendente'
                      AND status IN ('sem_local','aguardando') ORDER BY id DESC`).get(msg.telefone);
    const midia = !msg.texto && msg.lat == null;
    if (aPagar && (midia || DISSE_QUE_PAGOU.test(semAcento(msg.texto)))) {
      let resposta;
      if (aPagar.pag_id) {
        const pago = await verificarPagamento(aPagar, { forcar: true }).catch(() => false);
        resposta = pago ? null : `Ainda não vi o Pix do pedido #${aPagar.id} cair. Assim que cair eu aviso por aqui e libero o motoboy.`;
      } else {
        q('UPDATE demandas SET comprovante_em = ? WHERE id = ?').run(agora(), aPagar.id);
        q('UPDATE conversas SET pendente = 1 WHERE id = ?').run(c.id);
        avisarAdmin(`🧾 ${aPagar.cliente} enviou o comprovante do pedido #${aPagar.id} (${reais(aPagar.valor)}). Confira na sua conta e responda *pago ${aPagar.id}* para liberar o motoboy.`);
        resposta = `Recebi! Estamos conferindo o pagamento do pedido #${aPagar.id} e já liberamos o motoboy. 👍`;
        if (msg.midia && iaLigada()) {
          lerComprovante(aPagar, msg.midia).then(() => despacharSaida()).catch((e) => console.error('[comprovante]', e.message));
        }
      }
      if (resposta) { anotar(c, 'Robô', resposta, 'saida'); enfileirar(c.destino, resposta, 'robo'); }
      return;
    }
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
  // Aviso que chega no webhook: com App Secret da Meta configurado vale a assinatura da Meta;
  // sem ele, vale o segredo do endereço (?s=).
  function webhookAutorizado(segredo, corpoBruto, assinatura) {
    const c = cfgBruta();
    if (c.whats_provedor === 'meta' && c.whats_app_secret) return assinaturaMetaConfere(c.whats_app_secret, corpoBruto, assinatura);
    return segredoConfere(segredo);
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
        mandar(d.cliente_telefone, `📍 Pedido #${d.id} conferido. Valor: *${reais(d.valor)}*. Para liberar o motoboy, pague o Pix (copia e cola na próxima mensagem)${pix.manual ? ' e envie o comprovante por aqui' : ` em até ${c.pagamento_validade_min} min`}.\n\nQR code: ${link(d)}`, 'cliente');
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
    if (c.site_confirmacao === 'pix' && !c.pix_chave) return 'painel';
    return c.site_confirmacao === 'pix' ? 'pagamento' : c.site_confirmacao; // os dois são "paga antes"
  }
  // Paga antes de liberar? (cliente fixo vai para a fatura mensal)
  const pagaNaHora = (telefone) => modoConfirmacao() === 'pagamento' && !clienteFixo(telefone);
  function infoPublica() {
    const c = cfgBruta();
    return {
      empresa: c.empresa_nome, ativo: c.pedidos_site === '1', fechado: servico.foraDoHorario(),
      mapa: { lat: Number(c.mapa_lat), lon: Number(c.mapa_lon) },
      prazo_min: Number(c.urgente_prazo_min), pagamento: modoConfirmacao() === 'pagamento',
      pede_email: servico.modoPagamento() === 'mp', whatsapp: c.empresa_whatsapp,
      acrescimos: { urgente_pct: Number(c.urgente_pct || 0), g_pct: Number(c.tam_g_pct || 0), gg_pct: Number(c.tam_gg_pct || 0), tamanho_ate_km: Number(c.longa_km1 || 0) },
      servicos: servico.listarServicos().filter((x) => x.ativo).map((x) => ({ id: x.id, nome: x.nome, adicional: x.adicional })),
    };
  }
  // ── Link próprio de empresa (/empresa/?k=CHAVE): busca em fornecedores, entrega fixa, fatura do mês ──
  function empresaDaChave(k) {
    const chave = txt(k, 64);
    const cli = chave.length >= 16 ? q('SELECT * FROM clientes WHERE chave = ? AND faturado = 1').get(chave) : null;
    if (!cli) throw new Erro(404, 'link_invalido', 'Link inválido. Peça o link certo à SpeedBoy.');
    return cli;
  }
  const entregaFixa = (cli) => { try { return JSON.parse(cli.entrega_fixa || 'null'); } catch { return null; } };
  function empresaPublica(k) {
    const cli = empresaDaChave(k);
    const fixa = entregaFixa(cli);
    return { nome: cli.nome, entrega: fixa ? { endereco: fixa.endereco } : null, fechamento: cli.fechamento || 'mensal' };
  }
  async function pedidoEmpresa(dados, ip) {
    limitar(`empresa:${ip}`, 60, 60 * MIN);
    const cli = empresaDaChave(dados?.k);
    const horario = servico.foraDoHorario();
    if (horario) throw new Erro(403, 'fechado', `Estamos fechados agora. Atendimento: ${horario}.`);
    const fixa = entregaFixa(cli);
    if (!fixa) throw new Erro(422, 'sem_destino', 'Empresa sem endereço de entrega cadastrado. Fale com a SpeedBoy.');
    const coleta = lerPontoPublico(dados?.coleta);
    if (coleta.endereco.length < 6) throw new Erro(422, 'endereco_invalido', 'Escreva o endereço do fornecedor com rua, número e bairro.');
    const oque = txt(dados?.oque, 300);
    if (oque.length < 2) throw new Erro(422, 'descricao_invalida', 'Diga o que o motoboy vai buscar.');
    await acharNoMapa(coleta);
    const entrega = { endereco: txt(fixa.endereco, 200), lat: fixa.lat ?? null, lon: fixa.lon ?? null, contato: txt(fixa.contato, 120) };
    const km = await distancia(coleta, entrega);
    const autoriza = txt(dados?.autoriza, 80);
    const tamanhoGrande = ['grande', 'maior', 'g', 'gg'].includes(String(dados?.tamanho || ''));
    const descricao = [
      `📦 ${oque}`,
      autoriza && `✅ Pedido por ${autoriza} (${cli.nome}). No balcão, informe o seu nome: a retirada já está autorizada.`,
      '🧾 Material já faturado pelo fornecedor: não paga nada na retirada.',
    ].filter(Boolean).join(' · ');
    const d = servico.criarPedido({
      cliente: cli.nome, telefone: cli.telefone, descricao, requisito: tamanhoGrande ? 'bau' : 'qualquer', tamanho: dados?.tamanho,
      urgente: false, km, email: cli.email, coleta, entrega,
    }, 'empresa', { retida: !cli.libera_direto, pagamento: 'faturado' });
    q('UPDATE clientes SET pedidos = pedidos + 1 WHERE id = ?').run(cli.id);
    avisarAdmin([
      `🏭 ${cli.nome} lançou a busca #${d.id}${cli.libera_direto ? ' (já foi para os motoboys)' : ': aprove no painel'}.`,
      `📦 Coleta: ${d.coleta_endereco || '-'}`, `🏁 Entrega: ${d.entrega_endereco || '-'}`, `📝 ${oque}`,
      d.km != null ? `📏 ${String(d.km).replace('.', ',')} km` : '', d.valor != null ? `💰 ${reais(d.valor)} (fatura)` : '',
      d.status === 'sem_local' ? '⚠️ Não achei o fornecedor no mapa: marque no painel.' : '',
    ].filter(Boolean).join('\n'));
    return { id: d.id, codigo: d.codigo, status: d.status, valor: d.valor, km: d.km };
  }

  function lerPontoPublico(p) {
    const lat = p?.lat == null || p.lat === '' ? null : Number(p.lat);
    const lon = p?.lon == null || p.lon === '' ? null : Number(p.lon);
    const ok = lat != null && lon != null && coordValida(lat, lon);
    return { endereco: txt(p?.endereco, 200), contato: txt(p?.contato, 120), lat: ok ? lat : null, lon: ok ? lon : null };
  }
  // Sugestões de endereço enquanto o cliente digita (Places API New, com a chave do painel).
  async function sugerirPublico(texto, ip) {
    const q = txt(texto, 120);
    if (q.length < 4) return { sugestoes: [] };
    limitar(`sugerir:${ip}`, 120, 15 * MIN);
    const c = cfgBruta();
    if (!c.google_chave) return { sugestoes: [] };
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': c.google_chave },
        body: JSON.stringify({
          input: q, languageCode: 'pt-BR', includedRegionCodes: ['br'],
          locationBias: { circle: { center: { latitude: Number(c.mapa_lat) || -20.3358, longitude: Number(c.mapa_lon) || -40.2969 }, radius: 40000 } },
        }),
        signal: AbortSignal.timeout(6000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('[google autocomplete]', r.status, String(j?.error?.message || '').slice(0, 160)); return { sugestoes: [] }; }
      const sugestoes = (j.suggestions || []).map((s) => s.placePrediction?.text?.text).filter(Boolean).slice(0, 5)
        .map((s) => s.replace(/, Brasil$/, ''));
      return { sugestoes };
    } catch (e) {
      console.error('[google autocomplete]', e.message);
      return { sugestoes: [] };
    }
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
      tamanho: dados?.tamanho,
    });
    return { coleta, entrega, km: cot.km, valor: cot.valor, zona_sul: Boolean(cot.zona_sul), tamanho_extra: cot.tamanho_extra || 0, longa: Boolean(cot.longa) };
  }
  async function pedidoSite(dados, ip) {
    const c = cfgBruta();
    if (c.pedidos_site !== '1') throw new Erro(403, 'desligado', 'Pedidos pelo site estão desligados.');
    if (txt(dados?.site, 50) !== '') throw new Erro(422, 'invalido', 'Não foi possível enviar o pedido.'); // campo-isca de robôs
    const nome = txt(dados?.nome, 80);
    const telefone = normalizarTelefone(dados?.telefone);
    if (nome.length < 2) throw new Erro(422, 'nome_invalido', 'Informe seu nome.');
    // Sem telefone só quando o site avisa que o cliente segue para o WhatsApp da empresa:
    // o número chega pela conversa e é gravado depois (definirContato).
    const semTelefone = !telefone && dados?.contato_whatsapp === true && txt(dados?.telefone, 30) === '';
    if (!telefone && !semTelefone) throw new Erro(422, 'telefone_invalido', 'Informe seu WhatsApp com DDD.');
    const recusa = motivoRecusa(telefone);
    if (recusa) throw new Erro(409, 'recusado', recusa.replace(/\s*😴/, ''));
    limitar(`pedir:${ip}`, 8, 60 * MIN);

    const coleta = lerPontoPublico(dados?.coleta);
    const entrega = lerPontoPublico(dados?.entrega);
    await acharNoMapa(coleta);
    await acharNoMapa(entrega);
    if (!coleta.contato) coleta.contato = `${nome} ${telefone}`.trim();
    const km = await distancia(coleta, entrega);
    const tarifaUrgente = dados?.urgente === true; // só a chave "Entrega urgente" do site cobra a tarifa urgente
    const previa = servico.cotar(coleta, entrega, { km, servicoId: dados?.servico_id, telefone, urgente: tarifaUrgente, tamanho: dados?.tamanho });
    const fixo = telefone ? clienteFixo(telefone) : null;
    const email = txt(dados?.email, 120).toLowerCase();
    // Cliente fixo não paga na hora, mas precisa provar que é ele (qualquer um pode digitar o telefone dele).
    let modo = fixo ? (ligado() ? 'whatsapp' : 'painel') : modoConfirmacao();
    if (modo === 'pagamento') {
      if (servico.modoPagamento() === 'mp' && !EMAIL.test(email)) throw new Erro(422, 'email_invalido', 'Informe um e-mail válido: o comprovante do Pix vai para ele.');
      if (previa.valor == null) modo = 'painel'; // sem ponto no mapa não há preço: a equipe confere e o Pix vai depois
    }
    // A IA confere antes de cobrar: se a descrição é de outro tipo de serviço, o cliente vê o preço certo primeiro.
    const analise = await conferirIA({ coleta, entrega, km: previa.km, servicoId: previa.servico?.id, descricao: dados?.descricao });
    if (analise?.servico_id && analise.servico_id !== (previa.servico?.id ?? null)) {
      const certo = servico.cotar(coleta, entrega, { km, servicoId: analise.servico_id, telefone, urgente: tarifaUrgente, tamanho: dados?.tamanho });
      throw new Erro(409, 'servico_diferente',
        `Pelo que você descreveu, o serviço é "${certo.servico.nome}". Atualizamos o valor: confira e confirme de novo.`,
        { servico_id: analise.servico_id, km: certo.km, valor: certo.valor });
    }
    if (analise && !analise.aprovado) modo = 'painel';
    const d = servico.criarPedido({
      cliente: fixo?.nome || nome, telefone, descricao: dados?.descricao, requisito: dados?.requisito ?? 'qualquer',
      urgente: dados?.urgente !== false, tarifa_urgente: tarifaUrgente, tamanho: dados?.tamanho, servico_id: dados?.servico_id, km, email, coleta, entrega,
    }, 'site', { retida: modo !== 'nenhuma', pagamento: fixo ? 'faturado' : '', ia: analise });
    if (telefone) lembrarCliente(telefone, nome, coleta, email);

    let pix = null;
    if (modo === 'pagamento') {
      try {
        pix = await gerarPix(d);
      } catch (e) {
        modo = 'painel';
        avisarAdmin(`⚠️ Não consegui gerar o Pix do pedido #${d.id} (${e.message}).`);
      }
    }
    if (modo === 'painel') {
      // Dados do pedido junto do aviso: quem recebe (ex.: n8n) pode conferir sem entrar no painel.
      const detalhes = [
        telefone ? `📞 ${telefone}` : '📞 chega pelo WhatsApp (cliente envia a mensagem do pedido)',
        `📦 Coleta: ${d.coleta_endereco || '-'}`,
        `🏁 Entrega: ${d.entrega_endereco || '-'}`,
        d.descricao ? `📝 ${d.descricao}` : '',
        d.km != null ? `📏 ${String(d.km).replace('.', ',')} km` : '',
        `💰 ${d.valor != null ? reais(d.valor) : 'valor a combinar'}`,
      ].filter(Boolean).join('\n');
      avisarAdmin((analise && !analise.aprovado
        ? `🔎 A IA pediu conferência do pedido #${d.id} de ${d.cliente}: ${analise.motivos.join('; ') || 'sem detalhe'}. Aprove ou cancele no painel.`
        : `🆕 Pedido #${d.id} de ${d.cliente} chegou pelo site e espera sua aprovação no painel.`) + `\n${detalhes}`);
    }

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
      ia: { ligada: iaLigada(), erro: ia.ultimoErro() },
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
    q("UPDATE conversas SET humano = ?, pendente = 0, etapa = '', dados = '{}', pausa_ate = NULL WHERE id = ?").run(humano ? 1 : 0, c.id);
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
    avisarDono: (texto) => { try { avisarAdmin(texto); } catch { /* aviso é cortesia */ } },
    definirOrigem, receber, segredoConfere, webhookAutorizado, despacharSaida, rotina,
    infoPublica, sugerirPublico, cotarPublico, pedidoSite, pedidoVivo, empresaPublica, pedidoEmpresa, webhookPagamento, expirarPagamentos,
    resumo, responder, modoConversa, testar, testarIA, analisarArquivos, analisarConversa, listarAnalises,
  };
}
