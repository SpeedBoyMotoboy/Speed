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

5. Os dados são acessados apenas pela administração da Speedboy e apagados após o prazo de guarda definido pela empresa. Posso pedir à Speedboy acesso aos meus dados ou a exclusão deles.

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
};

export function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(arquivo)), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(ESQUEMA);
  const inserir = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
  for (const [chave, valor] of Object.entries(CONFIG_PADRAO)) inserir.run(chave, valor);
  return db;
}
