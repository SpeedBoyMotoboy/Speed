#!/usr/bin/env python3
# Paleta oficial SpeedBoy (verde #333F22, ouro #D4A017, azul #002776, preto #1A1A1A) + tema claro/escuro no app do motoboy.
import pathlib, sys
R = pathlib.Path('/opt/speed-src/server/public')
def troca(arq, velho, novo, obrig=True):
    p = R / arq; t = p.read_text(encoding='utf-8')
    if t.count(velho) != 1:
        if obrig: sys.exit(f'FALHA {arq}: {t.count(velho)}x {velho[:70]!r}')
        print('PULEI:', arq, velho[:40]); return
    p.write_text(t.replace(velho, novo), encoding='utf-8'); print('ok:', arq, velho[:34])

# ---------- app do motoboy
C = 'app/app.css'
troca(C, "--marca: #001f6b; --destaque: #ff5400;", "--marca: #333F22; --acao: #002776; --destaque: #D4A017; --forte: #002776; --fundo: #f4f4ef; --cartao: #ffffff; --sutil: #eef0ea; --no-ouro: #1A1A1A;")
troca(C, "--texto: #16181d;", "--texto: #1A1A1A;")
troca(C, "--coleta: #001f6b; --entrega: #ff5400;", "--coleta: #002776; --entrega: #333F22;")
p = R / C; t = p.read_text(encoding='utf-8')
if 'tema claro e escuro' not in t:
    t += """
/* 19/11: paleta oficial SpeedBoy + tema claro e escuro */
body { background: var(--fundo); }
button { background: var(--cartao); }
button.primario { background: var(--acao); border-color: var(--acao); color: #fff; }
input, textarea, .cartao, .termo { background: var(--cartao); color: var(--texto); }
.info-botao, .speedy { background: var(--sutil); }
.speedy { border-left-color: var(--destaque); }
.etiqueta.oferta { background: var(--destaque); color: var(--no-ouro); }
.tempo, .previsao { color: var(--forte); }
.prazo { background: #b91c1c; color: #fff; }
.topo { position: relative; }
button.tema { position: absolute; right: 12px; top: calc(10px + env(safe-area-inset-top)); width: auto; min-height: 36px; padding: 6px 12px; font-size: 13px; font-weight: 600; background: transparent; color: #fff; border: 1px solid var(--destaque); border-radius: 999px; }
:root[data-tema="escuro"] {
  --texto: #f3f3f0; --suave: #b9bbb4; --borda: #44463f; --fundo: #1A1A1A; --cartao: #262724; --sutil: #33352f;
  --forte: #D4A017; --ok: #4ade80; --erro: #f87171; --aviso: #fbbf24;
}
:root[data-tema="escuro"] button.primario, :root[data-tema="escuro"] button.coleta, :root[data-tema="escuro"] button.entrega,
:root[data-tema="escuro"] .etiqueta.coleta, :root[data-tema="escuro"] .etiqueta.entrega, :root[data-tema="escuro"] .pino { border: 1px solid var(--destaque); }
:root[data-tema="escuro"] .faixa.ok { background: #14331f; }
:root[data-tema="escuro"] .faixa.ruim { background: #3f1717; }
:root[data-tema="escuro"] .faixa.aviso { background: #3b2a0a; }
:root[data-tema="escuro"] .etiqueta.rota { color: #10240f; }
"""
    p.write_text(t, encoding='utf-8'); print('ok: app.css')

A = 'app/app.js'
troca(A, "let token = localStorage.getItem(CHAVE_TOKEN);", r"""let token = localStorage.getItem(CHAVE_TOKEN);

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
aplicarTema();""")
troca(A, "      h('div', { class: 'nome' }, motoboy.nome),", "      botaoTema(desenharTurno),\n      h('div', { class: 'nome' }, motoboy.nome),")
p = R / 'app/index.html'; t = p.read_text(encoding='utf-8')
p.write_text(t.replace('content="#001f6b"', 'content="#333F22"'), encoding='utf-8'); print('ok: index app')

# ---------- páginas públicas do Speedy (loja, pedir, acompanhar, cadastro)
troca('site/site.css', "--marca: #001f6b; --destaque: #ff5400;", "--marca: #002776; --destaque: #D4A017;")
troca('site/site.css', "--texto: #0d0d0d;", "--texto: #1A1A1A;", obrig=False)
troca('loja/loja.css', "button.primario, a.botao.primario { background: var(--destaque); border-color: var(--destaque); }",
      "button.primario, a.botao.primario { background: var(--destaque); border-color: var(--destaque); color: #1A1A1A; }")
troca('loja/loja.css', "background: #16a34a; color: #fff; font-size: 34px;", "background: #333F22; color: #fff; font-size: 34px;")
p = R / 'loja/loja.css'; t = p.read_text(encoding='utf-8')
t = t.replace('border: 4px solid #d4a017', 'border: 4px solid #D4A017')
if 'paleta oficial' not in t:
    t += "/* paleta oficial: topo verde, destaque ouro, ações em azul */\n.topo { background: #333F22; }\n.linha-mais { color: #333F22; }\n"
p.write_text(t, encoding='utf-8')
for arq in ['loja/index.html', 'pedir/index.html', 'acompanhar/index.html', 'cadastro/index.html']:
    q = R / arq
    if q.exists():
        s = q.read_text(encoding='utf-8')
        q.write_text(s.replace('content="#001f6b"', 'content="#002776"'), encoding='utf-8')
print('FIM')
