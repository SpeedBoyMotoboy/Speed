// Ponto de entrada. Configuração por variáveis de ambiente (ver README).
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const { abrirBanco } = await import('./db.js');
const { criarServico } = await import('./servico.js');
const { criarApp } = await import('./app.js');
const { geocodificar } = await import('./geo.js');
const { senhaAleatoria } = await import('./auth.js');

const PORTA = Number(process.env.PORT || 3000);
const DADOS = process.env.DADOS_DIR || './dados';
const producao = process.env.NODE_ENV === 'production';

const db = abrirBanco(`${DADOS}/speed.db`);
const servico = criarServico({ db, geocodificar });

const usuario = (process.env.ADMIN_USER || 'admin').toLowerCase();
const senhaInicial = process.env.ADMIN_PASSWORD || senhaAleatoria();
if (servico.garantirAdmin(usuario, senhaInicial)) {
  console.log('==============================================================');
  console.log(' Primeiro acesso ao painel');
  console.log(`   usuário: ${usuario}`);
  console.log(process.env.ADMIN_PASSWORD ? '   senha: a definida em ADMIN_PASSWORD' : `   senha: ${senhaInicial}`);
  console.log(' Troque a senha em Configurações depois de entrar.');
  console.log('==============================================================');
}

const app = criarApp({
  servico,
  geocodificar,
  confiarProxy: process.env.TRUST_PROXY === '1',
  cookieSeguro: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : producao,
});

const rotina = setInterval(() => {
  try { servico.rotina(); } catch (e) { console.error('[rotina]', e); }
}, 30_000);

app.listen(PORTA, () => console.log(`Speed Despacho em http://localhost:${PORTA}`));

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    clearInterval(rotina);
    app.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
