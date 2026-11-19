import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY,
  usuario TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  criado_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS motoboys (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  veiculo TEXT NOT NULL CHECK (veiculo IN ('moto','bike')),
  tem_bau INTEGER NOT NULL DEFAULT 0,
  tem_bag INTEGER NOT NULL DEFAULT 0,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS convocacoes (
  id INTEGER PRIMARY KEY,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys(id),
  criada_em INTEGER NOT NULL,
  valida_ate INTEGER NOT NULL,
  usada_em INTEGER,
  cancelada_em INTEGER
);
CREATE INDEX IF NOT EXISTS idx_convocacoes_motoboy ON convocacoes(motoboy_id, valida_ate);
CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY,
  motoboy_id INTEGER NOT NULL REFERENCES motoboys(id),
  inicio INTEGER NOT NULL,
  fim_previsto INTEGER NOT NULL,
  fim_real INTEGER,
  motivo_fim TEXT,
  termo_versao TEXT NOT NULL,
  termo_aceito_em INTEGER NOT NULL,
  dispositivo TEXT,
  origem TEXT NOT NULL DEFAULT 'app',
  almoco_inicio INTEGER,
  almoco_fim INTEGER,
  ancora_lat REAL, ancora_lon REAL, ancora_ts INTEGER,
  ult_lat REAL, ult_lon REAL, ult_ts INTEGER, ult_precisao REAL,
  ult_contato INTEGER,
  bateria INTEGER,
  km REAL NOT NULL DEFAULT 0,
  rota_versao INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turnos_ativos ON turnos(fim_real, motoboy_id);
CREATE INDEX IF NOT EXISTS idx_turnos_inicio ON turnos(inicio);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('admin','motoboy')),
  ref_id INTEGER NOT NULL,
  criada_em INTEGER NOT NULL,
  expira_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS posicoes (
  id INTEGER PRIMARY KEY,
  turno_id INTEGER NOT NULL REFERENCES turnos(id),
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  precisao REAL,
  velocidade REAL,
  falso INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posicoes_turno ON posicoes(turno_id, ts);
CREATE INDEX IF NOT EXISTS idx_posicoes_ts ON posicoes(ts);
CREATE TABLE IF NOT EXISTS demandas (
  id INTEGER PRIMARY KEY,
  cliente TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  requisito TEXT NOT NULL DEFAULT 'qualquer',
  origem TEXT NOT NULL DEFAULT 'painel',
  coleta_endereco TEXT NOT NULL, coleta_lat REAL, coleta_lon REAL, coleta_contato TEXT NOT NULL DEFAULT '',
  entrega_endereco TEXT NOT NULL, entrega_lat REAL, entrega_lon REAL, entrega_contato TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sem_local','aguardando','atribuida','coletada','entregue','cancelada')),
  motoboy_id INTEGER REFERENCES motoboys(id),
  turno_id INTEGER REFERENCES turnos(id),
  ordem_coleta INTEGER NOT NULL DEFAULT 0,
  ordem_entrega INTEGER NOT NULL DEFAULT 0,
  criada_em INTEGER NOT NULL,
  atribuida_em INTEGER, coletada_em INTEGER, entregue_em INTEGER, cancelada_em INTEGER,
  coleta_dist_m INTEGER, entrega_dist_m INTEGER,
  coleta_justificativa TEXT, entrega_justificativa TEXT,
  recebedor TEXT
);
CREATE INDEX IF NOT EXISTS idx_demandas_status ON demandas(status);
CREATE INDEX IF NOT EXISTS idx_demandas_turno ON demandas(turno_id);
CREATE INDEX IF NOT EXISTS idx_demandas_criada ON demandas(criada_em);
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY,
  turno_id INTEGER NOT NULL REFERENCES turnos(id),
  motoboy_id INTEGER NOT NULL REFERENCES motoboys(id),
  tipo TEXT NOT NULL,
  inicio INTEGER NOT NULL,
  fim INTEGER,
  detalhe TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_alertas_turno ON alertas(turno_id, tipo, fim);
CREATE INDEX IF NOT EXISTS idx_alertas_inicio ON alertas(inicio);
CREATE TABLE IF NOT EXISTS conversas (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  criada_em INTEGER NOT NULL,
  atualizada_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY,
  conversa_id INTEGER NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  autor TEXT NOT NULL DEFAULT '', -- vazio = aviso do sistema
  texto TEXT NOT NULL,
  demanda_id INTEGER REFERENCES demandas(id),
  UNIQUE (conversa_id, ts, autor, texto)
);
CREATE INDEX IF NOT EXISTS idx_mensagens_conversa ON mensagens(conversa_id, ts);
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY,
  telefone TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL DEFAULT '',
  criado_em INTEGER NOT NULL,
  pedidos INTEGER NOT NULL DEFAULT 0,
  ult_endereco TEXT, ult_lat REAL, ult_lon REAL
);
-- Fila de mensagens de WhatsApp a enviar (avisos, convocação, respostas do robô).
CREATE TABLE IF NOT EXISTS saida (
  id INTEGER PRIMARY KEY,
  destino TEXT NOT NULL,
  texto TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT '',
  criada_em INTEGER NOT NULL,
  proxima_em INTEGER NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  enviada_em INTEGER,
  erro TEXT
);
CREATE INDEX IF NOT EXISTS idx_saida_pendente ON saida(enviada_em, proxima_em);
-- Tipos de serviço (complexidade da demanda): cada um soma um valor ao preço.
CREATE TABLE IF NOT EXISTS servicos (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  adicional REAL NOT NULL DEFAULT 0,
  repasse_pct REAL,
  ativo INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0
);
-- Oferta de uma demanda a um motoboy online e perto: o primeiro que aceitar leva.
CREATE TABLE IF NOT EXISTS ofertas (
  id INTEGER PRIMARY KEY,
  demanda_id INTEGER NOT NULL REFERENCES demandas(id),
  turno_id INTEGER NOT NULL REFERENCES turnos(id),
  criada_em INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','aceita','recusada','encerrada')),
  respondida_em INTEGER,
  dist_km REAL,
  UNIQUE (demanda_id, turno_id)
);
CREATE INDEX IF NOT EXISTS idx_ofertas_turno ON ofertas(turno_id, status);
-- Análises feitas pela IA em fotos, PDFs e conversas (só o resultado; o arquivo não é guardado).
CREATE TABLE IF NOT EXISTS analises (
  id INTEGER PRIMARY KEY,
  criada_em INTEGER NOT NULL,
  ator TEXT NOT NULL,
  titulo TEXT NOT NULL,
  pergunta TEXT NOT NULL DEFAULT '',
  resultado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidatos (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL,
  documento TEXT NOT NULL DEFAULT '',
  placa TEXT NOT NULL DEFAULT '',
  veiculo TEXT NOT NULL DEFAULT 'moto',
  tem_bau INTEGER NOT NULL DEFAULT 0,
  tem_bag INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL DEFAULT 'avulso',
  indicacao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendente',
  motoboy_id INTEGER,
  criado_em INTEGER NOT NULL,
  decidido_em INTEGER
);
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ator TEXT NOT NULL,
  acao TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT ''
);
`;

export const TERMO_PADRAO = `TERMO DE CIÊNCIA E CONSENTIMENTO — SPEEDBOY

