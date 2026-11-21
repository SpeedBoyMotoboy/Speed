// Link que a loja manda ao cliente: ele completa os dados da entrega, escolhe rota ou urgente e paga o frete.
// A retirada e as mercadorias vêm da loja e não mudam aqui. Depois de pedir, segue para o acompanhamento (Pix).
import { h, trocar, api, reais } from '/site/base.js';

const raiz = document.getElementById('raiz');
const c = new URLSearchParams(location.search).get('c') || '';
const cabecalho = h('header', { class: 'topo' });
const corpo = h('main', null);
raiz.append(cabecalho, corpo);
const CHAVE = 'speed_cliente_convite';
const lembrado = (() => { try { return JSON.parse(localStorage.getItem(CHAVE) || '{}'); } catch { return {}; } })();

function topo(loja) {
  trocar(cabecalho, h('div', { class: 'dentro' }, h('div', { class: 'logo' }, 'SpeedBoy'), h('div', { class: 'sub' }, loja ? `Entrega da ${loja}` : 'Sua entrega')));
}

function tela(cv) {
  topo(cv.loja);
  const end = h('input', { id: 'end', maxlength: 200, autocomplete: 'street-address', placeholder: 'Rua, número, bairro e cidade', value: cv.endereco || lembrado.endereco || '' });
  const compl = h('input', { id: 'compl', maxlength: 80, placeholder: 'Apartamento, bloco, casa (se tiver)', value: lembrado.compl || '' });
  const meuNome = h('input', { id: 'meunome', maxlength: 80, autocomplete: 'name', placeholder: 'Como podemos te chamar?', value: lembrado.meuNome || '' });
  const meuFone = h('input', { id: 'meufone', maxlength: 20, inputmode: 'tel', autocomplete: 'tel', placeholder: '(27) 99999-0000', value: cv.fone || lembrado.meuFone || '' });
  const recebe = h('input', { id: 'recebe', maxlength: 80, placeholder: 'Nome de quem vai receber', value: lembrado.outro ? lembrado.recebe || '' : cv.recebe || '' });
  const fone = h('input', { id: 'fone', maxlength: 20, inputmode: 'tel', placeholder: '(27) 99999-0000', value: lembrado.outro ? lembrado.fone || '' : '' });
  const referencia = h('textarea', { id: 'ref', maxlength: 200, rows: 3, placeholder: 'Ex.: casa amarela de portão preto, ao lado da padaria · Condomínio Jardins, bloco B · Empresa X, recepção', value: lembrado.referencia || '' });
  let outro = Boolean(lembrado.outro);
  const como = h('textarea', { id: 'como', maxlength: 300, rows: 2, placeholder: 'Ex.: deixar na portaria, tocar o interfone 102' });
  const doc = h('input', { id: 'doc', maxlength: 18, inputmode: 'numeric', placeholder: 'CPF ou CNPJ', value: lembrado.doc || '' });
  const nfNome = h('input', { id: 'nfnome', maxlength: 80, placeholder: 'Nome completo ou razão social', value: lembrado.nfNome || '' });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const valores = h('div', { 'aria-live': 'polite' });

  const endereco = () => [end.value.trim(), compl.value.trim()].filter(Boolean).join(' – ');
  const quemRecebe = () => (outro ? { nome: recebe.value, fone: fone.value } : { nome: meuNome.value, fone: meuFone.value });
  const telOk = (v) => v.replace(/\D/g, '').length >= 10;
  function conferir(passo) {
    if (passo === 1) {
      if (meuNome.value.trim().length < 2) return 'Diga o seu nome, por favor.';
      if (!telOk(meuFone.value)) return 'Informe o seu WhatsApp com DDD, por favor.';
      if (outro && recebe.value.trim().length < 2) return 'Diga o nome de quem vai receber, por favor.';
      if (outro && !telOk(fone.value)) return 'Informe o WhatsApp de quem vai receber, com DDD, por favor.';
    }
    if (passo === 2) {
      if (end.value.trim().length < 6) return 'Escreva o endereço com rua, número e bairro, por favor.';
      if (referencia.value.trim().length < 6) return 'Conte como reconhecer o local, por favor. Ajuda muito o motoboy a chegar certinho.';
    }
    if (passo === 3) {
      const d = doc.value.replace(/\D/g, '');
      if (d && d.length !== 11 && d.length !== 14) return 'Confira o CPF ou CNPJ, ou deixe em branco, por favor.';
      if (d && nfNome.value.trim().length < 3) return 'Informe o nome para a nota fiscal, por favor.';
    }
    return '';
  }

  function escolher(cot) {
    let urgente = false;
    const pedir = h('button', { type: 'button', class: 'primario' }, `Confirmar e pagar ${reais(cot.valor_rota)}`);
    const opcao = (sim, titulo, valor, detalhe) => {
      const r = h('input', { type: 'radio', name: 'modo', checked: !sim });
      r.onchange = () => { urgente = sim; pedir.textContent = `Confirmar e pagar ${reais(sim ? cot.valor_urgente : cot.valor_rota)}`; };
      return h('label', { class: 'cartao marcar' }, r, h('span', { class: 'cresce' }, h('b', null, titulo), h('div', { class: 'nota' }, detalhe)), h('b', null, reais(valor)));
    };
    const aviso = h('div', { class: 'erro', role: 'alert' });
    pedir.onclick = async () => {
      aviso.textContent = '';
      pedir.disabled = true;
      pedir.textContent = 'Enviando…';
      try {
        const r = await api('POST', '/api/publico/convite/pedido', {
          c, urgente, pede_nome: meuNome.value, pede_fone: meuFone.value, recebe: quemRecebe().nome, fone: quemRecebe().fone,
          referencia: referencia.value, instrucoes: como.value, nf_doc: doc.value, nf_nome: nfNome.value,
          entrega: { endereco: endereco(), lat: cot.entrega.lat, lon: cot.entrega.lon },
        });
        try { localStorage.setItem(CHAVE, JSON.stringify({ meuNome: meuNome.value, meuFone: meuFone.value, outro, recebe: recebe.value, fone: fone.value, endereco: end.value, compl: compl.value, referencia: referencia.value, doc: doc.value, nfNome: nfNome.value })); } catch { /* sem memória */ }
        location.href = `/acompanhar/?c=${encodeURIComponent(r.codigo)}`;
      } catch (e) {
        aviso.textContent = e.message || 'Não foi possível enviar agora. Tente de novo, por favor.';
        pedir.disabled = false;
        pedir.textContent = 'Confirmar e pagar';
      }
    };
    trocar(valores,
      h('h2', null, 'Como prefere receber?'),
      opcao(false, 'Na rota', cot.valor_rota, 'O motoboy leva junto com as entregas da região.'),
      opcao(true, '⚡ Urgente', cot.valor_urgente, cv.urgente.prazo_min ? `Motoboy só para você, em até ${cv.urgente.prazo_min} min depois do pagamento.` : 'Motoboy só para você.'),
      cot.acima_teto && h('p', { class: 'nota' }, 'Como são vários volumes grandes, a SpeedBoy confirma o valor e o Pix aparece na próxima tela.'),
      h('div', { class: 'aviso-quarta' }, h('b', null, 'O pagamento é feito por Pix, na próxima tela.'), h('div', null, 'Os centavos identificam o seu pagamento. Assim que o Pix cair, o motoboy busca na loja e leva até você.')),
      aviso, pedir);
    valores.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Um assunto por tela: 1) você e quem recebe, 2) endereço e como reconhecer, 3) nota (opcional) e valor.
  const form = h('div', null);
  let passo = 1;
  const marcador = (n) => h('p', { class: 'nota' }, `Passo ${n} de 3`);
  const continuar = (n) => {
    erro.textContent = conferir(n);
    if (erro.textContent) return;
    passo = n + 1;
    desenhar();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const voltar = () => { passo -= 1; erro.textContent = ''; trocar(valores); desenhar(); };
  function opcaoRecebe(valor, titulo, detalhe) {
    const r = h('input', { type: 'radio', name: 'quem', checked: outro === valor });
    r.onchange = () => { outro = valor; desenhar(); };
    return h('label', { class: 'cartao marcar' }, r, h('span', { class: 'cresce' }, h('b', null, titulo), h('div', { class: 'nota' }, detalhe)));
  }
  function desenhar() {
    if (passo === 1) {
      trocar(form, h('div', { class: 'cartao' },
        marcador(1),
        h('b', null, 'Primeiro, seus dados'),
        h('div', { class: 'nota' }, 'Para a gente falar com você, se precisar.'),
        h('label', { for: 'meunome' }, 'Seu nome'), meuNome,
        h('label', { for: 'meufone' }, 'Seu WhatsApp'), meuFone,
        h('b', { class: 'subtitulo' }, 'Quem vai receber a entrega?'),
        opcaoRecebe(false, 'Eu mesmo(a)', 'O motoboy fala com você.'),
        opcaoRecebe(true, 'Outra pessoa', 'Ex.: alguém da família, porteiro, colega de trabalho.'),
        outro && h('div', null,
          h('label', { for: 'recebe' }, 'Nome de quem vai receber'), recebe,
          h('label', { for: 'fone' }, 'WhatsApp de quem vai receber'), fone)),
      erro, h('button', { type: 'button', class: 'primario', onclick: () => continuar(1) }, 'Continuar'));
    } else if (passo === 2) {
      trocar(form, h('div', { class: 'cartao' },
        marcador(2),
        h('b', null, 'Para onde vamos levar?'),
        h('label', { for: 'end' }, 'Endereço'), end,
        h('label', { for: 'compl' }, 'Complemento'), compl,
        h('label', { for: 'ref' }, 'Como reconhecer o local (obrigatório)'),
        h('div', { class: 'nota' }, 'Fachada, ponto de referência, nome do condomínio ou da empresa. Ajuda o motoboy a chegar certinho.'),
        referencia,
        h('label', { for: 'como' }, 'Algum recado para o motoboy? (opcional)'), como),
      erro,
      h('div', { class: 'linha-botoes' },
        h('button', { type: 'button', onclick: voltar }, 'Voltar'),
        h('button', { type: 'button', class: 'primario', onclick: () => continuar(2) }, 'Continuar')));
    } else {
      const ver = h('button', { type: 'button', class: 'primario' }, 'Ver o valor da entrega');
      ver.onclick = async () => {
        erro.textContent = conferir(3);
        if (erro.textContent) return;
        ver.disabled = true;
        ver.textContent = 'Calculando…';
        try {
          escolher(await api('POST', '/api/publico/convite/cotar', { c, entrega: { endereco: endereco() } }));
        } catch (e) {
          erro.textContent = e.message || 'Não foi possível calcular agora. Tente de novo, por favor.';
        }
        ver.disabled = false;
        ver.textContent = 'Ver o valor da entrega';
      };
      trocar(form, h('div', { class: 'cartao' },
        marcador(3),
        h('b', null, 'Nota fiscal da entrega (opcional)'),
        h('div', { class: 'nota' }, 'Se quiser a nota, preencha. Se não, pode deixar em branco.'),
        h('label', { for: 'doc' }, 'CPF ou CNPJ'), doc,
        h('label', { for: 'nfnome' }, 'Nome'), nfNome),
      erro,
      h('div', { class: 'linha-botoes' },
        h('button', { type: 'button', onclick: voltar }, 'Voltar'), ver));
    }
  }
  desenhar();

  trocar(corpo,
    h('h1', null, 'Sua entrega'),
    h('div', { class: 'cartao' },
      h('p', null, `Olá! A ${cv.loja} preparou o seu pedido e a SpeedBoy faz a entrega. O valor da entrega fica por sua conta e você vê antes de confirmar.`),
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto coleta' }, 'C'), h('div', null, h('div', { class: 'nota' }, 'Retirada na loja'), cv.coleta)),
      h('div', { class: 'linha-end' }, h('div', { class: 'ponto entrega' }, '📦'), h('div', null, h('div', { class: 'nota' }, 'Mercadorias'), [cv.volumes_texto, cv.oque].filter(Boolean).join(' · '))),
      cv.loja_whatsapp && h('a', { class: 'botao', target: '_blank', rel: 'noopener noreferrer', href: `https://wa.me/55${String(cv.loja_whatsapp).replace(/\D/g, '').replace(/^55/, '')}?text=${encodeURIComponent(`Olá! Tenho uma dúvida sobre a entrega do meu pedido na ${cv.loja}.`)}` }, `Falar com a ${cv.loja}`)),
    form, valores);
}

(async () => {
  topo('');
  try {
    const cv = await api('GET', `/api/publico/convite?c=${encodeURIComponent(c)}`);
    if (cv.feito && cv.pedido) { location.replace(`/acompanhar/?c=${encodeURIComponent(cv.pedido)}`); return; }
    tela(cv);
  } catch (e) {
    trocar(corpo, h('h1', null, 'Link indisponível'), h('p', { class: 'nota' }, e.message || 'Fale com a loja, por favor.'));
  }
})();
