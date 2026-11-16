// Robô de atendimento do WhatsApp: conversa passo a passo até virar pedido.
// Função pura: recebe o ponto da conversa e a mensagem, devolve o novo ponto e as respostas.
// Tudo que toca banco ou internet chega pronto em `a` (ajudas).

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const SIM = /^(1|s|sim|ok|isso|certo|correto|confirmo|confirmar|confirma|pode|ta certo|esta certo)\b/;
const NAO = /^(2|n|nao|errado|outro|nao e esse)\b/;
const SAIR = /^(0|menu|voltar|cancelar|cancela|sair|parar|recomecar)$/;
const HUMANO = /\b(atendente|humano|pessoa|funcionario|falar com alguem)\b/;

export const reais = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const ROTULO_PEDIDO = {
  sem_local: 'recebido, confirmando o endereço', aguardando: 'procurando motoboy', atribuida: 'motoboy a caminho da coleta',
  coletada: 'coletado, a caminho da entrega', entregue: 'entregue', cancelada: 'cancelado',
};

function menu(a, nome) {
  const primeiro = String(nome || '').trim().split(/\s+/)[0];
  return [
    `Olá${primeiro ? `, ${primeiro}` : ''}! Aqui é o atendimento automático da *${a.empresa}*. 🛵`,
    '',
    'Digite o número da opção:',
    '*1* - Pedir um motoboy',
    '*2* - Acompanhar meu pedido',
    '*3* - Falar com um atendente',
  ].join('\n');
}

const PEDIR_ENDERECO = {
  coleta: 'Qual é o endereço de *COLETA*? (rua, número e bairro)\n\nSe preferir, envie a localização: 📎 → Localização.',
  entrega: 'Agora o endereço de *ENTREGA*. (rua, número e bairro)\n\nTambém pode enviar a localização.',
};
const PEDIR_DESCRICAO = 'Descreva o que precisa e quem recebe na entrega.\n\nEx.: _Envelope, entregar para João_';
const PEDIR_EMAIL = 'Para gerar o Pix, me diga seu *e-mail* (o comprovante vai para ele).';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const pedirServico = (lista) => ['Que tipo de serviço você precisa?', '', ...lista.map((s, i) => `*${i + 1}* - ${s.nome}`)].join('\n');

function requisitoDe(texto) {
  const t = semAcento(texto);
  if (/\bbau\b/.test(t)) return 'bau';
  if (/\b(bag|mochila)\b/.test(t)) return 'bag';
  return 'qualquer';
}

function resumo(dados, cotacao) {
  const linhas = [
    '*Confira o pedido:*',
    `📦 Coleta: ${dados.coleta.endereco}`,
    `🏁 Entrega: ${dados.entrega.endereco}`,
    dados.servico_nome ? `🧾 ${dados.servico_nome}` : null,
    `📝 ${dados.descricao}`,
  ].filter(Boolean);
  if (cotacao?.valor != null) linhas.push(`💰 Valor: ${reais(cotacao.valor)}${cotacao.km != null ? ` (${cotacao.km.toFixed(1).replace('.', ',')} km)` : ''}`);
  linhas.push('', '*1* - Confirmar', '*2* - Cancelar');
  return linhas.join('\n');
}

