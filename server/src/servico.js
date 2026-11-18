// Regras de negócio: motoboys, convocação, turno, posições, alertas, demandas e despacho.
import {
  hashSenha, verificarSenha, novoToken, hashToken, HASH_FALSO,
} from './auth.js';
import crypto from 'node:crypto';
import { distM, distRuaKm, coordValida } from './geo.js';
import { PROVEDORES, normalizarTelefone } from './mensageiro.js';
import { TIPOS_CHAVE, normalizarChave } from './pix.js';
import { MODELOS_IA } from './ia.js';
import { atende, escolherMotoboy, melhorInsercao, REQUISITOS } from './despacho.js';
import { lerConversa, textoDoZip, nomeDaConversa } from './whatsapp.js';

export class Erro extends Error {
  constructor(status, codigo, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

const MIN = 60_000;
const LIMITE_FALHAS = 5;
const JANELA_FALHAS = 15 * MIN;
const SESSAO_ADMIN = 12 * 60 * MIN;
const RAIO_PARADO_M = 60;
const PRECISAO_MAX_M = 100;
const FOLGA_FIM_TURNO = 20 * MIN;

const CFG_NUM = {
  horas_turno: [1, 16], prorrogacao_max_min: [0, 240], parado_min: [2, 120],
  espera_parada_min: [2, 240], sem_sinal_min: [1, 60], cerca_m: [30, 2000],
  bike_max_km: [0.5, 50], capacidade: [1, 20], retencao_dias: [7, 730],
  diaria_valor: [0, 100000], almoco_valor: [0, 100000], almoco_min: [10, 180],
  mapa_lat: [-90, 90], mapa_lon: [-180, 180],
  preco_base: [0, 100000], preco_km_incluso: [0, 1000], preco_km: [0, 1000], preco_minimo: [0, 100000],
  convocacao_auto_max: [0, 50], convocacao_auto_espera_min: [0, 120],
  urgente_prazo_min: [5, 600], robo_pausa_horas: [1, 168], repasse_pct: [0, 100], repasse_minimo: [0, 10000], repasse_base: [0, 10000], repasse_km: [0, 1000], oferta_raio_km: [0.5, 100],
  oferta_alerta_min: [1, 120], avulso_max_horas: [1, 24], pagamento_validade_min: [5, 1440],
};
const CFG_TXT = {
  cidade_base: 120, termo_texto: 8000, empresa_nome: 60, url_publica: 200, whats_url: 300, whats_instancia: 120,
  pix_nome: 25, pix_cidade: 15, cidades_atendidas: 200,
};
const SIM_NAO = ['0', '1'];
const CFG_OPC = {
  pedidos_site: SIM_NAO, rastreio_cliente: SIM_NAO, robo_ativo: SIM_NAO, avisos_cliente: SIM_NAO,
  convocacao_auto: SIM_NAO, convocacao_obrigatoria: SIM_NAO, site_confirmacao: ['painel', 'whatsapp', 'pagamento', 'pix', 'nenhuma'], whats_provedor: PROVEDORES,
  ia_ativa: SIM_NAO, ia_modelo: MODELOS_IA, pix_tipo: TIPOS_CHAVE,
};
const CFG_HORA = ['atendimento_inicio', 'atendimento_fim'];
const CFG_SECRETAS = ['api_chave_hash', 'whats_token', 'whats_app_secret', 'mp_token', 'ors_chave', 'ia_chave', 'google_chave'];
const SEM_SINAL_AVULSO = 30 * MIN;
const VOLTA_OFERTA = 90_000; // a cada volta sem aceite o raio da oferta dobra (até 8x)

const txt = (v, max) => String(v ?? '').trim().slice(0, max);
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

export function criarServico({ db, agora = () => Date.now(), geocodificar = null }) {
  const preparados = new Map();
  const q = (sql) => {
    let s = preparados.get(sql);
    if (!s) { s = db.prepare(sql); preparados.set(sql, s); }
    return s;
  };

  let nivelTx = 0;
  function tx(fn) {
    if (nivelTx > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    nivelTx++;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      nivelTx--;
    }
  }

  // Quem quiser reagir (avisos de WhatsApp, etc.) se inscreve aqui. Roda dentro da mesma transação.
  const ouvintes = [];
  const aoEvento = (fn) => ouvintes.push(fn);
  const emitir = (evento, dados) => { for (const fn of ouvintes) fn(evento, dados); };

  const auditar = (ator, acao, detalhe = '') =>
    q('INSERT INTO auditoria (ts, ator, acao, detalhe) VALUES (?,?,?,?)')
      .run(agora(), ator, acao, String(detalhe).slice(0, 500));

  // ---------------------------------------------------------------- config
  let cacheCfg = null;
  function cfgBruta() {
    if (!cacheCfg) {
      cacheCfg = {};
      for (const r of q('SELECT chave, valor FROM config').all()) cacheCfg[r.chave] = r.valor;
    }
    return cacheCfg;
  }
  function cfg() {
    const c = cfgBruta();
    return {
      turnoMs: Number(c.horas_turno) * 60 * MIN,
      prorrogacaoMs: Number(c.prorrogacao_max_min) * MIN,
      paradoMs: Number(c.parado_min) * MIN,
      esperaParadaMs: Number(c.espera_parada_min) * MIN,
      semSinalMs: Number(c.sem_sinal_min) * MIN,
      cercaM: Number(c.cerca_m),
      bikeMaxKm: Number(c.bike_max_km),
      capacidade: Number(c.capacidade),
      retencaoMs: Number(c.retencao_dias) * 24 * 60 * MIN,
      almocoMs: Number(c.almoco_min) * MIN,
    };
  }
  function lerConfig() {
    if (!cfgBruta().whats_segredo) {
      q('UPDATE config SET valor = ? WHERE chave = ?').run(crypto.randomBytes(18).toString('base64url'), 'whats_segredo');
      cacheCfg = null;
    }
    const { api_chave_hash, whats_token, whats_app_secret, mp_token, ors_chave, ia_chave, google_chave, ...resto } = cfgBruta();
    return {
      ...resto, api_chave_definida: api_chave_hash !== '', whats_token_definido: whats_token !== '',
      whats_app_secret_definido: whats_app_secret !== '',
      mp_token_definido: mp_token !== '', ors_chave_definida: ors_chave !== '', ia_chave_definida: ia_chave !== '',
      google_chave_definida: (google_chave ?? '') !== '',
    };
  }
  // Fora do horário de atendimento? (vazio = atende sempre). Devolve o texto do horário ou ''.
  function foraDoHorario() {
    const { atendimento_inicio: ini, atendimento_fim: fim } = cfgBruta();
    if (!ini || !fim || ini === fim) return '';
    const d = new Date(agora());
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const dentro = ini < fim ? hm >= ini && hm < fim : hm >= ini || hm < fim;
    return dentro ? '' : `${ini} às ${fim}`;
  }
  // Como o cliente paga antes de o pedido sair: 'mp' (Pix automático do Mercado Pago),
  // 'pix' (Pix na chave da empresa, confirmado pelo comprovante) ou '' (não cobra na hora).
  function modoPagamento() {
    const c = cfgBruta();
    if (c.site_confirmacao === 'pagamento' && c.mp_token !== '') return 'mp';
    if (c.site_confirmacao === 'pix' && c.pix_chave !== '') return 'pix';
    return '';
  }
  // Pedido de cliente que ainda não foi cobrado e já tem valor (o Mercado Pago exige e-mail).
  function precisaCobrar(d, valor = d.valor) {
    const modo = modoPagamento();
    return modo !== '' && ['site', 'robo'].includes(d.origem) && d.pagamento === '' && valor != null
      && (modo === 'pix' || d.email !== '');
  }

  // Preço: (base + km a mais, com mínimo) + adicional do tipo de serviço. Cliente fixo pode ter percentual próprio.
  // Devolve também o repasse do motoboy avulso (percentual do valor, com mínimo).
  function cotar(coleta, entrega, { km: kmRota = null, servicoId = null, telefone = '' } = {}) {
    const servico = servicoId ? q('SELECT * FROM servicos WHERE id = ? AND ativo = 1').get(Number(servicoId)) || null : null;
    const nada = { km: null, valor: null, repasse: null, servico };
    if (coleta?.lat == null || entrega?.lat == null) return nada;
    const c = cfgBruta();
    const km = Math.round((kmRota ?? distRuaKm(coleta, entrega)) * 10) / 10;
    const base = Number(c.preco_base);
    const porKm = Number(c.preco_km);
    const minimo = Number(c.preco_minimo);
    const adicional = servico?.adicional || 0;
    if (!base && !porKm && !minimo && !adicional) return { ...nada, km };
    let valor = Math.max(minimo, base + Math.max(0, km - Number(c.preco_km_incluso)) * porKm) + adicional;
    const fixo = telefone ? q('SELECT preco_pct FROM clientes WHERE telefone = ? AND faturado = 1').get(telefone) : null;
    if (fixo) valor *= fixo.preco_pct / 100;
    valor = Math.round(valor * 100) / 100;
    const pct = servico?.repasse_pct ?? Number(c.repasse_pct);
    // Tabela própria do motoboy (valor base até os km incluídos + valor por km a mais), se o dono preencheu;
    // sem ela vale o percentual do valor cobrado. O adicional do serviço segue repassado pelo percentual.
    const repBase = Number(c.repasse_base);
    const bruto = repBase > 0
      ? repBase + Math.max(0, km - Number(c.preco_km_incluso)) * Number(c.repasse_km) + (adicional * pct) / 100
      : (valor * pct) / 100;
    const repasse = Math.round(Math.max(Number(c.repasse_minimo), bruto) * 100) / 100;
    return { km, valor, repasse, servico };
  }

  // ------------------------------------------- tipos de serviço e clientes fixos
  const listarServicos = () => q('SELECT * FROM servicos ORDER BY ativo DESC, ordem, id').all();
  function salvarServico(d, ator) {
    const nome = txt(d?.nome, 60);
    const adicional = Number(d?.adicional ?? 0);
    const pct = d?.repasse_pct == null || d.repasse_pct === '' ? null : Number(d.repasse_pct);
    if (nome.length < 2) throw new Erro(422, 'servico_invalido', 'Dê um nome ao tipo de serviço.');
    if (!Number.isFinite(adicional) || adicional < 0 || adicional > 100000) throw new Erro(422, 'servico_invalido', 'Valor adicional inválido.');
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) throw new Erro(422, 'servico_invalido', 'Repasse entre 0 e 100%.');
    const ativo = d?.ativo === false || d?.ativo === 0 ? 0 : 1;
    if (d?.id) {
      const r = q('UPDATE servicos SET nome = ?, adicional = ?, repasse_pct = ?, ativo = ? WHERE id = ?').run(nome, adicional, pct, ativo, Number(d.id));
      if (!r.changes) throw new Erro(404, 'nao_encontrado', 'Tipo de serviço não encontrado.');
    } else {
      const ordem = q('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM servicos').get().n;
      q('INSERT INTO servicos (nome, adicional, repasse_pct, ativo, ordem) VALUES (?,?,?,?,?)').run(nome, adicional, pct, ativo, ordem);
    }
    auditar(ator, 'servico_salvo', nome);
  }
  const listarClientes = () => q('SELECT * FROM clientes ORDER BY faturado DESC, nome LIMIT 500').all();
  function salvarCliente(d, ator) {
    const telefone = normalizarTelefone(d?.telefone);
    const nome = txt(d?.nome, 120);
    const pct = Number(d?.preco_pct ?? 100);
    if (!telefone) throw new Erro(422, 'telefone_invalido', 'WhatsApp do cliente: DDD + número.');
    if (nome.length < 2) throw new Erro(422, 'nome_invalido', 'Informe o nome do cliente.');
    if (!Number.isFinite(pct) || pct < 1 || pct > 300) throw new Erro(422, 'preco_invalido', 'Percentual do preço entre 1 e 300.');
    q(`INSERT INTO clientes (telefone, nome, criado_em, faturado, preco_pct, email) VALUES (?,?,?,?,?,?)
       ON CONFLICT(telefone) DO UPDATE SET nome = excluded.nome, faturado = excluded.faturado,
         preco_pct = excluded.preco_pct, email = excluded.email`)
      .run(telefone, nome, agora(), d?.faturado ? 1 : 0, pct, txt(d?.email, 120));
    auditar(ator, 'cliente_salvo', nome);
  }
  function salvarConfig(dados, ator) {
    const gravar = q('UPDATE config SET valor = ? WHERE chave = ?');
    tx(() => {
      for (const [chave, bruto] of Object.entries(dados || {})) {
        if (chave in CFG_NUM) {
          const n = Number(bruto);
          const [min, max] = CFG_NUM[chave];
          if (!Number.isFinite(n) || n < min || n > max) {
            throw new Erro(422, 'config_invalida', `Valor inválido para ${chave} (entre ${min} e ${max}).`);
          }
          gravar.run(String(n), chave);
        } else if (chave in CFG_OPC) {
          if (!CFG_OPC[chave].includes(String(bruto))) throw new Erro(422, 'config_invalida', `Valor inválido para ${chave}.`);
          gravar.run(String(bruto), chave);
        } else if (CFG_HORA.includes(chave)) {
          const hm = txt(bruto, 5);
          if (hm !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hm)) throw new Erro(422, 'config_invalida', 'Horário no formato 08:00.');
          gravar.run(hm, chave);
        } else if (chave === 'pix_chave') {
          // Conferida contra o tipo escolhido (o do mesmo envio, se veio junto).
          const tipo = String(dados.pix_tipo ?? cfgBruta().pix_tipo);
          const pix = normalizarChave(tipo, bruto);
          if (txt(bruto, 80) !== '' && !pix) throw new Erro(422, 'config_invalida', 'Chave Pix não confere com o tipo escolhido.');
          gravar.run(pix, chave);
        } else if (chave === 'empresa_whatsapp') {
          const tel = normalizarTelefone(bruto);
          if (soDigitos(bruto) !== '' && !tel) throw new Erro(422, 'config_invalida', 'WhatsApp da empresa: DDD + número.');
          gravar.run(tel, chave);
        } else if (['whats_token', 'whats_app_secret', 'mp_token', 'ors_chave', 'ia_chave', 'google_chave'].includes(chave)) {
          if (txt(bruto, 600) !== '') gravar.run(txt(bruto, 600), chave); // vazio = mantém o atual
        } else if (chave === 'admin_telefone') {
          const tel = normalizarTelefone(bruto);
          if (soDigitos(bruto) !== '' && !tel) throw new Erro(422, 'config_invalida', 'Telefone do responsável: DDD + número.');
          gravar.run(tel, chave);
        } else if (chave in CFG_TXT) {
          const valor = txt(bruto, CFG_TXT[chave]);
          if (chave === 'termo_texto') {
            if (valor.length < 50) throw new Erro(422, 'config_invalida', 'O termo está curto demais.');
            if (valor !== cfgBruta().termo_texto) {
              gravar.run(String(Number(cfgBruta().termo_versao) + 1), 'termo_versao');
            }
          }
          gravar.run(valor, chave);
        }
      }
      cacheCfg = null;
      auditar(ator, 'config', Object.keys(dados || {}).filter((k) => !CFG_SECRETAS.includes(k)).join(','));
    });
    return lerConfig();
  }
  function gerarChaveApi(ator) {
    const chave = novoToken();
    q('UPDATE config SET valor = ? WHERE chave = ?').run(hashToken(chave), 'api_chave_hash');
    cacheCfg = null;
    auditar(ator, 'chave_api_gerada');
    return chave;
  }
  function chaveApiValida(chave) {
    const guardado = cfgBruta().api_chave_hash;
    return guardado !== '' && typeof chave === 'string' && chave.length > 20 && hashToken(chave) === guardado;
  }

