# Prompts para ligar os outros chats ao Speed Despacho

Cole cada prompt no chat correspondente. Cada um explica o que este projeto oferece, o que precisa ser feito
do lado de lá e o que devolver para cá. Nenhum leva senha ou chave: elas são geradas no painel do Speed Despacho
e entregues pelo Luan.

Antes de usar: a VPS precisa estar com a versão nova (branch `claude/new-session-83gqyr`). Teste rápido:
`https://despacho.srv2150999.hstgr.cloud/api/publico/info` precisa responder com `"empresa"`. Se der "não encontrada", atualize primeiro.

---

## 1. Chat do site (speedboy.com.br)

```
Você cuida do site speedboy.com.br. Ele passa a se ligar ao Speed Despacho, o sistema de despacho de motoboys da SpeedBoy (repositório SpeedBoyMotoboy/Speed, arquivo docs/ponte.md tem a ficha completa).

O que o Speed Despacho oferece ao site:
- Página de pedido de entrega urgente: https://despacho.srv2150999.hstgr.cloud/pedir/
  O cliente informa coleta, entrega e tipo de serviço, vê o preço calculado na hora, paga Pix e recebe um link de acompanhamento. Já usa as cores do site (azul #001f6b, laranja #ff5400).
- Página de acompanhamento: /acompanhar/?c=CÓDIGO (o link chega ao cliente; o site não precisa montar).

O que fazer no site:
1. Botão "Entrega urgente" (ou "Peça um motoboy agora") nas páginas principais e nas páginas de cidade, apontando para a URL acima, com target="_blank" rel="noopener noreferrer".
2. Usar link, nunca iframe: o sistema bloqueia moldura (X-Frame-Options DENY).
3. Não escrever preço fixo nem prazo diferente no site: o preço vem do sistema e o prazo mostrado lá é "Motoboy em até 30 minutos" (configurável). Se o site citar prazo, use o mesmo.
4. O site não consegue chamar a API do sistema pelo navegador (não há CORS liberado). Se quiser calculadora de preço dentro do site, não construa: peça ao chat do Speed Despacho.
5. Política de privacidade: inclua os dados tratados pelo sistema. A tabela pronta (dados, finalidade, terceiros) está em docs/ponte.md, seção 3, do repositório SpeedBoyMotoboy/Speed.
6. Medição: se o site tem gtag, registre o clique no botão como evento (ex.: pedido_urgente_click), como já faz com o WhatsApp.

Ao terminar, me devolva: em quais páginas o botão entrou, o texto exato usado e se a política de privacidade foi atualizada.
```

---

## 2. Chat do WhatsApp

```
Você cuida do WhatsApp da SpeedBoy. Ele passa a se ligar ao Speed Despacho, o sistema de despacho de motoboys (repositório SpeedBoyMotoboy/Speed; ficha completa em docs/ponte.md).

O Speed Despacho já tem: robô que monta o pedido (coleta, entrega, descrição, preço, Pix), avisos automáticos ao cliente (motoboy a caminho, coletado, entregue), convocação de motoboys, leitura de comprovante de Pix por IA e atendimento humano pelo painel. Ele precisa de uma ponte com o número da empresa, nos dois sentidos.

Modo de ligação "Outro (n8n, Make)" do painel (Configurações → WhatsApp automático):

ENTRADA (cada mensagem que um cliente manda para a empresa):
  POST https://despacho.srv2150999.hstgr.cloud/api/whatsapp/webhook?s=SEGREDO
  Content-Type: application/json
  { "telefone": "5527999990000", "nome": "Nome do contato", "texto": "mensagem",
    "lat": null, "lon": null,                       // se o cliente mandou localização
    "midia_tipo": "image/jpeg", "midia_base64": "..." }  // opcional: foto ou PDF (até ~5 MB), para comprovante
  - Uma requisição por mensagem. Não envie mensagens de grupo nem as que a própria empresa mandou.
  - O SEGREDO aparece no painel, no endereço do webhook. O Luan passa.
  - Resposta 200 = recebido. A resposta ao cliente sai pela SAÍDA abaixo, não no retorno.

SAÍDA (o sistema manda você enviar uma mensagem):
  O Speed Despacho faz POST no endereço que você informar no campo "Endereço do servidor de WhatsApp":
  { "telefone": "5527999990000", "texto": "mensagem pronta" }
  com o cabeçalho Authorization: Bearer <chave que você definir; o Luan cola no painel>.
  Responda 2xx quando enviar; qualquer outro código faz o sistema tentar de novo (até 6 vezes, com espera crescente).

Se o seu lado já usa Evolution API, dá para ligar direto, sem ponte: no painel escolher "Evolution API" e na instância apontar o webhook para o endereço de ENTRADA acima com o evento MESSAGES_UPSERT e "Webhook Base64" ligado.

Regras:
- Enquanto o robô do Speed Despacho estiver ligado, ele responde sozinho. Não deixe outro robô responder as mesmas mensagens: decida com o Luan qual atende.
- Comandos do responsável (só do número cadastrado no painel): "pago 12" libera o pedido 12, "cancelar 12" cancela.
- Nunca coloque o SEGREDO ou a chave em código versionado.

Ao terminar, me devolva: qual modo foi usado (Evolution direto ou ponte), o endereço de SAÍDA que o Luan deve colar no painel e o resultado de um teste (mande "oi" de outro número e veja se a conversa aparece na aba WhatsApp do painel).
```

