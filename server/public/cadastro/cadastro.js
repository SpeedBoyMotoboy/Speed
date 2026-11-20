// Cadastro de motoboy: a pessoa preenche, o dono aceita ou recusa no painel. A senha chega depois, pelo WhatsApp.
import { h, trocar, api } from '/site/base.js';

const raiz = document.getElementById('raiz');

function moldura(...conteudo) {
  trocar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'dentro' },
      h('div', { class: 'logo' }, 'SpeedBoy'), h('div', { class: 'sub' }, 'Cadastro de motoboy'))),
    h('main', null, conteudo));
}

function telaFormulario() {
  const nome = h('input', { id: 'nome', maxlength: 80, autocomplete: 'name', placeholder: 'Nome e sobrenome' });
  const telefone = h('input', { id: 'telefone', inputmode: 'tel', maxlength: 16, autocomplete: 'tel', placeholder: '(27) 99999-0000' });
  const documento = h('input', { id: 'documento', maxlength: 20, inputmode: 'numeric', placeholder: 'CPF ou RG' });
  const veiculo = h('select', { id: 'veiculo' }, h('option', { value: 'moto' }, 'Moto'), h('option', { value: 'bike' }, 'Bicicleta'));
  const placa = h('input', { id: 'placa', maxlength: 8, autocapitalize: 'characters', placeholder: 'ABC1D23' });
  const rotuloPlaca = h('label', { for: 'placa' }, 'Placa da moto');
  veiculo.addEventListener('change', () => { const moto = veiculo.value === 'moto'; placa.hidden = !moto; rotuloPlaca.hidden = !moto; });
  const bau = h('input', { type: 'checkbox', id: 'bau' });
  const bag = h('input', { type: 'checkbox', id: 'bag' });
  const indicacao = h('input', { id: 'indicacao', maxlength: 160, placeholder: 'Quem indicou ou em qual grupo você viu' });
  const pixChave = h('input', { id: 'pix_chave', maxlength: 100, autocomplete: 'off', placeholder: 'CPF, telefone, e-mail ou chave aleatória' });
  const pixTitular = h('input', { id: 'pix_titular', maxlength: 80, placeholder: 'Nome completo do dono da conta' });
  const pixBanco = h('input', { id: 'pix_banco', maxlength: 40, placeholder: 'Ex.: Nubank, Caixa, Inter' });
  const ciente = h('input', { type: 'checkbox', id: 'ciente' });
  const erro = h('div', { class: 'erro', role: 'alert' });
  const enviar = h('button', { class: 'primario', type: 'submit' }, 'Enviar cadastro');

  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      if (!ciente.checked) { erro.textContent = 'Marque que está ciente do pagamento às quartas-feiras.'; return; }
      enviar.disabled = true;
      try {
        await api('POST', '/api/publico/cadastro', {
          nome: nome.value, telefone: telefone.value, documento: documento.value, veiculo: veiculo.value, placa: placa.value,
          tem_bau: bau.checked, tem_bag: bag.checked, indicacao: indicacao.value,
          pix_chave: pixChave.value, pix_titular: pixTitular.value, pix_banco: pixBanco.value, ciente: ciente.checked,
        });
        telaEnviado(nome.value);
      } catch (e) {
        erro.textContent = e.message;
        enviar.disabled = false;
      }
    },
  },
  h('label', { for: 'nome' }, 'Nome completo'), nome,
  h('label', { for: 'telefone' }, 'WhatsApp com DDD'), telefone,
  h('label', { for: 'documento' }, 'CPF ou RG'), documento,
  h('label', { for: 'veiculo' }, 'Veículo'), veiculo,
  rotuloPlaca, placa,
  h('label', { class: 'marcar' }, bau, ' Tenho baú'),
  h('label', { class: 'marcar' }, bag, ' Tenho bag'),
  h('label', { for: 'indicacao' }, 'Indicação'), indicacao,
  h('h3', null, 'Como receber seu pagamento'),
  h('label', { for: 'pix_chave' }, 'Chave Pix'), pixChave,
  h('label', { for: 'pix_titular' }, 'Nome de quem é a conta'), pixTitular,
  h('label', { for: 'pix_banco' }, 'Banco'), pixBanco,
  h('div', { class: 'aviso-quarta' },
    h('div', null, '💰 ', h('b', null, 'O pagamento é feito toda QUARTA-FEIRA'), ', por Pix, em horário comercial.'),
    h('div', null, 'É automático: não precisa cobrar. Entra só a entrega registrada e concluída no app.'),
    h('label', { class: 'marcar' }, ciente, ' Estou ciente de que o pagamento é feito toda quarta-feira, em horário comercial.')),
  erro, enviar);

  moldura(
    h('div', { class: 'cartao' },
      h('h2', null, 'Trabalhe com a SpeedBoy'),
      h('p', { class: 'nota' }, 'Preencha seus dados. A gente analisa e, se aprovado, você recebe o link do aplicativo e a senha pelo WhatsApp.'),
      form),
    h('p', { class: 'nota' }, 'Seus dados são usados só para o cadastro e para o contato da SpeedBoy com você.'));
}

function telaEnviado(nome) {
  moldura(h('div', { class: 'cartao' },
    h('h2', null, 'Cadastro enviado ✓'),
    h('p', null, `Obrigado, ${String(nome).trim().split(/\s+/)[0] || ''}! Recebemos seus dados.`),
    h('p', { class: 'nota' }, 'Assim que a SpeedBoy aprovar, você recebe no WhatsApp o link do aplicativo e a sua senha. Não precisa fazer mais nada agora.')));
}

telaFormulario();