export async function conversar(estado, msg, a) {
  let etapa = estado.etapa || '';
  let dados = { ...(estado.dados || {}) };
  const respostas = [];
  const dizer = (t) => respostas.push(t);
  const fim = (extra = {}) => ({ etapa, dados, respostas, ...extra });
  const zerar = () => { etapa = ''; dados = {}; };
  const texto = String(msg.texto || '').trim();
  const t = semAcento(texto);
  const temLocal = msg.lat != null && msg.lon != null;

  if (!texto && !temLocal) {
    dizer('Por aqui eu só entendo mensagem de texto ou localização. 🙂\nEnvie *menu* para ver as opções.');
    return fim();
  }
  if (HUMANO.test(t) || (etapa === 'menu' && t === '3')) {
    zerar();
    dizer('Certo! Chamei um atendente, ele responde por aqui em instantes.\n\nPara voltar ao atendimento automático, envie *menu*.');
    return fim({ humano: true });
  }
  if (etapa && SAIR.test(t)) {
    const eraSite = etapa === 'site' && dados.demanda_id;
    if (eraSite) await a.cancelarSite(dados.demanda_id);
    zerar();
    dizer(eraSite ? 'Pedido cancelado. Envie *oi* quando precisar.' : 'Tudo bem, parei por aqui. Envie *oi* quando precisar.');
    return fim();
  }

  // Pedido feito no site esperando o "sim" do cliente.
  if (etapa === 'site') {
    if (SIM.test(t)) {
      const p = await a.confirmarSite(dados.demanda_id);
      zerar();
      dizer(p ? `✅ Pedido #${p.id} confirmado! Aviso por aqui quando o motoboy estiver a caminho.\n\nAcompanhe: ${p.link}`
        : 'Esse pedido não está mais esperando confirmação. Envie *menu* para ver as opções.');
    } else if (NAO.test(t)) {
      await a.cancelarSite(dados.demanda_id);
      zerar();
      dizer('Pedido cancelado. Envie *oi* quando precisar.');
    } else {
      dizer('Responda *1* para confirmar o pedido feito no site ou *2* para cancelar.');
    }
    return fim();
  }

  if (etapa === '') {
    etapa = 'menu';
    dizer(menu(a, msg.nome));
    return fim();
  }

  if (etapa === 'menu') {
    if (t === '1') {
      const fechado = a.fechado();
      if (fechado) { zerar(); dizer(fechado); return fim(); }
      const ult = a.ultimoEndereco();
      if (ult) {
        etapa = 'coleta_mesmo';
        dados = { ultimo: ult };
        dizer(`Vamos lá! A coleta é no mesmo endereço da última vez?\n\n📦 ${ult.endereco}\n\n*1* - Sim\n*2* - Outro endereço`);
      } else {
        etapa = 'coleta';
        dados = {};
        dizer(`Vamos lá! ${PEDIR_ENDERECO.coleta}`);
      }
    } else if (t === '2') {
      const pedidos = a.pedidos();
      zerar();
      dizer(pedidos.length
        ? ['*Seus pedidos:*', ...pedidos.map((p) => `#${p.id} — ${ROTULO_PEDIDO[p.status] || p.status}\n${p.link}`)].join('\n\n')
        : 'Não achei pedido em andamento neste número. Envie *1* depois de *menu* para pedir um motoboy.');
    } else {
      dizer(menu(a, msg.nome));
    }
    return fim();
  }

  if (etapa === 'coleta_mesmo') {
    if (SIM.test(t)) {
      dados.coleta = dados.ultimo;
      delete dados.ultimo;
      etapa = 'entrega';
      dizer(PEDIR_ENDERECO.entrega);
      return fim();
    }
    delete dados.ultimo;
    etapa = 'coleta';
    if (NAO.test(t)) { dizer(PEDIR_ENDERECO.coleta); return fim(); }
    // Já escreveu o endereço novo direto: segue como resposta da etapa de coleta.
  }

  for (const qual of ['coleta', 'entrega']) {
    const aceitar = (ponto) => {
      dados[qual] = ponto;
      delete dados.prov;
      delete dados.falhas;
      if (qual === 'coleta') { etapa = 'entrega'; dizer(PEDIR_ENDERECO.entrega); return; }
      const lista = a.servicos();
      if (lista.length > 1) { etapa = 'servico'; dizer(pedirServico(lista)); return; }
      if (lista.length === 1) { dados.servico_id = lista[0].id; dados.servico_nome = lista[0].nome; }
      etapa = 'descricao';
      dizer(PEDIR_DESCRICAO);
    };
    if (etapa === `${qual}_ok`) {
      if (SIM.test(t) && dados.prov) { aceitar(dados.prov); return fim(); }
      etapa = qual;
      if (NAO.test(t)) {
        delete dados.prov;
        dizer('Sem problema. Escreva de novo com mais detalhes (rua, número, bairro e cidade) ou envie a localização.');
        return fim();
      }
    }
    if (etapa === qual) {
      if (temLocal) {
        aceitar({ endereco: texto || 'Localização enviada pelo WhatsApp', lat: msg.lat, lon: msg.lon });
        return fim();
      }
      if (texto.length < 6) { dizer('Preciso do endereço completo: rua, número e bairro.'); return fim(); }
      const endereco = texto.replace(/\s*\n+\s*/g, ', ').slice(0, 200);
      let achado = null;
      try { [achado] = await a.geocodificar(endereco); } catch { /* busca fora do ar: trata como não achado */ }
      if (achado) {
        dados.prov = { endereco, lat: achado.lat, lon: achado.lon };
        etapa = `${qual}_ok`;
        dizer(`Achei no mapa:\n📍 ${achado.nome}\n\n*1* - Está certo\n*2* - Não é esse`);
      } else if (!dados.falhas) {
        dados.falhas = 1;
        dizer('Não achei esse endereço no mapa. 😕\nTente de novo com rua, número, bairro e cidade, ou envie a localização (📎 → Localização).');
      } else {
        dizer('Anotei o endereço do jeito que você escreveu. Nossa equipe confirma o ponto no mapa.');
        aceitar({ endereco, lat: null, lon: null });
      }
      return fim();
    }
  }

  if (etapa === 'servico') {
    const lista = a.servicos();
    const escolhido = lista[Number(t) - 1];
    if (!/^\d+$/.test(t) || !escolhido) { dizer(pedirServico(lista)); return fim(); }
    dados.servico_id = escolhido.id;
    dados.servico_nome = escolhido.nome;
    etapa = 'descricao';
    dizer(PEDIR_DESCRICAO);
    return fim();
  }

  // Cria o pedido e, se for pago na hora, manda o Pix.
  const fechar = async () => {
    const p = await a.criarPedido(dados);
    zerar();
    if (p.pix) {
      dizer(`🧾 Pedido #${p.id} reservado! Para liberar o motoboy, pague o Pix de *${reais(p.valor)}* (copia e cola na próxima mensagem). Vale por ${p.validade_min} min.\n\nSe preferir o QR code: ${p.link}`);
      dizer(p.pix);
      dizer('Assim que o pagamento cair eu aviso por aqui. 👍');
    } else {
      dizer(p.status === 'sem_local'
        ? `✅ Pedido #${p.id} recebido! Nossa equipe vai confirmar o endereço e já libera o motoboy.\n\nAcompanhe: ${p.link}`
        : `✅ Pedido #${p.id} confirmado! Aviso por aqui quando o motoboy estiver a caminho.\n\nAcompanhe: ${p.link}`);
    }
  };

  if (etapa === 'email') {
    if (!EMAIL.test(texto)) { dizer('Não entendi o e-mail. Escreva assim: _nome@exemplo.com_'); return fim(); }
    dados.email = texto.toLowerCase();
    await fechar();
    return fim();
  }

  if (etapa === 'descricao') {
    if (texto.length < 2) { dizer(PEDIR_DESCRICAO); return fim(); }
    dados.descricao = texto.replace(/\s*\n+\s*/g, ' · ').slice(0, 400);
    dados.requisito = requisitoDe(texto);
    etapa = 'confirma';
    dizer(resumo(dados, await a.cotar(dados.coleta, dados.entrega, dados.servico_id)));
    return fim();
  }

  if (etapa === 'confirma') {
    if (SIM.test(t)) {
      if (a.pedeEmail(dados)) { etapa = 'email'; dizer(PEDIR_EMAIL); return fim(); }
      await fechar();
    } else if (NAO.test(t)) {
      zerar();
      dizer('Pedido cancelado. Envie *oi* quando precisar.');
    } else {
      dizer('Responda *1* para confirmar ou *2* para cancelar.');
    }
    return fim();
  }

  zerar();
  etapa = 'menu';
  dizer(menu(a, msg.nome));
  return fim();
}