---

## 3. Chat do aplicativo SpeedBoy (SpeedBoy-APP)

```
Você cuida do aplicativo de clientes SpeedBoy (repositório SpeedBoy-APP). Ele passa a enviar pedidos ao Speed Despacho, o sistema que distribui as entregas aos motoboys (repositório SpeedBoyMotoboy/Speed; ficha em docs/ponte.md, seção 4).

Como mandar um pedido (de servidor para servidor, nunca do celular):
  POST https://despacho.srv2150999.hstgr.cloud/api/entrada/demandas
  X-Api-Key: <chave gerada no painel em Configurações → Entrada automática; o Luan entrega>
  Content-Type: application/json
  { "cliente": "Nome ou empresa", "cliente_telefone": "27999990000",
    "requisito": "qualquer",            // qualquer | moto | bau | bag
    "descricao": "o que levar / o que fazer",
    "coleta":  { "endereco": "Rua, número, bairro, cidade", "contato": "nome e telefone", "lat": null, "lon": null },
    "entrega": { "endereco": "Rua, número, bairro, cidade", "contato": "nome e telefone", "lat": null, "lon": null } }
  Resposta: { "id": 12, "status": "aguardando" | "sem_local" }
  - sem_local = o mapa não achou o endereço; a equipe marca o ponto no painel.
  - Mande lat/lon quando o app já tiver; acerta mais.

Regras:
- A chave X-Api-Key é secreta: fica em variável de ambiente ou cofre do servidor (Firebase Functions, backend, n8n). Nunca no código do app, no navegador nem no repositório.
- Pedido que entra por aqui é tratado como cliente fixo/comum: vai direto ao motoboy de diária, sem cobrança Pix no sistema (a cobrança continua sendo do app ou da fatura).
- Hoje a resposta não traz o link de acompanhamento nem há aviso de volta (webhook) quando o status muda. Se o app precisar disso, NÃO contorne: liste o que precisa (campos, eventos) e me devolva para eu pedir ao chat do Speed Despacho.

Ao terminar, me devolva: onde a chave ficou guardada, um pedido de teste enviado (id e status retornados) e a lista do que o app ainda precisa do Speed Despacho.
```

---

## 4. Chat da ponte (sistema de IAs integrado)

```
Você cuida da "ponte", o sistema que liga as IAs da SpeedBoy entre si. Ele passa a se ligar ao Speed Despacho, o sistema de despacho de motoboys (repositório SpeedBoyMotoboy/Speed). Leia docs/ponte.md e docs/contexto-chat.md desse repositório antes de começar: lá estão as regras do negócio, os endereços e quem decide o quê.

O que o Speed Despacho já oferece para outros sistemas:
1. Criar pedido: POST /api/entrada/demandas com cabeçalho X-Api-Key (formato em docs/ponte.md, seção 4).
2. Conversar pelo WhatsApp da empresa: ENTRADA em POST /api/whatsapp/webhook?s=SEGREDO e SAÍDA para um endereço seu (formato no README, seção "Ligar o WhatsApp", modo "Outro (n8n, Make)"). Só um dos dois robôs pode responder os clientes; combine com o Luan.
3. Acompanhamento público de um pedido: GET /api/publico/pedido?c=CÓDIGO.
4. Saúde: GET /saude.
Base: https://despacho.srv2150999.hstgr.cloud

O que ainda NÃO existe (não invente nem acesse o banco por fora; peça):
- Leitura do estado da operação por API com chave (motoboys em turno, fila, alertas, relatórios). Hoje só o painel, com login.
- Aviso de saída (webhook) quando um pedido muda de status, um alerta abre ou um pagamento é confirmado.
- Relatório diário automático.

Tarefa:
1. Descreva em um documento curto o contrato que a ponte precisa do Speed Despacho: para cada item, o evento ou a consulta, os campos, a frequência e quem consome (qual IA). Separe o que precisa agora do que pode esperar.
2. Ligue já o que existe (itens 1 a 4), guardando chaves e segredos fora do código.
3. Regras para todas as IAs da ponte: decisões de dinheiro, preço, contrato de motoboy e liberação de pagamento são do Luan; as IAs propõem e relatam. Dados de clientes (nome, telefone, endereço) só circulam entre sistemas da SpeedBoy, nunca para fora.

Me devolva o documento do contrato. Eu levo ao chat do Speed Despacho para implementar a API de leitura e os avisos de saída do jeito que a ponte precisa.
```

---

## 5. O que voltar para cá

Traga as respostas de cada chat para o chat do Speed Despacho. Em especial:
- do WhatsApp: o endereço de SAÍDA e a chave (o Luan cola no painel, não no chat);
- do app: a lista do que ainda falta (link de acompanhamento, aviso de status);
- da ponte: o contrato de API e eventos, para implementar a leitura com chave e os webhooks de saída.