  // ------------------------------------------------- limite de tentativas
  const falhas = new Map();
  function recentes(chave) {
    const lista = (falhas.get(chave) || []).filter((t) => t > agora() - JANELA_FALHAS);
    if (lista.length) falhas.set(chave, lista); else falhas.delete(chave);
    return lista;
  }
  function exigirNaoBloqueado(chave, limite = LIMITE_FALHAS) {
    if (recentes(chave).length >= limite) {
      throw new Erro(429, 'bloqueado', 'Muitas tentativas erradas. Aguarde 15 minutos.');
    }
  }
  const registrarFalha = (chave) => falhas.set(chave, [...recentes(chave), agora()]);

  // ------------------------------------------------------------- admin
  function garantirAdmin(usuario, senha) {
    if (q('SELECT COUNT(*) AS n FROM admins').get().n > 0) return false;
    q('INSERT INTO admins (usuario, senha_hash, criado_em) VALUES (?,?,?)')
      .run(usuario, hashSenha(senha), agora());
    return true;
  }
  function loginAdmin(usuario, senha, ip) {
    const u = txt(usuario, 60).toLowerCase();
    exigirNaoBloqueado(`ip:${ip}`, 20);
    exigirNaoBloqueado(`adm:${u}`);
    const admin = q('SELECT * FROM admins WHERE usuario = ?').get(u);
    const ok = verificarSenha(senha, admin ? admin.senha_hash : HASH_FALSO);
    if (!admin || !ok) {
      registrarFalha(`ip:${ip}`);
      registrarFalha(`adm:${u}`);
      throw new Erro(401, 'login_invalido', 'Usuário ou senha incorretos.');
    }
    const token = novoToken();
    q('INSERT INTO sessoes (token_hash, tipo, ref_id, criada_em, expira_em) VALUES (?,?,?,?,?)')
      .run(hashToken(token), 'admin', admin.id, agora(), agora() + SESSAO_ADMIN);
    auditar(`admin:${admin.usuario}`, 'login', ip);
    return { token, expiraEm: agora() + SESSAO_ADMIN, usuario: admin.usuario };
  }
  function autenticarAdmin(token) {
    if (!token) return null;
    const s = q("SELECT * FROM sessoes WHERE token_hash = ? AND tipo = 'admin'").get(hashToken(token));
    if (!s || s.expira_em <= agora()) return null;
    return q('SELECT id, usuario FROM admins WHERE id = ?').get(s.ref_id) || null;
  }
  function sairAdmin(token) {
    if (token) q('DELETE FROM sessoes WHERE token_hash = ?').run(hashToken(token));
  }
  function trocarSenhaAdmin(adminId, atual, nova) {
    const admin = q('SELECT * FROM admins WHERE id = ?').get(adminId);
    if (!admin || !verificarSenha(atual, admin.senha_hash)) {
      throw new Erro(403, 'senha_incorreta', 'Senha atual incorreta.');
    }
    if (String(nova || '').length < 10) {
      throw new Erro(422, 'senha_fraca', 'A nova senha precisa de pelo menos 10 caracteres.');
    }
    tx(() => {
      q('UPDATE admins SET senha_hash = ? WHERE id = ?').run(hashSenha(nova), adminId);
      q("DELETE FROM sessoes WHERE tipo = 'admin' AND ref_id = ?").run(adminId);
      auditar(`admin:${admin.usuario}`, 'troca_senha');
    });
  }

  // ----------------------------------------------------------- motoboys
  function validarMotoboy(d, novo) {
    const m = {};
    if (novo || d.nome !== undefined) {
      m.nome = txt(d.nome, 80);
      if (m.nome.length < 2) throw new Erro(422, 'nome_invalido', 'Informe o nome do motoboy.');
    }
    if (novo || d.telefone !== undefined) {
      m.telefone = soDigitos(d.telefone);
      if (m.telefone.length < 10 || m.telefone.length > 11) {
        throw new Erro(422, 'telefone_invalido', 'Telefone com DDD: 10 ou 11 números.');
      }
    }
    if (novo || (d.pin !== undefined && d.pin !== '')) {
      if (!/^\d{6}$/.test(String(d.pin ?? ''))) {
        throw new Erro(422, 'pin_invalido', 'A senha do motoboy deve ter 6 números.');
      }
      m.pin_hash = hashSenha(d.pin);
      // O dono pediu para conseguir consultar a senha do motoboy (ele esquece e pede de novo).
      m.pin_claro = String(d.pin);
    }
    if (novo || d.veiculo !== undefined) {
      if (!['moto', 'bike'].includes(d.veiculo)) throw new Erro(422, 'veiculo_invalido', 'Veículo: moto ou bike.');
      m.veiculo = d.veiculo;
    }
    if (novo || d.tipo !== undefined) {
      m.tipo = d.tipo ?? 'diaria';
      if (!['diaria', 'avulso'].includes(m.tipo)) throw new Erro(422, 'tipo_invalido', 'Tipo: diária ou avulso.');
    }
    if (novo || d.tem_bau !== undefined) m.tem_bau = d.tem_bau ? 1 : 0;
    if (novo || d.tem_bag !== undefined) m.tem_bag = d.tem_bag ? 1 : 0;
    if (d.ativo !== undefined) m.ativo = d.ativo ? 1 : 0;
    return m;
  }
  function telefoneLivre(telefone, excetoId = 0) {
    const outro = q('SELECT id FROM motoboys WHERE telefone = ? AND id <> ?').get(telefone, excetoId);
    if (outro) throw new Erro(409, 'telefone_em_uso', 'Já existe motoboy com esse telefone.');
  }
  function criarMotoboy(dados, ator) {
    const m = validarMotoboy(dados || {}, true);
    telefoneLivre(m.telefone);
    const r = q(`INSERT INTO motoboys (nome, telefone, pin_hash, veiculo, tem_bau, tem_bag, ativo, criado_em, tipo)
                 VALUES (?,?,?,?,?,?,1,?,?)`)
      .run(m.nome, m.telefone, m.pin_hash, m.veiculo, m.tem_bau, m.tem_bag, agora(), m.tipo);
    auditar(ator, 'motoboy_criado', m.nome);
    q('UPDATE motoboys SET pin_claro = ? WHERE id = ?').run(m.pin_claro ?? null, Number(r.lastInsertRowid));
    return Number(r.lastInsertRowid);
  }

