// Camada HTTP: rotas da API, autenticação, cabeçalhos de segurança e arquivos estáticos.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Erro } from './servico.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = path.join(RAIZ, 'public');
const LEAFLET = path.join(path.dirname(createRequire(import.meta.url).resolve('leaflet/package.json')), 'dist');
const QRCODE = path.dirname(createRequire(import.meta.url).resolve('qrcode-generator'));
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const COOKIE = 'speed_admin';
const TEXTO = Symbol('texto'); // rota que responde texto puro em vez de JSON
const CORPO_MAX = 512 * 1024;
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join('; ');

// Sites que podem chamar as rotas públicas direto do navegador (formulário de pedido no site da empresa).
const ORIGENS_PADRAO = 'https://www.speedboy.com.br,https://speedboy.com.br';

export function criarApp({ servico, atendimento, geocodificar, confiarProxy = false, cookieSeguro = false, origensSite = ORIGENS_PADRAO }) {
  const origens = new Set(String(origensSite || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
  const rotas = [];
  const rota = (metodo, caminho, acesso, fn, max = CORPO_MAX) => {
    const nomes = [];
    const padrao = caminho.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '(\\d+)'; });
    rotas.push({ metodo, re: new RegExp(`^${padrao}$`), nomes, acesso, fn, max });
  };

  const ipDe = (req) => {
    // O último item é o que o proxy da hospedagem acrescentou; os anteriores o cliente pode inventar.
    const encaminhado = confiarProxy ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
    return encaminhado || req.socket.remoteAddress || '';
  };
  const cookieDe = (req) => {
    for (const parte of String(req.headers.cookie || '').split(';')) {
      const [k, ...v] = parte.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  };
  const cookieAdmin = (token, maxAgeS) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${cookieSeguro ? '; Secure' : ''}`;

  async function lerCorpo(req, max = CORPO_MAX) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new Erro(415, 'tipo_invalido', 'Envie JSON.');
    }
    let tamanho = 0;
    const partes = [];
    for await (const parte of req) {
      tamanho += parte.length;
      if (tamanho > max) throw new Erro(413, 'corpo_grande', 'Arquivo ou requisição grande demais.');
      partes.push(parte);
    }
    if (!tamanho) return {};
    // Corpo original guardado: a assinatura da Meta é calculada sobre ele, não sobre o JSON relido.
    req.corpoBruto = Buffer.concat(partes);
    try {
      const corpo = JSON.parse(req.corpoBruto.toString('utf8'));
      if (corpo === null || typeof corpo !== 'object' || Array.isArray(corpo)) throw new Error('formato');
      return corpo;
    } catch {
      throw new Erro(400, 'json_invalido', 'JSON inválido.');
    }
  }

  const origemDe = (req) => {
    const proto = confiarProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    return `${proto || (cookieSeguro ? 'https' : 'http')}://${req.headers.host || ''}`;
  };

  function responder(res, status, corpo, cabecalhos = {}) {
    if (corpo && typeof corpo[TEXTO] === 'string') {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(corpo[TEXTO]);
    }
    const dados = JSON.stringify(corpo);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cabecalhos,
    });
    res.end(dados);
  }

  // -------------------------------------------------------------- público
  rota('GET', '/saude', 'publico', () => ({ ok: true }));
  rota('GET', '/api/termo', 'publico', () => servico.termo());
  rota('POST', '/api/motoboy/login', 'publico', ({ corpo, ip }) => servico.loginMotoboy(corpo, ip));
  rota('POST', '/api/admin/login', 'publico', ({ corpo, ip, res, req }) => {
    const s = servico.loginAdmin(corpo.usuario, corpo.senha, ip);
    atendimento.definirOrigem(origemDe(req));
    res.setHeader('Set-Cookie', cookieAdmin(s.token, Math.floor((s.expiraEm - Date.now()) / 1000)));
    return { usuario: s.usuario };
  });

  // Site de pedidos e página de acompanhamento (sem login).
  rota('GET', '/api/publico/info', 'publico', () => atendimento.infoPublica());
  rota('POST', '/api/publico/cotar', 'publico', ({ corpo, ip }) => atendimento.cotarPublico(corpo, ip));
  rota('POST', '/api/publico/pedidos', 'publico', ({ corpo, ip }) => atendimento.pedidoSite(corpo, ip));
  // Cadastro de motoboy pela página pública: fica pendente até o dono responder no painel.
  rota('POST', '/api/publico/cadastro', 'publico', ({ corpo, ip }) => {
    const r = servico.candidatar(corpo, ip);
    if (r.novo) atendimento.avisarDono(`🛵 Novo cadastro de motoboy: ${r.nome} (${r.tipo === 'diaria' ? 'fixo' : 'avulso'}). Abra o painel, aba Motoboys, para aceitar ou recusar.`);
    return { ok: true };
  });
  rota('GET', '/api/publico/pedido', 'publico', ({ url }) => atendimento.pedidoVivo(url.searchParams.get('c')));
  // Aviso de pagamento do Mercado Pago. O corpo só diz "olhe o pagamento X": o sistema confere direto no banco.
  rota('POST', '/api/pagamento/mp', 'publico', ({ url, corpo }) => {
    if (!atendimento.segredoConfere(url.searchParams.get('s'))) throw new Erro(403, 'segredo_invalido', 'Segredo inválido.');
    atendimento.webhookPagamento(corpo, url).catch((e) => console.error('[pagamento]', e));
    return { ok: true };
  });

  // WhatsApp automático: o provedor oficial (Meta, ou n8n/Make ligado a ele) chama aqui a cada mensagem recebida.
  rota('GET', '/api/whatsapp/webhook', 'publico', ({ url }) => {
    // Verificação exigida pela Meta ao cadastrar o webhook.
    if (!atendimento.segredoConfere(url.searchParams.get('hub.verify_token') ?? url.searchParams.get('s'))) {
      throw new Erro(403, 'segredo_invalido', 'Segredo inválido.');
    }
    return { [TEXTO]: url.searchParams.get('hub.challenge') || 'ok' };
  });
  rota('POST', '/api/whatsapp/webhook', 'publico', ({ url, corpo, req }) => {
    if (!atendimento.webhookAutorizado(url.searchParams.get('s') ?? req.headers['x-speed-segredo'], req.corpoBruto, req.headers['x-hub-signature-256'])) {
      throw new Erro(403, 'segredo_invalido', 'Segredo ou assinatura inválidos.');
    }
    // Responde na hora; a conversa (que pode consultar o mapa) segue em segundo plano.
    atendimento.receber(corpo).catch((e) => console.error('[whatsapp]', e));
    return { ok: true };
  }, 10 * 1024 * 1024);

  // Entrada automática de demandas (app de clientes, Make, robô de WhatsApp).
  rota('POST', '/api/entrada/demandas', 'api', async ({ corpo }) => {
    const d = await servico.criarDemandaExterna(corpo);
    return { id: d.id, status: d.status };
  });

  // Pedido do site aceito pelo cliente (fechado no WhatsApp): grava o valor e libera para o motoboy.
  rota('POST', '/api/entrada/demandas/:id/fechar', 'api', ({ p, corpo }) => servico.fecharPedido(p.id, corpo?.valor, 'api'));

  rota('POST', '/api/entrada/demandas/:id/contato', 'api', ({ p, corpo }) => servico.definirContato(p.id, corpo?.telefone, 'api'));

  // -------------------------------------------------------------- motoboy
  rota('GET', '/api/motoboy/estado', 'motoboy', ({ turno }) => servico.estadoMotoboy(turno));
  rota('POST', '/api/motoboy/posicoes', 'motoboy', ({ turno, corpo }) => servico.registrarPosicoes(turno, corpo));
  rota('POST', '/api/motoboy/parada', 'motoboy', ({ turno, corpo }) => {
    servico.confirmarParada(turno, corpo);
    return servico.estadoMotoboy(servico.autenticarMotoboy(turno.token));
  });
  rota('POST', '/api/motoboy/oferta', 'motoboy', ({ turno, corpo }) => {
    servico.responderOferta(turno, corpo);
    return servico.estadoMotoboy(servico.autenticarMotoboy(turno.token));
  });
  rota('POST', '/api/motoboy/encerrar', 'motoboy', ({ turno }) => {
    servico.encerrarPeloMotoboy(turno);
    return { ok: true };
  });
  rota('POST', '/api/motoboy/almoco', 'motoboy', ({ turno, corpo }) => {
    servico.almoco(turno, corpo.acao);
    return servico.estadoMotoboy(servico.autenticarMotoboy(turno.token));
  });

  // ---------------------------------------------------------------- admin
  const ator = (admin) => `admin:${admin.usuario}`;
  rota('GET', '/api/admin/estado', 'admin', () => ({ ...servico.estadoAdmin(), ...atendimento.resumo() }));
  rota('POST', '/api/admin/demandas/:id/liberar', 'admin', ({ admin, p }) => ({ resultado: servico.liberarDemanda(p.id, ator(admin)) }));
  rota('POST', '/api/admin/whatsapp/:id/responder', 'admin', ({ admin, corpo, p }) => {
    atendimento.responder(p.id, corpo.texto, ator(admin));
    return { ok: true };
  });
  rota('POST', '/api/admin/whatsapp/:id/modo', 'admin', ({ corpo, p }) => {
    atendimento.modoConversa(p.id, Boolean(corpo.humano));
    return { ok: true };
  });
  rota('POST', '/api/admin/whatsapp-teste', 'admin', () => atendimento.testar());
  rota('POST', '/api/admin/ia-teste', 'admin', () => atendimento.testarIA());
  // Fotos, PDFs e conversas para a IA ler (o arquivo não é guardado, só o resultado).
  rota('POST', '/api/admin/analises', 'admin', ({ admin, corpo }) => atendimento.analisarArquivos(corpo, ator(admin)), 48 * 1024 * 1024);
  rota('GET', '/api/admin/analises', 'admin', () => ({ analises: atendimento.listarAnalises() }));
  rota('POST', '/api/admin/whatsapp/:id/analisar', 'admin', ({ admin, corpo, p }) => atendimento.analisarConversa(p.id, corpo.pergunta, ator(admin)));
  // Confirmação manual do pagamento (Pix na chave da empresa, ou Mercado Pago que não avisou).
  rota('POST', '/api/admin/demandas/:id/pago', 'admin', ({ admin, p }) => {
    if (!servico.marcarPago(p.id, ator(admin))) throw new Erro(409, 'ja_pago', 'Esse pedido não está esperando pagamento.');
    return { ok: true };
  });
  rota('GET', '/api/admin/servicos', 'admin', () => ({ servicos: servico.listarServicos() }));
  rota('POST', '/api/admin/servicos', 'admin', ({ admin, corpo }) => {
    servico.salvarServico(corpo, ator(admin));
    return { servicos: servico.listarServicos() };
  });
  rota('GET', '/api/admin/clientes', 'admin', () => ({ clientes: servico.listarClientes() }));
  rota('POST', '/api/admin/clientes', 'admin', ({ admin, corpo }) => {
    servico.salvarCliente(corpo, ator(admin));
    return { clientes: servico.listarClientes() };
  });
  rota('POST', '/api/admin/logout', 'admin', ({ req, res }) => {
    servico.sairAdmin(cookieDe(req));
    res.setHeader('Set-Cookie', cookieAdmin('', 0));
    return { ok: true };
  });
  rota('POST', '/api/admin/senha', 'admin', ({ admin, corpo, res }) => {
    servico.trocarSenhaAdmin(admin.id, corpo.atual, corpo.nova);
    res.setHeader('Set-Cookie', cookieAdmin('', 0));
    return { ok: true };
  });
  rota('POST', '/api/admin/motoboys', 'admin', ({ admin, corpo }) => ({ id: servico.criarMotoboy(corpo, ator(admin)) }));
  rota('PUT', '/api/admin/motoboys/:id', 'admin', ({ admin, corpo, p }) => {
    servico.atualizarMotoboy(p.id, corpo, ator(admin));
    return { ok: true };
  });
  rota('POST', '/api/admin/candidatos/:id/decidir', 'admin', ({ admin, corpo, p }) => servico.decidirCandidato(p.id, corpo.aceitar === true, ator(admin)));
  rota('POST', '/api/admin/motoboys/:id/convocar', 'admin', ({ admin, p }) => servico.convocar(p.id, ator(admin)));
  rota('POST', '/api/admin/motoboys/:id/desconvocar', 'admin', ({ admin, p }) => {
    servico.cancelarConvocacao(p.id, ator(admin));
    return { ok: true };
  });
  rota('POST', '/api/admin/turnos/:id/encerrar', 'admin', ({ admin, p }) => {
    servico.encerrarTurno(p.id, 'encerrado_pelo_admin', ator(admin));
    return { ok: true };
  });
  rota('GET', '/api/admin/turnos/:id/trilha', 'admin', ({ p }) => servico.trilha(p.id));
  rota('POST', '/api/admin/demandas', 'admin', ({ admin, corpo }) => servico.criarDemanda(corpo, ator(admin)));
  rota('PUT', '/api/admin/demandas/:id/locais', 'admin', ({ admin, corpo, p }) => {
    servico.definirLocais(p.id, corpo, ator(admin));
    return { ok: true };
  });
  rota('POST', '/api/admin/demandas/:id/atribuir', 'admin', ({ admin, corpo, p }) => {
    servico.reatribuir(p.id, corpo.motoboy_id ? Number(corpo.motoboy_id) : null, ator(admin));
    return { ok: true };
  });
  rota('POST', '/api/admin/demandas/:id/cancelar', 'admin', ({ admin, p }) => {
    servico.cancelarDemanda(p.id, ator(admin));
    return { ok: true };
  });
  rota('GET', '/api/admin/geocode', 'admin', async ({ url }) => {
    if (!geocodificar) return { resultados: [] };
    try {
      return { resultados: await geocodificar(url.searchParams.get('q') || '', { cidadeBase: servico.cidadeBase() }) };
    } catch {
      throw new Erro(502, 'busca_indisponivel', 'Busca de endereço indisponível. Marque o ponto clicando no mapa.');
    }
  });
  rota('GET', '/api/admin/relatorio', 'admin', ({ url }) => {
    const de = Number(url.searchParams.get('de'));
    const ate = Number(url.searchParams.get('ate'));
    if (!Number.isFinite(de) || !Number.isFinite(ate) || ate <= de) throw new Erro(422, 'periodo_invalido', 'Período inválido.');
    return { linhas: servico.relatorio(de, ate), clientes: servico.relatorioClientes(de, ate), entregas: servico.relatorioEntregas(de, ate) };
  });
  rota('POST', '/api/admin/whatsapp', 'admin', ({ admin, corpo }) => servico.importarWhatsapp(corpo, ator(admin)), 30 * 1024 * 1024);
  rota('GET', '/api/admin/whatsapp', 'admin', () => ({ conversas: servico.listarConversas() }));
  rota('GET', '/api/admin/whatsapp/:id', 'admin', ({ p, url }) => ({ mensagens: servico.mensagensDaConversa(p.id, url.searchParams.get('q') || '') }));
  rota('DELETE', '/api/admin/whatsapp/:id', 'admin', ({ admin, p }) => {
    servico.excluirConversa(p.id, ator(admin));
    return { ok: true };
  });
  rota('GET', '/api/admin/config', 'admin', () => servico.lerConfig());
  rota('PUT', '/api/admin/config', 'admin', ({ admin, corpo }) => servico.salvarConfig(corpo, ator(admin)));
  rota('POST', '/api/admin/chave-api', 'admin', ({ admin }) => ({ chave: servico.gerarChaveApi(ator(admin)) }));

  // ------------------------------------------------------------ estáticos
  function servirArquivo(res, base, relativo, metodo) {
    const alvo = path.resolve(base, `.${path.posix.normalize(`/${relativo}`)}`);
    if (alvo !== base && !alvo.startsWith(base + path.sep)) return false;
    let arquivo = alvo;
    try {
      if (fs.statSync(arquivo).isDirectory()) arquivo = path.join(arquivo, 'index.html');
      const dados = fs.readFileSync(arquivo);
      res.writeHead(200, {
        'Content-Type': TIPOS[path.extname(arquivo)] || 'application/octet-stream',
        'Cache-Control': base === LEAFLET || base === QRCODE ? 'public, max-age=86400' : 'no-cache',
      });
      res.end(metodo === 'HEAD' ? undefined : dados);
      return true;
    } catch {
      return false;
    }
  }

  async function tratar(req, res) {
    const url = new URL(req.url, 'http://local');
    const caminho = decodeURIComponent(url.pathname);
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    if (cookieSeguro) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    // CORS só para as rotas públicas e só para os sites cadastrados. Painel, motoboy e API seguem fechados.
    const origem = String(req.headers.origin || '');
    if (caminho.startsWith('/api/publico/') && origens.has(origem)) {
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    if (caminho.startsWith('/api/') || caminho === '/saude') {
      const metodoOk = rotas.filter((r) => r.re.test(caminho));
      const r = metodoOk.find((x) => x.metodo === req.method);
      if (!r) throw new Erro(metodoOk.length ? 405 : 404, 'nao_encontrado', 'Rota não encontrada.');
      const ctx = { req, res, url, ip: ipDe(req), p: {}, corpo: {} };
      r.re.exec(caminho).slice(1).forEach((v, i) => { ctx.p[r.nomes[i]] = Number(v); });

      if (r.acesso === 'admin') {
        ctx.admin = servico.autenticarAdmin(cookieDe(req));
        if (!ctx.admin) throw new Erro(401, 'nao_autenticado', 'Faça login.');
        // Cookie é SameSite=Strict; o cabeçalho próprio fecha a porta para formulários de outros sites.
        if (req.method !== 'GET' && req.headers['x-speed'] !== '1') throw new Erro(403, 'origem_invalida', 'Requisição recusada.');
      } else if (r.acesso === 'motoboy') {
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        ctx.turno = { ...servico.autenticarMotoboy(token), token };
      } else if (r.acesso === 'api') {
        if (!servico.chaveApiValida(req.headers['x-api-key'])) throw new Erro(401, 'chave_invalida', 'Chave de API inválida.');
      }
      if (req.method !== 'GET') ctx.corpo = await lerCorpo(req, r.max);
      return responder(res, 200, await r.fn(ctx));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new Erro(405, 'metodo', 'Método não permitido.');
    if (caminho === '/') { res.writeHead(302, { Location: '/painel/' }); return res.end(); }
    if (['/painel', '/app', '/pedir', '/acompanhar', '/cadastro'].includes(caminho)) { res.writeHead(302, { Location: `${caminho}/${url.search}` }); return res.end(); }
    if (caminho.startsWith('/vendor/leaflet/')) {
      if (servirArquivo(res, LEAFLET, caminho.slice('/vendor/leaflet/'.length), req.method)) return undefined;
    } else if (caminho === '/vendor/qrcode/qrcode.mjs') {
      if (servirArquivo(res, QRCODE, 'qrcode.mjs', req.method)) return undefined;
    } else if (servirArquivo(res, PUBLICO, caminho, req.method)) {
      return undefined;
    }
    throw new Erro(404, 'nao_encontrado', 'Página não encontrada.');
  }

  return http.createServer((req, res) => {
    tratar(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      if (e instanceof Erro) return responder(res, e.status, { erro: e.codigo, mensagem: e.message, ...e.extra });
      if (e instanceof URIError) return responder(res, 400, { erro: 'url_invalida', mensagem: 'Endereço inválido.' });
      console.error('[erro]', e);
      return responder(res, 500, { erro: 'interno', mensagem: 'Erro interno. Tente de novo.' });
    });
  });
}