1. Ao iniciar o turno neste aplicativo, declaro que estou disponível para atender as demandas da Speedboy durante todo o período do turno.

2. Estou ciente e autorizo que minha localização seja coletada em tempo real, inclusive com o aplicativo em segundo plano ou com a tela apagada, SOMENTE enquanto o turno estiver ativo. A coleta para sozinha quando o turno termina.

3. A localização é usada para: enviar a demanda ao entregador mais próximo, acompanhar a rota, registrar coletas e entregas e dar segurança à operação.

4. O sistema registra paradas prolongadas durante a rota, perda de sinal, GPS desligado, uso de localização falsa e confirmações feitas longe do local de coleta ou entrega.

5. Os dados são acessados pela administração da Speedboy; durante uma entrega, o cliente daquele pedido pode ver no mapa onde está o entregador. Os dados são apagados após o prazo de guarda definido pela empresa. Posso pedir à Speedboy acesso aos meus dados ou a exclusão deles.

6. Durante o turno devo manter GPS, internet e o aplicativo ligados. Tenho direito a um intervalo de almoço, registrado pelo próprio aplicativo.`;

export const CONFIG_PADRAO = {
  horas_turno: '8',
  prorrogacao_max_min: '120',
  parado_min: '8',
  espera_parada_min: '20',
  sem_sinal_min: '3',
  cerca_m: '150',
  bike_max_km: '5',
  capacidade: '4',
  retencao_dias: '90',
  diaria_valor: '0',
  almoco_valor: '0',
  almoco_min: '60',
  cidade_base: '',
  mapa_lat: '-23.5505',
  mapa_lon: '-46.6333',
  termo_versao: '1',
  termo_texto: TERMO_PADRAO,
  api_chave_hash: '',
  empresa_nome: 'SpeedBoy',
  url_publica: '',
  // Preço mostrado ao cliente (site e robô). Tudo zero = "a combinar".
  preco_base: '0',
  preco_km_incluso: '0',
  preco_km: '0',
  preco_minimo: '0',
  // Acréscimo ao cliente quando a coleta ou a entrega cai na zona sul de Vila Velha (o motoboy não recebe).
  preco_zona_sul: '15',
  // Tarifa urgente (chave do site): % a mais sobre o valor, com mínimo em R$; parte do extra que vai ao motoboy.
  urgente_pct: '20',
  urgente_min: '10',
  urgente_repasse_pct: '70',
  // Tamanho da mercadoria: % a mais para G (até 40 cm) e GG (mais de 40 cm); parte do extra que vai ao motoboy.
  tam_g_pct: '10',
  tam_gg_pct: '20',
  tam_repasse_pct: '60',
  // Corrida longa (coleta → entrega): acima de cada limite, o km inteiro paga o valor da faixa;
  // o motoboy avulso leva um % do valor total da corrida.
  longa_km1: '30',
  longa_preco1: '2.8',
  longa_km2: '50',
  longa_preco2: '3',
  longa_repasse_pct: '70',
  // Pedido pelo site: 'painel' (admin aprova), 'whatsapp' (cliente confirma no WhatsApp) ou 'nenhuma'.
  pedidos_site: '1',
  site_confirmacao: 'painel',
  rastreio_cliente: '0',
  atendimento_inicio: '',
  atendimento_fim: '',
  // WhatsApp automático: '' (desligado), 'meta' (Cloud API oficial) ou 'webhook' (n8n/Make ligado a provedor oficial).
  whats_provedor: '',
  whats_url: '',
  whats_instancia: '',
  whats_token: '',
  whats_segredo: '',
  whats_app_secret: '', // App Secret da Meta: confere a assinatura de cada aviso
  robo_pausa_horas: '12', // coexistência: o robô fica calado na conversa que a empresa respondeu pelo app
  robo_ativo: '1',
  avisos_cliente: '1',
  admin_telefone: '',
  convocacao_auto: '0',
  // Diária só entra no dia em que for convocada? '0' = entra quando quiser (como o avulso, mas com turno fixo).
  convocacao_obrigatoria: '0',
  convocacao_auto_max: '3',
  convocacao_auto_espera_min: '3',
  // Entrega urgente: prazo prometido na página, repasse ao motoboy avulso e ofertas.
  urgente_prazo_min: '30',
  repasse_pct: '60',
  repasse_minimo: '15',
  repasse_base: '0',
  repasse_km: '0',
  oferta_raio_km: '5',
  oferta_alerta_min: '5',
  avulso_max_horas: '12',
  // Pix pelo Mercado Pago (token secreto) e rota real pelas ruas (OpenRouteService, opcional).
  mp_token: '',
  pagamento_validade_min: '30',
  ors_chave: '',
  google_chave: '',
  // Pix direto na conta da empresa (sem taxa de intermediário; confirmação manual pelo comprovante).
  pix_tipo: 'cnpj',
  pix_chave: '',
  pix_nome: '',
  pix_cidade: '',
  empresa_whatsapp: '',
  // Conferência dos pedidos por IA (Claude). Sem chave, fica desligada.
  ia_ativa: '1',
  ia_chave: '',
  ia_modelo: 'claude-opus-5-5',
  cidades_atendidas: 'Vila Velha, Vitória, Serra, Cariacica, Viana',
};

const SERVICOS_PADRAO = [
  'Entrega de documento ou encomenda', 'Ida e volta (leva e traz)', 'Cartório ou protocolo',
  'Xerox ou impressão + entrega', 'Visita ou vistoria com fotos', 'Compra e entrega',
];

// Colunas acrescentadas depois da primeira versão (o banco em produção já existe).
const COLUNAS_NOVAS = {
  demandas: {
    codigo: 'TEXT', cliente_telefone: "TEXT NOT NULL DEFAULT ''", valor: 'REAL', km: 'REAL',
    retida: 'INTEGER NOT NULL DEFAULT 0',
    urgente: 'INTEGER NOT NULL DEFAULT 0', servico: "TEXT NOT NULL DEFAULT ''", repasse: 'REAL', repasse_padrao: 'REAL', bonus_urgente: 'REAL', repasse_manual: 'INTEGER NOT NULL DEFAULT 0', tamanho: "TEXT NOT NULL DEFAULT ''", tarifa_urgente: 'INTEGER NOT NULL DEFAULT 0', agendada_para: 'INTEGER', reservada_por: 'INTEGER',
    pagamento: "TEXT NOT NULL DEFAULT ''", pag_id: 'TEXT', pag_pix: 'TEXT', pag_qr: 'TEXT', pag_expira: 'INTEGER',
    pago_em: 'INTEGER', fila_em: 'INTEGER', comprovante_em: 'INTEGER', ia_ok: 'INTEGER', ia_obs: 'TEXT', email: "TEXT NOT NULL DEFAULT ''", sem_aceite_avisado: 'INTEGER NOT NULL DEFAULT 0',
  },
  motoboys: { tipo: "TEXT NOT NULL DEFAULT 'diaria'", pin_claro: 'TEXT', documento: "TEXT NOT NULL DEFAULT ''", placa: "TEXT NOT NULL DEFAULT ''", diaria_valor: 'REAL', repasse_base: 'REAL', repasse_km: 'REAL', ve_valores: 'INTEGER NOT NULL DEFAULT 0', reserva_bloqueio_ate: 'INTEGER' },
  turnos: { tipo: "TEXT NOT NULL DEFAULT 'diaria'" },
  clientes: { faturado: 'INTEGER NOT NULL DEFAULT 0', preco_pct: 'REAL NOT NULL DEFAULT 100', email: "TEXT NOT NULL DEFAULT ''" },
  convocacoes: { origem: "TEXT NOT NULL DEFAULT 'admin'" },
  conversas: {
    telefone: 'TEXT', destino: 'TEXT', etapa: "TEXT NOT NULL DEFAULT ''", dados: "TEXT NOT NULL DEFAULT '{}'",
    humano: 'INTEGER NOT NULL DEFAULT 0', pendente: 'INTEGER NOT NULL DEFAULT 0', etapa_em: 'INTEGER',
    pausa_ate: 'INTEGER',
  },
  saida: { msg_id: 'TEXT' },
  mensagens: { direcao: "TEXT NOT NULL DEFAULT ''" },
};

function migrar(db) {
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    for (const [nome, tipo] of Object.entries(colunas)) {
      if (!existentes.has(nome)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`);
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demandas_codigo ON demandas(codigo) WHERE codigo IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_demandas_telefone ON demandas(cliente_telefone, criada_em);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversas_telefone ON conversas(telefone) WHERE telefone IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_saida_msg ON saida(msg_id) WHERE msg_id IS NOT NULL;
  `);
  // Conexão pelo WhatsApp Web (Evolution) foi removida: quem estava nela fica desligado.
  db.exec("UPDATE config SET valor = '' WHERE chave = 'whats_provedor' AND valor = 'evolution'");
}

export function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(arquivo)), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(ESQUEMA);
  migrar(db);
  const inserir = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
  for (const [chave, valor] of Object.entries(CONFIG_PADRAO)) inserir.run(chave, valor);
  if (db.prepare('SELECT COUNT(*) AS n FROM servicos').get().n === 0) {
    const novo = db.prepare('INSERT INTO servicos (nome, ordem) VALUES (?, ?)');
    SERVICOS_PADRAO.forEach((nome, i) => novo.run(nome, i));
  }
  return db;
}