  // ------------------------------------------- cadastro público de motoboy
  // O motoboy preenche a página /cadastro/; fica pendente até o dono aceitar ou recusar no painel.
  function candidatar(d, ip) {
    exigirNaoBloqueado(`cad:${ip}`, 6);
    registrarFalha(`cad:${ip}`);
    const nome = txt(d?.nome, 80);
    if (nome.length < 5 || !nome.includes(' ')) throw new Erro(422, 'nome_invalido', 'Informe nome e sobrenome.');
    const telefone = soDigitos(d?.telefone);
    if (telefone.length < 10 || telefone.length > 11) throw new Erro(422, 'telefone_invalido', 'WhatsApp com DDD: 10 ou 11 números.');
    const documento = txt(d?.documento, 20);
    if (soDigitos(documento).length < 5) throw new Erro(422, 'documento_invalido', 'Informe o CPF ou o RG.');
    const veiculo = d?.veiculo === 'bike' ? 'bike' : 'moto';
    const placa = txt(d?.placa, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (veiculo === 'moto' && placa.length < 7) throw new Erro(422, 'placa_invalida', 'Informe a placa da moto (7 letras e números).');
    const tipo = d?.tipo === 'diaria' ? 'diaria' : 'avulso';
    const indicacao = txt(d?.indicacao, 160);
    if (q('SELECT id FROM motoboys WHERE telefone = ?').get(telefone)) {
      throw new Erro(409, 'ja_cadastrado', 'Esse WhatsApp já tem cadastro na SpeedBoy. Fale com a gente se esqueceu a senha.');
    }
    const campos = [nome, documento, placa, veiculo, d?.tem_bau ? 1 : 0, d?.tem_bag ? 1 : 0, tipo, indicacao];
    const pendente = q("SELECT id FROM candidatos WHERE telefone = ? AND status = 'pendente'").get(telefone);
    if (pendente) {
      q('UPDATE candidatos SET nome=?, documento=?, placa=?, veiculo=?, tem_bau=?, tem_bag=?, tipo=?, indicacao=? WHERE id=?').run(...campos, pendente.id);
      return { ok: true, id: pendente.id, novo: false, nome, tipo };
    }
    const r = q(`INSERT INTO candidatos (nome, documento, placa, veiculo, tem_bau, tem_bag, tipo, indicacao, telefone, status, criado_em)
                 VALUES (?,?,?,?,?,?,?,?,?,'pendente',?)`).run(...campos, telefone, agora());
    auditar('publico', 'cadastro_recebido', nome);
    return { ok: true, id: Number(r.lastInsertRowid), novo: true, nome, tipo };
  }
  // Senha fácil de ditar (três pares, ex.: 447712), sorteada. O bloqueio de tentativas protege contra chute.
  const pinFacil = () => Array.from({ length: 3 }, () => String(crypto.randomInt(0, 10)).repeat(2)).join('');
  function decidirCandidato(id, aceitar, ator) {
    const c = q('SELECT * FROM candidatos WHERE id = ?').get(Number(id));
    if (!c) throw new Erro(404, 'nao_encontrado', 'Cadastro não encontrado.');
    if (c.status !== 'pendente') throw new Erro(409, 'ja_decidido', 'Esse cadastro já foi respondido.');
    if (!aceitar) {
      q("UPDATE candidatos SET status = 'recusado', decidido_em = ? WHERE id = ?").run(agora(), c.id);
      auditar(ator, 'cadastro_recusado', c.nome);
      return { ok: true, aceito: false };
    }
    const pin = pinFacil();
    return tx(() => {
      const motoboyId = criarMotoboy({ nome: c.nome, telefone: c.telefone, pin, veiculo: c.veiculo, tipo: c.tipo, tem_bau: c.tem_bau, tem_bag: c.tem_bag }, ator);
      q('UPDATE motoboys SET documento = ?, placa = ? WHERE id = ?').run(c.documento, c.placa, motoboyId);
      q("UPDATE candidatos SET status = 'aceito', decidido_em = ?, motoboy_id = ? WHERE id = ?").run(agora(), motoboyId, c.id);
      auditar(ator, 'cadastro_aceito', c.nome);
      return { ok: true, aceito: true, motoboy_id: motoboyId, nome: c.nome, telefone: c.telefone, tipo: c.tipo, pin };
    });
  }
  function atualizarMotoboy(id, dados, ator) {
    const atual = q('SELECT * FROM motoboys WHERE id = ?').get(id);
    if (!atual) throw new Erro(404, 'nao_encontrado', 'Motoboy não encontrado.');
    const m = validarMotoboy(dados || {}, false);
    if (m.telefone) telefoneLivre(m.telefone, id);
    const campos = Object.keys(m);
    if (!campos.length) return;
    tx(() => {
      q(`UPDATE motoboys SET ${campos.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...campos.map((c) => m[c]), id);
      auditar(ator, 'motoboy_alterado', `${atual.nome}: ${campos.join(',')}`);
      // Desativado ou com senha trocada: derruba o turno em andamento.
      if (m.ativo === 0 || m.pin_hash) {
        const turno = turnoAtivoDoMotoboy(id);
        if (turno && m.ativo === 0) encerrarTurno(turno.id, 'motoboy_desativado');
        else if (turno) q("DELETE FROM sessoes WHERE tipo = 'motoboy' AND ref_id = ?").run(turno.id);
      }
    });
  }

  // --------------------------------------------------------- convocação
  const turnoAtivoDoMotoboy = (motoboyId) =>
    q('SELECT * FROM turnos WHERE motoboy_id = ? AND fim_real IS NULL').get(motoboyId);
  const convocacaoValida = (motoboyId) =>
    q(`SELECT * FROM convocacoes WHERE motoboy_id = ? AND usada_em IS NULL
       AND cancelada_em IS NULL AND valida_ate > ? ORDER BY id DESC LIMIT 1`).get(motoboyId, agora());

  function convocar(motoboyId, ator, origem = 'admin') {
    const m = q('SELECT * FROM motoboys WHERE id = ?').get(motoboyId);
    if (!m || !m.ativo) throw new Erro(404, 'nao_encontrado', 'Motoboy não encontrado ou inativo.');
    if (m.tipo === 'avulso') throw new Erro(409, 'avulso', 'Motoboy avulso entra quando quiser: não precisa de convocação.');
    if (turnoAtivoDoMotoboy(motoboyId)) throw new Erro(409, 'ja_em_turno', 'Esse motoboy já está em turno.');
    const existente = convocacaoValida(motoboyId);
    if (existente) return existente;
    const fimDoDia = new Date(agora());
    fimDoDia.setHours(23, 59, 59, 999);
    return tx(() => {
      const r = q('INSERT INTO convocacoes (motoboy_id, criada_em, valida_ate, origem) VALUES (?,?,?,?)')
        .run(motoboyId, agora(), fimDoDia.getTime(), origem);
      auditar(ator, 'convocacao', m.nome);
      const conv = q('SELECT * FROM convocacoes WHERE id = ?').get(Number(r.lastInsertRowid));
      emitir('convocacao', { motoboy: m, convocacao: conv });
      return conv;
    });
  }
  function cancelarConvocacao(motoboyId, ator) {
    const r = q(`UPDATE convocacoes SET cancelada_em = ? WHERE motoboy_id = ?
                 AND usada_em IS NULL AND cancelada_em IS NULL AND valida_ate > ?`)
      .run(agora(), motoboyId, agora());
    if (r.changes) auditar(ator, 'convocacao_cancelada', String(motoboyId));
  }

  // -------------------------------------------------------------- turno
  function loginMotoboy({ telefone, pin, aceito_termo, dispositivo, origem }, ip) {
    const tel = soDigitos(telefone);
    exigirNaoBloqueado(`ip:${ip}`, 20);
    exigirNaoBloqueado(`mb:${tel}`);
    const m = q('SELECT * FROM motoboys WHERE telefone = ?').get(tel);
    const ok = verificarSenha(String(pin ?? ''), m ? m.pin_hash : HASH_FALSO);
    if (!m || !ok || !m.ativo) {
      registrarFalha(`ip:${ip}`);
      registrarFalha(`mb:${tel}`);
      throw new Erro(401, 'login_invalido', 'Telefone ou senha incorretos.');
    }
    if (aceito_termo !== true) {
      throw new Erro(422, 'termo_obrigatorio', 'É preciso aceitar o termo para iniciar o turno.');
    }
    const disp = txt(dispositivo, 80);
    const fonte = origem === 'app' ? 'app' : 'navegador';
    const c = cfg();

    return tx(() => {
      let turno = turnoAtivoDoMotoboy(m.id);
      if (turno) {
        // Só um aparelho por turno: o login novo derruba o anterior.
        q("DELETE FROM sessoes WHERE tipo = 'motoboy' AND ref_id = ?").run(turno.id);
        if ((turno.dispositivo || '') !== disp) {
          alertaPontual(turno, 'troca_aparelho', 'Login refeito em outro aparelho durante o turno.');
          q('UPDATE turnos SET dispositivo = ?, origem = ? WHERE id = ?').run(disp, fonte, turno.id);
        }
      } else {
        // Avulso entra quando quiser; diária só no dia em que for convocado, se a convocação for obrigatória.
        const avulso = m.tipo === 'avulso';
        const conv = avulso ? null : convocacaoValida(m.id);
        if (!avulso && !conv && cfgBruta().convocacao_obrigatoria === '1') {
          throw new Erro(403, 'sem_convocacao', 'Você não foi convocado hoje. Aguarde o chamado da Speed.');
        }
        const t = agora();
        const duracao = avulso ? Number(cfgBruta().avulso_max_horas) * 60 * MIN : c.turnoMs;
        const r = q(`INSERT INTO turnos (motoboy_id, inicio, fim_previsto, termo_versao, termo_aceito_em,
                     dispositivo, origem, ult_contato, tipo) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(m.id, t, t + duracao, cfgBruta().termo_versao, t, disp, fonte, t, m.tipo);
        if (conv) q('UPDATE convocacoes SET usada_em = ? WHERE id = ?').run(t, conv.id);
        turno = q('SELECT * FROM turnos WHERE id = ?').get(Number(r.lastInsertRowid));
        auditar(`motoboy:${m.nome}`, 'turno_iniciado', `termo v${turno.termo_versao}`);
      }
      const token = novoToken();
      q('INSERT INTO sessoes (token_hash, tipo, ref_id, criada_em, expira_em) VALUES (?,?,?,?,?)')
        .run(hashToken(token), 'motoboy', turno.id, agora(), turno.fim_previsto + c.prorrogacaoMs + MIN);
      despacharPendentes();
      return { token, fim_previsto: turno.fim_previsto };
    });
  }

  function autenticarMotoboy(token) {
    const negar = () => new Erro(401, 'turno_encerrado', 'Turno encerrado. Faça login de novo quando for convocado.');
    if (!token) throw negar();
    const s = q("SELECT * FROM sessoes WHERE token_hash = ? AND tipo = 'motoboy'").get(hashToken(token));
    if (!s || s.expira_em <= agora()) throw negar();
    const turno = q('SELECT * FROM turnos WHERE id = ? AND fim_real IS NULL').get(s.ref_id);
    if (!turno) throw negar();
    return turno;
  }

  const emAlmoco = (t) => t.almoco_inicio != null && t.almoco_fim == null;

  function almoco(turno, acao) {
    const t = agora();
    if (acao === 'iniciar') {
      if (turno.almoco_inicio != null) throw new Erro(409, 'almoco_usado', 'O almoço deste turno já foi usado.');
      const carregando = q("SELECT COUNT(*) AS n FROM demandas WHERE turno_id = ? AND status = 'coletada'").get(turno.id).n;
      if (carregando) throw new Erro(409, 'com_carga', 'Entregue o que já coletou antes de almoçar.');
      q('UPDATE turnos SET almoco_inicio = ? WHERE id = ?').run(t, turno.id);
      fecharAlerta(turno.id, 'parado');
    } else if (acao === 'encerrar') {
      if (!emAlmoco(turno)) throw new Erro(409, 'sem_almoco', 'Não há almoço em andamento.');
      q('UPDATE turnos SET almoco_fim = ?, ancora_ts = ? WHERE id = ?').run(t, t, turno.id);
    } else {
      throw new Erro(422, 'acao_invalida', 'Ação inválida.');
    }
  }

  function devolverNaoColetadas(turnoId) {
    const ids = q("SELECT id FROM demandas WHERE turno_id = ? AND status = 'atribuida'").all(turnoId);
    for (const { id } of ids) {
      q(`UPDATE demandas SET status = 'aguardando', motoboy_id = NULL, turno_id = NULL, atribuida_em = NULL,
         fila_em = ?, sem_aceite_avisado = 0 WHERE id = ?`).run(agora(), id);
      q("DELETE FROM ofertas WHERE demanda_id = ? AND status <> 'recusada'").run(id); // pode ser oferecida de novo
    }
    return ids.length;
  }
  // Só o avulso encerra por conta própria, e sem entrega aceita em aberto.
  function encerrarPeloMotoboy(turno) {
    if (turno.tipo !== 'avulso') throw new Erro(403, 'so_avulso', 'Seu turno é de diária: ele termina no horário combinado.');
    const abertas = q("SELECT COUNT(*) AS n FROM demandas WHERE turno_id = ? AND status IN ('atribuida','coletada')").get(turno.id).n;
    if (abertas) throw new Erro(409, 'com_demanda', 'Termine as entregas que você aceitou antes de encerrar.');
    encerrarTurno(turno.id, 'encerrado_pelo_motoboy', `motoboy:${turno.motoboy_id}`);
  }

  function encerrarTurno(turnoId, motivo, ator = 'sistema') {
    const turno = q('SELECT * FROM turnos WHERE id = ? AND fim_real IS NULL').get(turnoId);
    if (!turno) throw new Erro(404, 'nao_encontrado', 'Turno não encontrado ou já encerrado.');
    tx(() => {
      const t = agora();
      devolverNaoColetadas(turnoId);
      q('UPDATE alertas SET fim = ? WHERE turno_id = ? AND fim IS NULL').run(t, turnoId);
      q("UPDATE ofertas SET status = 'encerrada', respondida_em = ? WHERE turno_id = ? AND status = 'aberta'").run(t, turnoId);
      const comCarga = q("SELECT COUNT(*) AS n FROM demandas WHERE turno_id = ? AND status = 'coletada'").get(turnoId).n;
      if (comCarga) {
        alertaPontual(turno, 'carga_pendente', `Turno encerrado com ${comCarga} entrega(s) coletada(s) e não entregue(s).`);
      }
      q(`UPDATE turnos SET fim_real = ?, motivo_fim = ?,
         almoco_fim = CASE WHEN almoco_inicio IS NOT NULL AND almoco_fim IS NULL THEN ? ELSE almoco_fim END
         WHERE id = ?`).run(t, motivo, t, turnoId);
      q("DELETE FROM sessoes WHERE tipo = 'motoboy' AND ref_id = ?").run(turnoId);
      auditar(ator, 'turno_encerrado', `turno ${turnoId}: ${motivo}`);
      despacharPendentes();
    });
  }

  // ------------------------------------------------------------ alertas
  const alertaAberto = (turnoId, tipo) =>
    q('SELECT id FROM alertas WHERE turno_id = ? AND tipo = ? AND fim IS NULL').get(turnoId, tipo);
  function abrirAlerta(turno, tipo, detalhe, inicio = agora()) {
    if (alertaAberto(turno.id, tipo)) return;
    q('INSERT INTO alertas (turno_id, motoboy_id, tipo, inicio, detalhe) VALUES (?,?,?,?,?)')
      .run(turno.id, turno.motoboy_id, tipo, inicio, detalhe);
    emitir('alerta', { turno, tipo, detalhe });
  }
  function fecharAlerta(turnoId, tipo, fim = agora()) {
    q('UPDATE alertas SET fim = ? WHERE turno_id = ? AND tipo = ? AND fim IS NULL').run(fim, turnoId, tipo);
  }
  function alertaPontual(turno, tipo, detalhe) {
    const t = agora();
    q('INSERT INTO alertas (turno_id, motoboy_id, tipo, inicio, fim, detalhe) VALUES (?,?,?,?,?,?)')
      .run(turno.id, turno.motoboy_id, tipo, t, t, detalhe);
    emitir('alerta', { turno, tipo, detalhe });
  }

  // ----------------------------------------------------------- posições
  function registrarPosicoes(turnoInicial, corpo) {
    const c = cfg();
    const t = agora();
    const brutos = Array.isArray(corpo?.pontos) ? corpo.pontos.slice(0, 2000) : [];
    const pontos = [];
    for (const p of brutos) {
      const lat = Number(p?.lat);
      const lon = Number(p?.lon);
      let ts = Number(p?.ts);
      if (!coordValida(lat, lon) || !Number.isFinite(ts)) continue;
      if (ts > t + MIN) ts = t; // relógio do aparelho adiantado
      if (ts < turnoInicial.inicio - MIN) continue; // fora do turno: não guarda
      const precisao = Number.isFinite(Number(p.precisao)) ? Math.max(0, Number(p.precisao)) : null;
      const velocidade = Number.isFinite(Number(p.velocidade)) ? Math.max(0, Number(p.velocidade)) : null;
      pontos.push({ lat, lon, ts: Math.round(ts), precisao, velocidade, falso: p.falso ? 1 : 0 });
    }
    pontos.sort((a, b) => a.ts - b.ts);

    return tx(() => {
      const turno = q('SELECT * FROM turnos WHERE id = ?').get(turnoInicial.id);
      const inserir = q(`INSERT INTO posicoes (turno_id, ts, lat, lon, precisao, velocidade, falso)
                         VALUES (?,?,?,?,?,?,?)`);
      let { ult_lat, ult_lon, ult_ts, ult_precisao, ancora_lat, ancora_lon, ancora_ts, km } = turno;
      const rota = rotaDoTurno(turno.id);
      const almocando = emAlmoco(turno);
      let viuFalso = false;
      let viuReal = false;

      for (const p of pontos) {
        if (ult_ts != null && p.ts <= ult_ts) continue; // repetido ou fora de ordem
        inserir.run(turno.id, p.ts, p.lat, p.lon, p.precisao, p.velocidade, p.falso);
        if (p.falso) viuFalso = true; else viuReal = true;
        const boa = p.precisao == null || p.precisao <= PRECISAO_MAX_M;

        if (ult_ts != null && boa && (ult_precisao == null || ult_precisao <= PRECISAO_MAX_M)) {
          const d = distM({ lat: ult_lat, lon: ult_lon }, p);
          const horas = (p.ts - ult_ts) / 3_600_000;
          if (d > 1000 && horas > 0 && d / 1000 / horas > 180) {
            alertaPontual(turno, 'salto', `Posição pulou ${(d / 1000).toFixed(1)} km em ${Math.round(horas * 3600)} s.`);
          } else if (d > 15) {
            km += d / 1000;
          }
        }

        if (boa) {
          const longeDaAncora =
            ancora_ts == null || distM({ lat: ancora_lat, lon: ancora_lon }, p) > RAIO_PARADO_M;
          if (longeDaAncora) {
            ancora_lat = p.lat; ancora_lon = p.lon; ancora_ts = p.ts;
            fecharAlerta(turno.id, 'parado', p.ts);
          } else if (rota.length && !almocando) {
            const naParada = distM(rota[0], p) <= c.cercaM;
            const limite = naParada ? c.esperaParadaMs : c.paradoMs;
            if (p.ts - ancora_ts >= limite) {
              abrirAlerta(
                turno, 'parado',
                naParada ? 'Parado no local da parada além do tempo de espera.' : 'Parado no meio da rota.',
                ancora_ts,
              );
            }
          }
        }
        ult_lat = p.lat; ult_lon = p.lon; ult_ts = p.ts; ult_precisao = p.precisao;
      }

      if (viuFalso) abrirAlerta(turno, 'gps_falso', 'O aparelho está usando localização falsa (mock).');
      else if (viuReal) fecharAlerta(turno.id, 'gps_falso');
      if (corpo?.gps_ligado === false) abrirAlerta(turno, 'gps_desligado', 'GPS desligado no aparelho.');
      else if (corpo?.gps_ligado === true || viuReal) fecharAlerta(turno.id, 'gps_desligado');
      fecharAlerta(turno.id, 'sem_sinal');

      const bat = Number(corpo?.bateria);
      const bateria = Number.isFinite(bat) && bat >= 0 && bat <= 100 ? Math.round(bat) : turno.bateria;
      q(`UPDATE turnos SET ult_lat=?, ult_lon=?, ult_ts=?, ult_precisao=?, ancora_lat=?, ancora_lon=?,
         ancora_ts=?, km=?, ult_contato=?, bateria=? WHERE id=?`)
        .run(ult_lat, ult_lon, ult_ts, ult_precisao, ancora_lat, ancora_lon, ancora_ts, km, t, bateria, turno.id);

      // Primeira posição do turno: agora dá para escolher por proximidade.
      if (turno.ult_ts == null && ult_ts != null) despacharPendentes();

      const atual = q('SELECT rota_versao, fim_previsto FROM turnos WHERE id = ?').get(turno.id);
      const ofertas = q("SELECT COUNT(*) AS n FROM ofertas WHERE turno_id = ? AND status = 'aberta'").get(turno.id).n;
      return { rota_versao: atual.rota_versao, fim_previsto: atual.fim_previsto, pendentes: rotaDoTurno(turno.id).length + ofertas, ofertas };
    });
  }

  // ----------------------------------------------------------- demandas
  function lerPonto(p, nome) {
    const endereco = txt(p?.endereco, 200);
    if (endereco.length < 4) throw new Erro(422, 'endereco_invalido', `Informe o endereço de ${nome}.`);
    const lat = p?.lat == null || p.lat === '' ? null : Number(p.lat);
    const lon = p?.lon == null || p.lon === '' ? null : Number(p.lon);
    const temCoord = lat != null && lon != null;
    if (temCoord && !coordValida(lat, lon)) throw new Erro(422, 'local_invalido', `Local de ${nome} inválido.`);
    return { endereco, lat: temCoord ? lat : null, lon: temCoord ? lon : null, contato: txt(p?.contato, 120) };
  }
  function validarDemanda(d) {
    const cliente = txt(d?.cliente, 120);
    if (cliente.length < 2) throw new Erro(422, 'cliente_invalido', 'Informe o cliente.');
    const requisito = d?.requisito ?? 'qualquer';
    if (!REQUISITOS.includes(requisito)) throw new Erro(422, 'requisito_invalido', 'Requisito inválido.');
    return {
      cliente, requisito, descricao: txt(d?.descricao, 500),
      telefone: normalizarTelefone(d?.cliente_telefone ?? d?.telefone),
      urgente: d?.urgente ? 1 : 0, servicoId: d?.servico_id ? Number(d.servico_id) : null,
      km: Number.isFinite(Number(d?.km)) && Number(d?.km) > 0 ? Number(d.km) : null, email: txt(d?.email, 120),
      coleta: lerPonto(d?.coleta, 'coleta'), entrega: lerPonto(d?.entrega, 'entrega'),
    };
  }
  // `retida`: fica parada (sem despacho) até o admin aprovar ou o cliente confirmar.
  function inserirDemanda(v, origem, ator, { retida = false, pagamento = '', ia = null } = {}) {
    const completo = v.coleta.lat != null && v.entrega.lat != null;
    const { km, valor, repasse, servico } = cotar(v.coleta, v.entrega, { km: v.km, servicoId: v.servicoId, telefone: v.telefone });
    const r = q(`INSERT INTO demandas (cliente, descricao, requisito, origem,
        coleta_endereco, coleta_lat, coleta_lon, coleta_contato,
        entrega_endereco, entrega_lat, entrega_lon, entrega_contato, status, criada_em,
        codigo, cliente_telefone, valor, km, retida, urgente, servico, repasse, pagamento, email, fila_em, ia_ok, ia_obs)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(v.cliente, v.descricao, v.requisito, origem,
        v.coleta.endereco, v.coleta.lat, v.coleta.lon, v.coleta.contato,
        v.entrega.endereco, v.entrega.lat, v.entrega.lon, v.entrega.contato,
        completo ? 'aguardando' : 'sem_local', agora(),
        crypto.randomBytes(9).toString('base64url'), v.telefone || '', valor, km, retida ? 1 : 0,
        v.urgente, servico?.nome || '', repasse, pagamento, v.email, agora(),
        ia ? (ia.aprovado ? 1 : 0) : null, ia ? txt(ia.aprovado ? ia.resumo : ia.motivos.join(' · '), 500) : null);
    const id = Number(r.lastInsertRowid);
    auditar(ator, 'demanda_criada', `#${id} ${v.cliente}`);
    emitir('demanda_criada', { demanda: q('SELECT * FROM demandas WHERE id = ?').get(id) });
    if (completo && !retida) despachar(id);
    return q('SELECT * FROM demandas WHERE id = ?').get(id);
  }
  // Pedido vindo do site ou do robô (os dados já foram conferidos por quem chama).
  function criarPedido(dados, origem, opcoes) {
    const v = validarDemanda(dados);
    return tx(() => inserirDemanda(v, origem, origem, opcoes));
  }
  // Aprovação no painel ou confirmação do cliente: solta a demanda para o despacho.
  function liberarDemanda(id, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    if (!d.retida || ['entregue', 'cancelada'].includes(d.status)) return false;
    // Aprovado pela equipe, mas o cliente ainda não pagou: manda o Pix e continua segurando.
    if (String(ator).startsWith('admin') && precisaCobrar(d)) {
      auditar(ator, 'demanda_aprovada', `#${id} (aguardando Pix)`);
      emitir('cobrar', { demanda: d });
      return 'cobrar';
    }
    tx(() => {
      q('UPDATE demandas SET retida = 0, fila_em = ? WHERE id = ?').run(agora(), id);
      auditar(ator, 'demanda_liberada', `#${id}`);
      despachar(id);
    });
    return true;
  }
  // Pedido do site sem telefone: o número chega quando o cliente manda a mensagem no WhatsApp.
  // Só preenche se estiver vazio (não troca o contato de um pedido que já tem dono).
  function definirContato(id, telefoneBruto, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    const telefone = normalizarTelefone(telefoneBruto);
    if (!telefone) throw new Erro(422, 'telefone_invalido', 'Telefone inválido.');
    if (d.cliente_telefone) return { definido: false, igual: d.cliente_telefone === telefone };
    if (d.origem !== 'site' || ['entregue', 'cancelada'].includes(d.status)) return { definido: false, igual: false };
    q('UPDATE demandas SET cliente_telefone = ? WHERE id = ?').run(telefone, id);
    auditar(ator, 'demanda_contato', `#${id}`);
    return { definido: true, igual: true };
  }
  // Pedido do site fechado por fora (ex.: cliente aceitou o valor no WhatsApp): grava o valor
  // combinado, recalcula o repasse e solta para o motoboy. Só pedido retido e ainda aberto.
  function fecharPedido(id, valorCombinado, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    if (!d.retida || ['entregue', 'cancelada'].includes(d.status)) return { liberada: false, motivo: 'ja_liberada_ou_encerrada', status: d.status };
    const valor = Number(valorCombinado);
    if (valorCombinado != null && valorCombinado !== '') {
      if (!Number.isFinite(valor) || valor <= 0 || valor > 100000) throw new Erro(422, 'valor_invalido', 'Valor inválido.');
      const c = cfgBruta();
      const serv = d.servico ? q('SELECT * FROM servicos WHERE nome = ?').get(d.servico) : null;
      const pct = serv?.repasse_pct ?? Number(c.repasse_pct);
      const repasse = Math.round(Math.max(Number(c.repasse_minimo), (valor * pct) / 100) * 100) / 100;
      q('UPDATE demandas SET valor = ?, repasse = ? WHERE id = ?').run(Math.round(valor * 100) / 100, repasse, id);
      auditar(ator, 'demanda_valor', `#${id} ${valor}`);
    }
    const r = liberarDemanda(id, ator);
    return { liberada: r === true, status: q('SELECT status FROM demandas WHERE id = ?').get(id).status };
  }
  // Pix gerado para o pedido (o código fica guardado para a página de acompanhamento mostrar).
  function registrarPix(id, { pagId, pix, qr, expira }) {
    q("UPDATE demandas SET pagamento = 'pendente', pag_id = ?, pag_pix = ?, pag_qr = ?, pag_expira = ? WHERE id = ?")
      .run(String(pagId), pix, qr, expira, id);
  }
  // Pagamento confirmado pelo banco: solta o pedido para os motoboys.
  function marcarPago(id, ator = 'pagamento') {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d || d.pagamento === 'pago') return false;
    tx(() => {
      q("UPDATE demandas SET pagamento = 'pago', pago_em = ? WHERE id = ?").run(agora(), id);
      auditar(ator, 'demanda_paga', `#${id}`);
      emitir('demanda_paga', { demanda: q('SELECT * FROM demandas WHERE id = ?').get(id) });
      if (d.status === 'cancelada') emitir('pago_cancelado', { demanda: d });
      else liberarDemanda(id, 'pagamento');
    });
    return true;
  }
  function criarDemanda(dados, ator) {
    const v = validarDemanda(dados);
    const mensagemId = Number(dados?.mensagem_id) || null;
    return tx(() => {
      const d = inserirDemanda(v, mensagemId ? 'whatsapp' : 'painel', ator);
      if (mensagemId) q('UPDATE mensagens SET demanda_id = ? WHERE id = ?').run(d.id, mensagemId);
      return d;
    });
  }
  // Entrada automática (app de clientes, Make, WhatsApp): endereço em texto vira ponto no mapa.
  async function criarDemandaExterna(dados) {
    const v = validarDemanda(dados);
    if (geocodificar) {
      for (const ponto of [v.coleta, v.entrega]) {
        if (ponto.lat != null) continue;
        try {
          const achados = await geocodificar(ponto.endereco, { cidadeBase: cfgBruta().cidade_base, limite: 1 });
          if (achados[0]) { ponto.lat = achados[0].lat; ponto.lon = achados[0].lon; }
        } catch { /* fica sem local: o admin ajusta no painel */ }
      }
    }
    return tx(() => inserirDemanda(v, 'api', 'api'));
  }
  function definirLocais(id, dados, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    if (!['sem_local', 'aguardando'].includes(d.status)) {
      throw new Erro(409, 'ja_atribuida', 'Só dá para mudar o local antes de a demanda ir para um motoboy.');
    }
    const coleta = lerPonto({ endereco: d.coleta_endereco, lat: d.coleta_lat, lon: d.coleta_lon, ...dados?.coleta }, 'coleta');
    const entrega = lerPonto({ endereco: d.entrega_endereco, lat: d.entrega_lat, lon: d.entrega_lon, ...dados?.entrega }, 'entrega');
    if (coleta.lat == null || entrega.lat == null) throw new Erro(422, 'local_invalido', 'Marque coleta e entrega no mapa.');
    const servicoId = d.servico ? q('SELECT id FROM servicos WHERE nome = ?').get(d.servico)?.id : null;
    const { km, valor, repasse } = cotar(coleta, entrega, { servicoId, telefone: d.cliente_telefone });
    // Já pago: o valor combinado com o cliente não muda.
    const novoValor = d.pagamento === 'pago' ? d.valor : valor;
    const novoRepasse = d.pagamento === 'pago' ? d.repasse : repasse;
    // Pedido de cliente (site ou WhatsApp) que entrou sem preço: agora tem valor e precisa ser pago antes de sair.
    const cobrar = precisaCobrar(d, novoValor);
    const segurar = d.pagamento === 'pendente' || cobrar;
    tx(() => {
      q(`UPDATE demandas SET coleta_endereco=?, coleta_lat=?, coleta_lon=?, entrega_endereco=?, entrega_lat=?,
         entrega_lon=?, status='aguardando', km=?, valor=?, repasse=?, retida=?, fila_em=? WHERE id=?`)
        .run(coleta.endereco, coleta.lat, coleta.lon, entrega.endereco, entrega.lat, entrega.lon, km, novoValor, novoRepasse,
          segurar ? 1 : 0, agora(), id);
      auditar(ator, 'demanda_local', `#${id}`);
      if (cobrar) emitir('cobrar', { demanda: q('SELECT * FROM demandas WHERE id = ?').get(id) });
      despachar(id);
    });
  }
  function cancelarDemanda(id, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    if (['entregue', 'cancelada'].includes(d.status)) throw new Erro(409, 'ja_finalizada', 'Demanda já finalizada.');
    tx(() => {
      q("UPDATE demandas SET status = 'cancelada', cancelada_em = ? WHERE id = ?").run(agora(), id);
      q("UPDATE ofertas SET status = 'encerrada', respondida_em = ? WHERE demanda_id = ? AND status = 'aberta'").run(agora(), id);
      if (d.turno_id) q('UPDATE turnos SET rota_versao = rota_versao + 1 WHERE id = ?').run(d.turno_id);
      auditar(ator, 'demanda_cancelada', `#${id}`);
      emitir('demanda_cancelada', { demanda: d });
    });
  }

  // ----------------------------------------------------- rota e despacho
  const parada = (d, tipo) => ({
    demanda_id: d.id,
    tipo,
    lat: tipo === 'coleta' ? d.coleta_lat : d.entrega_lat,
    lon: tipo === 'coleta' ? d.coleta_lon : d.entrega_lon,
    endereco: tipo === 'coleta' ? d.coleta_endereco : d.entrega_endereco,
    contato: tipo === 'coleta' ? d.coleta_contato : d.entrega_contato,
    cliente: d.cliente,
    descricao: d.descricao,
    servico: d.servico,
    repasse: d.repasse,
    ordem: tipo === 'coleta' ? d.ordem_coleta : d.ordem_entrega,
  });
  function rotaDoTurno(turnoId) {
    const paradas = [];
    const lista = q("SELECT * FROM demandas WHERE turno_id = ? AND status IN ('atribuida','coletada')").all(turnoId);
    for (const d of lista) {
      if (d.status === 'atribuida') paradas.push(parada(d, 'coleta'));
      paradas.push(parada(d, 'entrega'));
    }
    return paradas.sort((a, b) =>
      a.ordem - b.ordem || a.demanda_id - b.demanda_id || (a.tipo === 'coleta' ? -1 : 1));
  }
  function atribuir(d, turno) {
    const rota = rotaDoTurno(turno.id);
    const origem = turno.ult_lat != null ? { lat: turno.ult_lat, lon: turno.ult_lon } : null;
    const { rota: nova } = melhorInsercao(origem, rota, parada(d, 'coleta'), parada(d, 'entrega'));
    const t = agora();
    q(`UPDATE demandas SET status = 'atribuida', motoboy_id = ?, turno_id = ?, atribuida_em = ?,
       coletada_em = NULL, coleta_dist_m = NULL, coleta_justificativa = NULL WHERE id = ?`)
      .run(turno.motoboy_id, turno.id, t, d.id);
    nova.forEach((p, i) => {
      const coluna = p.tipo === 'coleta' ? 'ordem_coleta' : 'ordem_entrega';
      q(`UPDATE demandas SET ${coluna} = ? WHERE id = ?`).run(i, p.demanda_id);
    });
    // Estava livre: o tempo parado esperando serviço não conta contra ele.
    if (rota.length === 0) q('UPDATE turnos SET ancora_ts = ? WHERE id = ?').run(t, turno.id);
    q('UPDATE turnos SET rota_versao = rota_versao + 1 WHERE id = ?').run(turno.id);
    q("UPDATE ofertas SET status = 'encerrada', respondida_em = ? WHERE demanda_id = ? AND status = 'aberta'").run(t, d.id);
    emitir('demanda_atribuida', {
      demanda: d, turno, motoboy: q('SELECT * FROM motoboys WHERE id = ?').get(turno.motoboy_id),
    });
  }
  function candidatos() {
    const t = agora();
    return q('SELECT * FROM turnos WHERE fim_real IS NULL').all()
      .filter((turno) => turno.fim_previsto - t > FOLGA_FIM_TURNO)
      .map((turno) => ({
        turno,
        motoboy: q('SELECT * FROM motoboys WHERE id = ?').get(turno.motoboy_id),
        rota: rotaDoTurno(turno.id),
        emAlmoco: emAlmoco(turno),
      }));
  }
  const abertasDoTurno = (turnoId) =>
    q("SELECT COUNT(*) AS n FROM demandas WHERE turno_id = ? AND status IN ('atribuida','coletada')").get(turnoId).n;

  // Oferece a demanda a quem está online, perto da coleta e pode atender. O primeiro que aceitar leva.
  // Urgente: todos (diária e avulso). Comum: só avulsos (a diária recebe direto, sem precisar aceitar).
  function ofertar(d) {
    const c = cfg();
    const b = cfgBruta();
    const t = agora();
    const desde = d.fila_em ?? d.criada_em;
    const raio = Number(b.oferta_raio_km) * 2 ** Math.min(3, Math.floor((t - desde) / VOLTA_OFERTA));
    let novas = 0;
    for (const cand of candidatos()) {
      const { turno, motoboy } = cand;
      if (!d.urgente && turno.tipo !== 'avulso') continue;
      if (cand.emAlmoco || turno.ult_lat == null || t - (turno.ult_contato ?? turno.inicio) > c.semSinalMs) continue;
      if (!atende(motoboy, d, c) || abertasDoTurno(turno.id) >= c.capacidade) continue;
      const dist = distRuaKm({ lat: turno.ult_lat, lon: turno.ult_lon }, { lat: d.coleta_lat, lon: d.coleta_lon });
      if (dist > raio) continue;
      const r = q('INSERT OR IGNORE INTO ofertas (demanda_id, turno_id, criada_em, dist_km) VALUES (?,?,?,?)')
        .run(d.id, turno.id, t, Math.round(dist * 10) / 10);
      if (!r.changes) continue;
      novas++;
      q('UPDATE turnos SET rota_versao = rota_versao + 1 WHERE id = ?').run(turno.id); // o app avisa o motoboy
      emitir('oferta', { demanda: d, turno, motoboy });
    }
    if (d.urgente && !d.sem_aceite_avisado && t - desde > Number(b.oferta_alerta_min) * MIN) {
      q('UPDATE demandas SET sem_aceite_avisado = 1 WHERE id = ?').run(d.id);
      emitir('sem_aceite', { demanda: d });
    }
    return novas;
  }
  // Despacha a demanda. Devolve true se já ficou com um motoboy.
  function despachar(demandaId) {
    const d = q("SELECT * FROM demandas WHERE id = ? AND status = 'aguardando' AND retida = 0").get(demandaId);
    if (!d) return false;
    if (!d.urgente) {
      const escolhido = escolherMotoboy(d, candidatos().filter((x) => x.turno.tipo === 'diaria'), cfg());
      if (escolhido) {
        atribuir(d, escolhido.turno);
        auditar('sistema', 'despacho', `#${d.id} -> ${escolhido.motoboy.nome} (+${escolhido.kmExtra.toFixed(1)} km)`);
        return true;
      }
    }
    ofertar(d);
    return false;
  }
  function responderOferta(turno, { oferta_id: ofertaId, acao }) {
    const o = q('SELECT * FROM ofertas WHERE id = ? AND turno_id = ?').get(Number(ofertaId), turno.id);
    const perdeu = () => new Erro(409, 'oferta_encerrada', 'Essa entrega já foi pega por outro motoboy.');
    if (!o || o.status !== 'aberta') throw perdeu();
    const t = agora();
    if (acao === 'recusar') {
      q("UPDATE ofertas SET status = 'recusada', respondida_em = ? WHERE id = ?").run(t, o.id);
      return;
    }
    if (acao !== 'aceitar') throw new Erro(422, 'acao_invalida', 'Ação inválida.');
    tx(() => {
      const d = q("SELECT * FROM demandas WHERE id = ? AND status = 'aguardando' AND retida = 0").get(o.demanda_id);
      if (!d) {
        q("UPDATE ofertas SET status = 'encerrada', respondida_em = ? WHERE id = ?").run(t, o.id);
        throw perdeu();
      }
      if (abertasDoTurno(turno.id) >= cfg().capacidade) throw new Erro(409, 'cheio', 'Termine uma entrega antes de aceitar outra.');
      q("UPDATE ofertas SET status = 'aceita', respondida_em = ? WHERE id = ?").run(t, o.id);
      atribuir(d, q('SELECT * FROM turnos WHERE id = ?').get(turno.id));
      auditar(`motoboy:${turno.motoboy_id}`, 'oferta_aceita', `#${d.id}`);
    });
  }
  function despacharPendentes() {
    let n = 0;
    tx(() => {
      for (const { id } of q("SELECT id FROM demandas WHERE status = 'aguardando' AND retida = 0 ORDER BY criada_em").all()) {
        if (despachar(id)) n++;
      }
    });
    return n;
  }
  // Troca manual feita pelo admin (motoboyId vazio = devolve para a fila e redistribui).
  function reatribuir(demandaId, motoboyId, ator) {
    const d = q('SELECT * FROM demandas WHERE id = ?').get(demandaId);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Demanda não encontrada.');
    if (!['aguardando', 'atribuida', 'coletada'].includes(d.status)) {
      throw new Erro(409, 'nao_reatribuivel', 'Essa demanda não pode ser reatribuída.');
    }
    tx(() => {
      if (d.turno_id) q('UPDATE turnos SET rota_versao = rota_versao + 1 WHERE id = ?').run(d.turno_id);
      q(`UPDATE demandas SET status = 'aguardando', motoboy_id = NULL, turno_id = NULL, atribuida_em = NULL,
         coletada_em = NULL, retida = 0, fila_em = ?, sem_aceite_avisado = 0 WHERE id = ?`).run(agora(), demandaId);
      q("DELETE FROM ofertas WHERE demanda_id = ? AND status <> 'recusada'").run(demandaId);
      const livre = q('SELECT * FROM demandas WHERE id = ?').get(demandaId);
      if (motoboyId) {
        const turno = turnoAtivoDoMotoboy(motoboyId);
        if (!turno) throw new Erro(409, 'sem_turno', 'Esse motoboy não está em turno.');
        atribuir(livre, turno);
        auditar(ator, 'reatribuicao', `#${demandaId} -> motoboy ${motoboyId}`);
      } else {
        auditar(ator, 'reatribuicao', `#${demandaId} -> fila`);
        despachar(demandaId);
      }
    });
  }

  function confirmarParada(turno, { demanda_id, tipo, lat, lon, recebedor, justificativa }) {
    const d = q('SELECT * FROM demandas WHERE id = ? AND turno_id = ?').get(Number(demanda_id), turno.id);
    if (!d) throw new Erro(404, 'nao_encontrado', 'Essa parada não está na sua rota.');
    if (tipo === 'coleta' && d.status !== 'atribuida') throw new Erro(409, 'estado_invalido', 'Coleta já registrada.');
    if (tipo === 'entrega' && d.status !== 'coletada') throw new Erro(409, 'estado_invalido', 'Registre a coleta antes da entrega.');
    if (tipo !== 'coleta' && tipo !== 'entrega') throw new Erro(422, 'tipo_invalido', 'Tipo inválido.');
    const c = cfg();
    const t = agora();
    const alvo = parada(d, tipo);

    // Vale a posição que o servidor já tem (rastreio); a enviada pela tela só serve de reserva.
    let pos = null;
    if (turno.ult_ts != null && t - turno.ult_ts <= 2 * MIN) pos = { lat: turno.ult_lat, lon: turno.ult_lon };
    else if (coordValida(Number(lat), Number(lon))) pos = { lat: Number(lat), lon: Number(lon) };
    const dist = pos ? Math.round(distM(pos, alvo)) : null;
    const fora = dist == null || dist > c.cercaM;
    const motivo = txt(justificativa, 300);
    if (fora && motivo.length < 5) {
      throw new Erro(422, 'fora_do_local',
        dist == null
          ? 'Não consegui confirmar sua localização. Explique o motivo para registrar.'
          : `Você está a ${dist} m do local. Explique o motivo para registrar.`,
        { distancia_m: dist });
    }
    const nomeRecebedor = txt(recebedor, 80);
    if (tipo === 'entrega' && nomeRecebedor.length < 2) {
      throw new Erro(422, 'recebedor_obrigatorio', 'Informe o nome de quem recebeu.');
    }

    tx(() => {
      if (tipo === 'coleta') {
        q(`UPDATE demandas SET status = 'coletada', coletada_em = ?, coleta_dist_m = ?, coleta_justificativa = ?
           WHERE id = ?`).run(t, dist, fora ? motivo : null, d.id);
      } else {
        q(`UPDATE demandas SET status = 'entregue', entregue_em = ?, entrega_dist_m = ?, entrega_justificativa = ?,
           recebedor = ? WHERE id = ?`).run(t, dist, fora ? motivo : null, nomeRecebedor, d.id);
      }
      if (fora) {
        alertaPontual(turno, 'fora_do_local',
          `${tipo === 'coleta' ? 'Coleta' : 'Entrega'} #${d.id} registrada ${dist == null ? 'sem localização' : `a ${dist} m do local`}. Motivo: ${motivo}`);
      }
      fecharAlerta(turno.id, 'parado');
      q('UPDATE turnos SET ancora_ts = ? WHERE id = ?').run(t, turno.id);
      emitir(tipo === 'coleta' ? 'demanda_coletada' : 'demanda_entregue', {
        demanda: q('SELECT * FROM demandas WHERE id = ?').get(d.id),
      });
    });
  }

  // ------------------------------------------------------- telas (leitura)
  function estadoMotoboy(turno) {
    const m = q('SELECT nome, veiculo FROM motoboys WHERE id = ?').get(turno.motoboy_id);
    const c = cfg();
    const avulso = turno.tipo === 'avulso';
    // A diária não recebe por entrega: o valor do repasse só aparece para o avulso.
    const paga = (v) => (avulso ? v : null);
    const ofertas = q(`SELECT o.id, o.dist_km, d.id AS demanda_id, d.servico, d.descricao, d.coleta_endereco,
        d.entrega_endereco, d.km, d.repasse, d.urgente
      FROM ofertas o JOIN demandas d ON d.id = o.demanda_id
      WHERE o.turno_id = ? AND o.status = 'aberta' AND d.status = 'aguardando' AND d.retida = 0
      ORDER BY o.id`).all(turno.id).map((o) => ({ ...o, repasse: paga(o.repasse) }));
    const feitas = avulso ? q(`SELECT id, servico, entrega_endereco, entregue_em, repasse FROM demandas
        WHERE turno_id = ? AND status = 'entregue' ORDER BY entregue_em DESC`).all(turno.id) : [];
    return {
      agora: agora(),
      motoboy: { nome: m.nome, veiculo: m.veiculo, tipo: turno.tipo },
      ofertas,
      ganhos: avulso ? { total: Math.round(feitas.reduce((soma, d) => soma + (d.repasse || 0), 0) * 100) / 100, entregas: feitas } : null,
      pode_encerrar: avulso && abertasDoTurno(turno.id) === 0,
      turno: {
        inicio: turno.inicio,
        fim_previsto: turno.fim_previsto,
        almoco_usado: turno.almoco_inicio != null,
        almoco_ate: emAlmoco(turno) ? turno.almoco_inicio + c.almocoMs : null,
        ult_ts: turno.ult_ts,
      },
      rota_versao: turno.rota_versao,
      cerca_m: c.cercaM,
      rota: rotaDoTurno(turno.id).map(({ ordem, ...p }) => ({ ...p, repasse: paga(p.repasse) })),
    };
  }

  function inicioDoDia() {
    const d = new Date(agora());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function statusTurno(turno, pendentes, c) {
    if (agora() - (turno.ult_contato ?? turno.inicio) > c.semSinalMs) return 'sem_sinal';
    if (emAlmoco(turno)) return 'almoco';
    return pendentes > 0 ? 'em_rota' : 'disponivel';
  }

  function estadoAdmin() {
    const c = cfg();
    const hoje = inicioDoDia();
    const motoboys = q('SELECT id, nome, telefone, veiculo, tem_bau, tem_bag, ativo, tipo, pin_claro, documento, placa FROM motoboys ORDER BY nome').all()
      .map((m) => {
        const turno = turnoAtivoDoMotoboy(m.id);
        const conv = turno ? null : convocacaoValida(m.id);
        const ultimo = q('SELECT MAX(inicio) AS t FROM turnos WHERE motoboy_id = ?').get(m.id).t;
        let resumo = null;
        if (turno) {
          const pendentes = rotaDoTurno(turno.id).length;
          resumo = {
            id: turno.id, inicio: turno.inicio, fim_previsto: turno.fim_previsto,
            lat: turno.ult_lat, lon: turno.ult_lon, ult_ts: turno.ult_ts, ult_contato: turno.ult_contato,
            bateria: turno.bateria, km: Math.round(turno.km * 10) / 10, origem: turno.origem,
            pendentes, status: statusTurno(turno, pendentes, c),
            almoco_ate: emAlmoco(turno) ? turno.almoco_inicio + c.almocoMs : null,
          };
        }
        return { ...m, turno: resumo, convocado_ate: conv ? conv.valida_ate : null, ultimo_turno: ultimo };
      });

    const ofertasAbertas = new Map(q(`SELECT demanda_id, COUNT(*) AS n FROM ofertas WHERE status = 'aberta'
        GROUP BY demanda_id`).all().map((o) => [o.demanda_id, o.n]));
    const demandas = q(`SELECT * FROM demandas
        WHERE status IN ('sem_local','aguardando','atribuida','coletada')
           OR entregue_em >= ? OR cancelada_em >= ?
        ORDER BY criada_em DESC LIMIT 300`).all(hoje, hoje)
      .map(({ pag_qr, pag_pix, ...d }) => ({ ...d, ofertas: ofertasAbertas.get(d.id) || 0 }));
    const alertas = q(`SELECT a.*, m.nome AS motoboy FROM alertas a JOIN motoboys m ON m.id = a.motoboy_id
        WHERE a.fim IS NULL OR a.inicio >= ? ORDER BY (a.fim IS NULL) DESC, a.inicio DESC LIMIT 100`).all(hoje);

    const candidatos = q("SELECT * FROM candidatos WHERE status = 'pendente' ORDER BY criado_em").all();
    return {
      agora: agora(),
      motoboys,
      demandas,
      alertas,
      sugestoes: sugestoes(motoboys, demandas, c),
      mapa: { lat: Number(cfgBruta().mapa_lat), lon: Number(cfgBruta().mapa_lon) },
      pendencias: [...(candidatos.length ? [`${candidatos.length} cadastro(s) de motoboy aguardando sua resposta (aba Motoboys).`] : []), ...pendencias(motoboys)],
      candidatos,
    };
  }

  // O que ainda falta configurar para o sistema rodar sozinho (aparece no painel).
  function pendencias(motoboys) {
    const c = cfgBruta();
    const falta = [];
    if (!c.cidade_base) falta.push('Preencher a cidade base (a busca de endereço erra menos).');
    if (!Number(c.diaria_valor)) falta.push('Definir o valor da diária.');
    if (!Number(c.preco_base) && !Number(c.preco_km) && !Number(c.preco_minimo)) falta.push('Definir o preço da entrega (o cliente vê o valor na hora).');
    if (!motoboys.some((m) => m.ativo)) falta.push('Cadastrar os motoboys.');
    if (!c.pix_chave && !c.mp_token) falta.push('Configurar o Pix (o cliente paga antes de liberar o motoboy).');
    if (!c.ia_chave) falta.push('Colar a chave da IA (confere endereço e tipo de serviço de cada pedido).');
    if (!c.whats_provedor) falta.push('Ligar o WhatsApp automático (robô de pedidos, avisos e convocação).');
    else if (!c.admin_telefone) falta.push('Informar o WhatsApp do responsável (recebe os avisos importantes).');
    return falta;
  }

  // O que o cliente vê na página de acompanhamento (link com código secreto).
  function pedidoPublico(codigo) {
    const d = typeof codigo === 'string' && codigo.length >= 8
      ? q('SELECT * FROM demandas WHERE codigo = ?').get(codigo) : null;
    if (!d) throw new Erro(404, 'nao_encontrado', 'Pedido não encontrado. Confira o link.');
    const emRota = ['atribuida', 'coletada'].includes(d.status);
    let motoboy = null;
    let paradasAntes = null;
    if (emRota && d.turno_id) {
      const turno = q('SELECT * FROM turnos WHERE id = ?').get(d.turno_id);
      const m = q('SELECT nome, veiculo FROM motoboys WHERE id = ?').get(d.motoboy_id);
      const ver = cfgBruta().rastreio_cliente === '1' && turno?.ult_lat != null;
      motoboy = {
        nome: m.nome.split(/\s+/)[0], veiculo: m.veiculo,
        lat: ver ? turno.ult_lat : null, lon: ver ? turno.ult_lon : null, ult_ts: ver ? turno.ult_ts : null,
      };
      const alvo = d.status === 'atribuida' ? 'coleta' : 'entrega';
      paradasAntes = rotaDoTurno(d.turno_id).findIndex((p) => p.demanda_id === d.id && p.tipo === alvo);
    }
    return {
      agora: agora(), empresa: cfgBruta().empresa_nome,
      id: d.id, status: d.status, retida: Boolean(d.retida), descricao: d.descricao, valor: d.valor, km: d.km,
      servico: d.servico, urgente: Boolean(d.urgente), prazo_min: Number(cfgBruta().urgente_prazo_min),
      pagamento: d.pagamento,
      pix: d.pagamento === 'pendente' && d.status !== 'cancelada' ? {
        codigo: d.pag_pix, qr: d.pag_qr, expira: d.pag_expira,
        // Pix na chave da empresa: o cliente manda o comprovante e a equipe confirma.
        manual: !d.pag_id, whatsapp: cfgBruta().empresa_whatsapp, comprovante: d.comprovante_em != null,
      } : null,
      coleta: { endereco: d.coleta_endereco, lat: d.coleta_lat, lon: d.coleta_lon },
      entrega: { endereco: d.entrega_endereco, lat: d.entrega_lat, lon: d.entrega_lon },
      criada_em: d.criada_em, atribuida_em: d.atribuida_em, coletada_em: d.coletada_em,
      entregue_em: d.entregue_em, cancelada_em: d.cancelada_em, recebedor: d.recebedor,
      motoboy, paradas_antes: paradasAntes,
    };
  }

  // Quem convocar: demandas sem ninguém em turno que atenda -> rodízio (quem está há mais tempo sem diária).
  function sugestoes(motoboys, demandas, c) {
    const fila = demandas.filter((d) => d.status === 'aguardando' && !d.retida);
    if (!fila.length) return [];
    const emTurnoOuChamado = motoboys.filter((m) => m.ativo && (m.turno || m.convocado_ate));
    const livres = motoboys
      .filter((m) => m.ativo && m.tipo === 'diaria' && !m.turno && !m.convocado_ate)
      .sort((a, b) => (a.ultimo_turno ?? 0) - (b.ultimo_turno ?? 0));
    const escolhidos = new Map();
    for (const d of fila) {
      const cobertas = [...escolhidos.values()].filter((s) => s.demandas.length < c.capacidade);
      const jaCobre = cobertas.find((s) => atende(s.motoboy, d, c));
      if (jaCobre) { jaCobre.demandas.push(d.id); continue; }
      // Alguém já chamado/online atende? Então é só questão de fila, não de convocar.
      if (emTurnoOuChamado.some((m) => atende(m, d, c) && (!m.turno || m.turno.pendentes < c.capacidade * 2))) continue;
      const m = livres.find((x) => !escolhidos.has(x.id) && atende(x, d, c));
      if (m) escolhidos.set(m.id, { motoboy: m, demandas: [d.id] });
    }
    return [...escolhidos.values()].map((s) => ({
      motoboy_id: s.motoboy.id, nome: s.motoboy.nome, telefone: s.motoboy.telefone, demandas: s.demandas,
    }));
  }

  function trilha(turnoId) {
    const turno = q('SELECT * FROM turnos WHERE id = ?').get(turnoId);
    if (!turno) throw new Erro(404, 'nao_encontrado', 'Turno não encontrado.');
    return {
      turno: { id: turno.id, inicio: turno.inicio, fim_previsto: turno.fim_previsto, fim_real: turno.fim_real, km: turno.km },
      pontos: q('SELECT ts, lat, lon, falso FROM posicoes WHERE turno_id = ? ORDER BY ts').all(turnoId),
      alertas: q('SELECT tipo, inicio, fim, detalhe FROM alertas WHERE turno_id = ? ORDER BY inicio').all(turnoId),
    };
  }

  function relatorio(de, ate) {
    const c = cfgBruta();
    const porDiaria = Number(c.diaria_valor) + Number(c.almoco_valor);
    const linhas = q(`
      SELECT m.id AS motoboy_id, m.nome,
        COALESCE(SUM(t.tipo = 'diaria'), 0) AS diarias,
        (SELECT COALESCE(SUM(d.repasse), 0) FROM demandas d JOIN turnos t5 ON t5.id = d.turno_id
          WHERE t5.motoboy_id = m.id AND t5.tipo = 'avulso' AND d.status = 'entregue' AND t5.inicio >= ? AND t5.inicio < ?) AS repasses,
        COALESCE(SUM(COALESCE(t.fim_real, ?) - t.inicio), 0) AS ms_turno,
        COALESCE(SUM(t.km), 0) AS km,
        (SELECT COUNT(*) FROM demandas d JOIN turnos t2 ON t2.id = d.turno_id
          WHERE t2.motoboy_id = m.id AND d.status = 'entregue' AND t2.inicio >= ? AND t2.inicio < ?) AS entregas,
        (SELECT COALESCE(SUM(COALESCE(a.fim, ?) - a.inicio), 0) FROM alertas a JOIN turnos t3 ON t3.id = a.turno_id
          WHERE t3.motoboy_id = m.id AND a.tipo = 'parado' AND t3.inicio >= ? AND t3.inicio < ?) AS ms_parado,
        (SELECT COUNT(*) FROM alertas a JOIN turnos t4 ON t4.id = a.turno_id
          WHERE t4.motoboy_id = m.id AND t4.inicio >= ? AND t4.inicio < ?) AS alertas
      FROM motoboys m JOIN turnos t ON t.motoboy_id = m.id
      WHERE t.inicio >= ? AND t.inicio < ?
      GROUP BY m.id ORDER BY m.nome`).all(de, ate, agora(), de, ate, agora(), de, ate, de, ate, de, ate);
    return linhas.map((l) => ({
      motoboy_id: l.motoboy_id,
      nome: l.nome,
      diarias: l.diarias,
      horas: Math.round((l.ms_turno / 3_600_000) * 10) / 10,
      km: Math.round(l.km * 10) / 10,
      entregas: l.entregas,
      min_parado: Math.round(l.ms_parado / MIN),
      alertas: l.alertas,
      repasses: Math.round(l.repasses * 100) / 100,
      valor: Math.round((l.diarias * porDiaria + l.repasses) * 100) / 100,
    }));
  }
  // Cada entrega concluída: quanto o cliente pagou, quanto vai para o motoboy avulso e o que fica.
  function relatorioEntregas(de, ate) {
    return q(`SELECT d.id, d.entregue_em, d.cliente, d.servico, d.km, d.valor, d.pagamento, m.nome AS motoboy, t.tipo,
        CASE WHEN t.tipo = 'avulso' THEN COALESCE(d.repasse, 0) ELSE 0 END AS repasse
      FROM demandas d LEFT JOIN turnos t ON t.id = d.turno_id LEFT JOIN motoboys m ON m.id = d.motoboy_id
      WHERE d.status = 'entregue' AND d.entregue_em >= ? AND d.entregue_em < ?
      ORDER BY d.entregue_em DESC LIMIT 2000`).all(de, ate)
      .map((l) => ({ ...l, margem: l.valor == null ? null : Math.round((l.valor - l.repasse) * 100) / 100 }));
  }

  // Entregas concluídas no período, somadas por cliente (para cobrar).
  function relatorioClientes(de, ate) {
    return q(`SELECT cliente, cliente_telefone AS telefone, COUNT(*) AS entregas,
        COALESCE(SUM(km), 0) AS km, COALESCE(SUM(valor), 0) AS valor
      FROM demandas WHERE status = 'entregue' AND entregue_em >= ? AND entregue_em < ?
      GROUP BY cliente, cliente_telefone ORDER BY valor DESC, entregas DESC`).all(de, ate)
      .map((l) => ({ ...l, km: Math.round(l.km * 10) / 10, valor: Math.round(l.valor * 100) / 100 }));
  }

  // ------------------------------------------- conversas do WhatsApp
  // Importa a conversa exportada. Reimportar a mesma conversa só acrescenta o que é novo.
  function importarWhatsapp({ arquivo, conteudo }, ator) {
    const buf = Buffer.from(String(conteudo || ''), 'base64');
    if (!buf.length) throw new Erro(422, 'arquivo_vazio', 'Arquivo vazio.');
    let texto;
    try {
      texto = buf.readUInt32LE(0) === 0x04034b50 ? textoDoZip(buf) : buf.toString('utf8');
    } catch (e) {
      throw new Erro(422, 'arquivo_invalido', `Não consegui abrir o arquivo: ${e.message}.`);
    }
    const lista = lerConversa(texto);
    if (!lista.length) {
      throw new Erro(422, 'sem_mensagens', 'Não achei mensagens. Use "Exportar conversa" do WhatsApp e envie o .txt ou o .zip.');
    }
    const nome = nomeDaConversa(arquivo);
    return tx(() => {
      const t = agora();
      q(`INSERT INTO conversas (nome, criada_em, atualizada_em) VALUES (?,?,?)
         ON CONFLICT(nome) DO UPDATE SET atualizada_em = excluded.atualizada_em`).run(nome, t, t);
      const conversa = q('SELECT id FROM conversas WHERE nome = ?').get(nome);
      const inserir = q('INSERT OR IGNORE INTO mensagens (conversa_id, ts, autor, texto) VALUES (?,?,?,?)');
      let novas = 0;
      for (const m of lista) novas += inserir.run(conversa.id, m.ts, m.autor ?? '', m.texto).changes;
      auditar(ator, 'whatsapp_importado', `${nome}: ${novas} nova(s)`);
      return { conversa_id: conversa.id, nome, lidas: lista.length, novas };
    });
  }
  function listarConversas() {
    return q(`SELECT c.id, c.nome, c.atualizada_em, c.telefone, c.humano, c.pendente, c.pausa_ate, COUNT(m.id) AS total,
        MIN(m.ts) AS primeira, MAX(m.ts) AS ultima, COUNT(m.demanda_id) AS demandas
      FROM conversas c LEFT JOIN mensagens m ON m.conversa_id = c.id
      GROUP BY c.id ORDER BY c.pendente DESC, c.atualizada_em DESC LIMIT 300`).all();
  }
  function mensagensDaConversa(conversaId, busca = '') {
    const termo = `%${String(busca).trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return q(`SELECT id, ts, autor, texto, demanda_id, direcao FROM mensagens
      WHERE conversa_id = ? AND (texto LIKE ? ESCAPE '\\' OR autor LIKE ? ESCAPE '\\')
      ORDER BY ts DESC, id DESC LIMIT 500`).all(conversaId, termo, termo);
  }
  function excluirConversa(conversaId, ator) {
    const c = q('SELECT nome FROM conversas WHERE id = ?').get(conversaId);
    if (!c) throw new Erro(404, 'nao_encontrado', 'Conversa não encontrada.');
    tx(() => {
      q('DELETE FROM mensagens WHERE conversa_id = ?').run(conversaId);
      q('DELETE FROM conversas WHERE id = ?').run(conversaId);
      auditar(ator, 'whatsapp_excluido', c.nome);
    });
  }

  // Convocação automática: demanda esperando e ninguém em turno que atenda -> chama o próximo do rodízio.
  function convocarSozinho(t) {
    const c = cfgBruta();
    if (c.convocacao_auto !== '1' || foraDoHorario()) return;
    const hoje = inicioDoDia();
    let feitas = q("SELECT COUNT(*) AS n FROM convocacoes WHERE origem = 'auto' AND criada_em >= ?").get(hoje).n;
    const limite = Number(c.convocacao_auto_max);
    if (feitas >= limite) return;
    const estado = estadoAdmin();
    const espera = Number(c.convocacao_auto_espera_min) * MIN;
    for (const s of estado.sugestoes) {
      if (feitas >= limite) break;
      const maisAntiga = Math.min(...estado.demandas.filter((d) => s.demandas.includes(d.id)).map((d) => d.criada_em));
      if (t - maisAntiga < espera) continue;
      convocar(s.motoboy_id, 'sistema', 'auto');
      feitas++;
    }
  }

  // ------------------------------------------------ rotina (a cada 30 s)
  let ultimaLimpeza = 0;
  function rotina() {
    const c = cfg();
    const t = agora();
    for (const turno of q('SELECT * FROM turnos WHERE fim_real IS NULL').all()) {
      if (t >= turno.fim_previsto) {
        const comCarga = q("SELECT COUNT(*) AS n FROM demandas WHERE turno_id = ? AND status = 'coletada'").get(turno.id).n;
        if (!comCarga) { encerrarTurno(turno.id, 'fim_do_turno'); continue; }
        if (t >= turno.fim_previsto + c.prorrogacaoMs) { encerrarTurno(turno.id, 'tempo_esgotado_com_carga'); continue; }
        // Prorrogado só para terminar o que já coletou; o resto volta para a fila.
        if (tx(() => devolverNaoColetadas(turno.id))) despacharPendentes();
      }
      if (emAlmoco(turno) && t >= turno.almoco_inicio + c.almocoMs) {
        q('UPDATE turnos SET almoco_fim = ?, ancora_ts = ? WHERE id = ?').run(t, t, turno.id);
      }
      const contato = turno.ult_contato ?? turno.inicio;
      // Avulso que fechou o app sem encerrar: sai sozinho depois de um tempo sem sinal (se não tiver entrega aberta).
      if (turno.tipo === 'avulso' && t - contato > SEM_SINAL_AVULSO && abertasDoTurno(turno.id) === 0) {
        encerrarTurno(turno.id, 'avulso_sem_sinal');
        continue;
      }
      if (t - contato > c.semSinalMs && (turno.tipo !== 'avulso' || abertasDoTurno(turno.id) > 0)) {
        abrirAlerta(turno, 'sem_sinal', 'Aparelho sem contato: app fechado, sem internet ou desligado.', contato);
      }
    }
    convocarSozinho(t);
    q('DELETE FROM sessoes WHERE expira_em <= ?').run(t);
    if (t - ultimaLimpeza > 6 * 60 * MIN) {
      ultimaLimpeza = t;
      q('DELETE FROM posicoes WHERE ts < ?').run(t - c.retencaoMs);
    }
  }

  return {
    cfg, lerConfig, salvarConfig, gerarChaveApi, chaveApiValida,
    garantirAdmin, loginAdmin, autenticarAdmin, sairAdmin, trocarSenhaAdmin,
    criarMotoboy, atualizarMotoboy, candidatar, decidirCandidato, convocar, cancelarConvocacao,
    loginMotoboy, autenticarMotoboy, almoco, encerrarTurno, registrarPosicoes,
    criarDemanda, criarDemandaExterna, definirLocais, cancelarDemanda, reatribuir, confirmarParada,
    despacharPendentes, estadoMotoboy, estadoAdmin, trilha, relatorio, rotina,
    importarWhatsapp, listarConversas, mensagensDaConversa, excluirConversa,
    aoEvento, cotar, foraDoHorario, criarPedido, liberarDemanda, fecharPedido, definirContato, pedidoPublico, relatorioClientes, relatorioEntregas,
    listarServicos, salvarServico, listarClientes, salvarCliente, registrarPix, marcarPago,
    responderOferta, encerrarPeloMotoboy, modoPagamento,
    interno: { q, tx, cfgBruta, auditar, agora, exigirNaoBloqueado, registrarFalha },
    termo: () => ({ versao: cfgBruta().termo_versao, texto: cfgBruta().termo_texto }),
    cidadeBase: () => cfgBruta().cidade_base,
  };
}
