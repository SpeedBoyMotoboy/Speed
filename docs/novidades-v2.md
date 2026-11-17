# Speed Despacho v2: atendimento automático (16/11/2026)

Complementa o documento de contexto. Branch: `claude/new-session-83gqyr`.

## O que entrou

- **Pedido online** em `/pedir/` (cores do site speedboy.com.br): endereços → valor → confirma. O site atual só precisa de um botão apontando para lá.
- **Acompanhamento** em `/acompanhar/?c=código`: etapas e (opcional) motoboy no mapa.
- **Robô do WhatsApp**: monta o pedido sozinho, lembra o endereço de coleta do cliente, passa para atendente quando pedem. Conversas ao vivo na aba *WhatsApp*, com resposta pelo painel.
- **Avisos automáticos**: cliente (a caminho, coletado, entregue), motoboy (convocação), responsável (pedido sem local, pedido para aprovar, cliente pedindo atendente, alertas).
- **Convocação automática** por rodízio, com limite por dia (desligada por padrão: cada convocação é uma diária).
- **Preço** por distância (base + km a mais + mínimo) e **relatório por cliente**.
- **Painel**: lista "Falta configurar", aprovação de pedidos do site, aviso sonoro, contador de pendências.

## Arquivos novos

| Arquivo | Função |
|---|---|
| `server/src/atendimento.js` | Site, robô, avisos, fila de envio |
| `server/src/robo.js` | Conversa do robô (função pura) |
| `server/src/mensageiro.js` | Meta Cloud API e webhook genérico (Evolution removida em 17/11/2026: risco de banimento) |
| `server/public/pedir/`, `acompanhar/`, `site/` | Páginas públicas |

Rotas novas: `GET /api/publico/info`, `POST /api/publico/cotar`, `POST /api/publico/pedidos`, `GET /api/publico/pedido?c=`,
`GET|POST /api/whatsapp/webhook?s=`, `POST /api/admin/demandas/:id/liberar`, `POST /api/admin/whatsapp/:id/responder`,
`POST /api/admin/whatsapp/:id/modo`, `POST /api/admin/whatsapp-teste`.

Banco: tabelas `clientes` e `saida`; colunas novas em `demandas`, `conversas`, `mensagens`, `convocacoes`
(criadas sozinhas no primeiro início; testado com banco no formato antigo).

## Publicar na VPS (Console web)

```bash
docker cp despacho-speed-1:/dados/speed.db /root/speed-backup-$(date +%F).db
```

```bash
cd /opt/speed-src && git fetch origin claude/new-session-83gqyr && git checkout claude/new-session-83gqyr && git pull && docker build -t speed-despacho:latest . && cd /docker/despacho && docker compose up -d
```

## Configurar depois de publicar (aba Configurações)

1. Cidade base: `Espírito Santo` (atende 5 cidades; uma cidade só erraria as outras). Centro do mapa: `-20.3358`, `-40.2969`.
2. Preço da entrega e valor da diária.
3. Horário: 07:00 às 18:00 (coletas até 18h).
4. WhatsApp automático: só conexão oficial (Meta direto ou n8n); ver README. Sem isso o robô e os avisos ficam desligados; o site de pedidos funciona com aprovação no painel.
5. "Cliente vê o motoboy no mapa": só ligar depois de incluir isso no termo do motoboy.

## Limites

- Evolution API não é oficial do WhatsApp (risco de bloqueio do número). A API oficial da Meta exige modelo aprovado para mensagem fora da janela de 24 h.
- O robô entende texto e localização; áudio e foto ele pede para escrever.
- Endereço que o mapa não acha entra como "sem local" e o responsável é avisado.

---

# Etapa 3: entrega urgente, Pix, motoboy avulso e repasse (16/11/2026)

## Como funciona agora

1. **Página `/pedir/` é só entrega urgente** ("Motoboy em até 30 minutos", prazo configurável). O cliente informa coleta, entrega e o **tipo de serviço**, vê o preço e paga.
2. **Preço** = valor base + km a mais (com mínimo) + adicional do tipo de serviço. Distância pelas ruas se houver chave do OpenRouteService; senão linha reta × 1,35.
3. **Pix antes de liberar** (Mercado Pago): QR code e copia e cola na página e no WhatsApp. O sistema confere o pagamento direto no Mercado Pago; sem pagar em 30 min, o pedido é cancelado sozinho. Nenhum motoboy vê o pedido antes de o Pix cair.
4. **Cliente fixo** (marcado em Configurações → Clientes): não paga na hora, o pedido vai para a fatura mensal, pode ter percentual próprio da tabela. Como qualquer um pode digitar o telefone dele, o pedido só sai depois de confirmado pelo WhatsApp dele (ou aprovado no painel).
5. **Motoboy avulso**: entra sem convocação, recebe a oferta se estiver perto da coleta, aceita ou recusa, encerra quando quiser (desde que não tenha entrega aceita em aberto). Fica online no máximo 12 h; some sozinho após 30 min sem sinal.
6. **Motoboy diária**: continua convocado, com turno fixo e diária. Demanda comum (criada no painel ou pela API) vai direto para ele, como antes.
7. **Oferta**: pedido urgente é oferecido a todos (diária e avulso) online a até 5 km da coleta. O primeiro que aceitar leva. A cada 1,5 min sem aceite o raio dobra (até 8×); depois de 5 min o responsável é avisado.
8. **Repasse**: percentual do valor (padrão 60%, ajustável por tipo de serviço entre 50% e 70% ou o que quiser), com mínimo de R$ 15. O avulso vê o valor antes de aceitar, na rota e na lista "Ganhos deste turno". O relatório mostra, por entrega, valor, repasse e o que fica.

## Não precisa de APK novo

A oferta entra como "pendência" na resposta que o app já recebe a cada 15 s, então o app atual já toca a notificação. A tela do motoboy vem do servidor.

## Configurar (aba Configurações)

| Bloco | O que preencher |
|---|---|
| Preço da entrega urgente | Valor base, km incluídos, valor por km, mínimo, prazo prometido |
| Tipos de serviço | Quanto cada tipo soma no preço e, se quiser, o repasse próprio |
| Motoboy avulso | Repasse padrão (%), repasse mínimo (R$ 15), raio da oferta |
| Pagamento por Pix | Access Token de produção do Mercado Pago |
| Pedidos pelo site | "Antes de despachar" → **Cliente paga o Pix antes** |
| Clientes | Marcar os fixos como "Fatura mensal" |

Na aba *Motoboys*, cada cadastro tem "Como trabalha": **Diária** ou **Avulso**.

## Atenção

- **Devolução de Pix é manual**: se um pedido pago for cancelado, o responsável recebe o aviso e devolve pelo app do Mercado Pago.
- **Repasse mínimo × preço mínimo**: com repasse mínimo de R$ 15, mantenha o valor mínimo da entrega acima disso, senão a entrega dá prejuízo.
- **Termo do motoboy**: o texto atual fala em ficar disponível durante todo o turno. Para o avulso isso não vale; vale revisar o termo com advogado/contador.
- **Integração com o Mercado Pago não foi testada com conta real** (a rede do ambiente de desenvolvimento não alcança o Mercado Pago). Testada com banco simulado. Faça um pedido de valor baixo para validar.
- **Validação por IA** (conferir endereço e tipo de serviço antes de liberar): próxima etapa. Precisa de uma chave de API da Anthropic.

---

# Etapa 4: Pix na sua chave, comprovante e conferência por IA (16/11/2026)

## Pix sem intermediário

O Mercado Pago cobra 0,99% por Pix recebido pela API. Por isso entrou a opção de receber **direto na chave Pix da empresa**:

1. Em *Configurações → Pagamento por Pix*: tipo da chave, chave, nome de quem recebe, cidade e o WhatsApp que recebe o comprovante.
2. Em *Pedidos pelo site → Antes de despachar*: **Cliente paga no meu Pix e manda o comprovante**.
3. O cliente vê o QR code e o copia e cola já com o valor e o número do pedido (`PEDIDO12` aparece no extrato).
4. Você confirma de um destes jeitos: botão **Confirmar pagamento** no painel, ou respondendo **`pago 12`** no WhatsApp do robô (só o número do responsável vale). Para cancelar: **`cancelar 12`**.
5. Com o WhatsApp automático ligado, quando o cliente manda a foto do comprovante (ou escreve "paguei") o robô agradece e avisa você.

O sistema não enxerga sua conta: **confira no app do banco, não só na imagem do comprovante** (comprovante pode ser falsificado). Pix manual não é cancelado sozinho; depois do prazo você recebe um lembrete.

O Mercado Pago continua disponível como opção automática (o sistema confirma sozinho).

## Conferência por IA

Em *Configurações → Conferência dos pedidos por IA*: cole a chave da API da Anthropic, salve e clique em **Testar a IA**.

- Lê os endereços (como o cliente escreveu e como o mapa achou), a distância e a descrição. **Não recebe nome nem telefone do cliente.**
- **Identifica o tipo de serviço**: no site, se o cliente marcou "entrega" mas descreveu cartório, ele vê o preço certo antes de pagar. No WhatsApp o robô nem pergunta o tipo: o cliente descreve e a IA escolhe.
- **Segura o que parecer errado** (endereço incompleto, cidade diferente da escrita, fora das cidades atendidas, descrição sem sentido, item que motoboy não leva): o pedido fica em "Esperando pagamento ou aprovação" com o motivo, e você é avisado. Aprovando, o cliente recebe o Pix; o pedido só sai depois de pago.
- Escreve um resumo curto do serviço, que aparece no painel.
- Se a IA estiver fora do ar ou sem crédito, os pedidos seguem as regras normais (ninguém fica travado).

Modelo padrão: Claude Opus 5.5. Dá para trocar por Sonnet 5.5 ou Haiku 5.5 (mais barato) no mesmo bloco. A chave é da conta de API (console.anthropic.com), paga por uso e separada da assinatura do Claude.

Como gerar a chave: console.anthropic.com → entrar → **API Keys** → **Create Key** → copiar (aparece uma vez só) → colar no painel. Precisa ter crédito em **Billing**.

## Dependências novas do servidor

`@anthropic-ai/sdk` (IA) e `qrcode-generator` (QR code do Pix). O `docker build` já instala.

## Não testado com serviço real

Daqui não há acesso à API da Anthropic nem a banco. A IA foi testada com respostas simuladas e o código Pix foi conferido contra o exemplo oficial do Banco Central (CRC). Antes de divulgar: clique em **Testar a IA** e faça um Pix de valor baixo lendo o QR code no app do seu banco.

---

# Etapa 5: arquivos para a IA analisar (16/11/2026)

Nova aba **IA** no painel.

| O que enviar | O que a IA devolve |
|---|---|
| Foto ou print de conversa, pedido anotado à mão | Pedidos em aberto, cada um com botão **Criar demanda** (já abre com cliente, endereços, contatos e serviço preenchidos e procura os endereços no mapa) |
| Comprovante de Pix (foto ou PDF) | Valor, recebedor, pagador, data e transação; diz se o recebedor é a empresa e aponta qual pedido esperando Pix tem aquele valor, com botão **Confirmar pagamento** |
| Conversa exportada do WhatsApp (.txt ou .zip) | Resumo, pedidos em aberto, pontos de atenção |
| Pergunta livre junto com os arquivos | Resposta direta com base no material |

- Até 6 arquivos por vez. Foto é reduzida no navegador antes de subir (fica leve e sem os dados escondidos da câmera).
- Na aba *WhatsApp*, cada conversa tem o botão **Analisar com IA** (vale para importadas e ao vivo).
- **O arquivo não fica guardado**: só o resultado, nas "Análises anteriores" (as 200 mais recentes).
- Conversa longa: a IA lê as últimas 500 mensagens e a tela avisa quantas ficaram de fora.
- O tipo do arquivo é conferido pelo conteúdo, não pela extensão. Outros tipos são recusados.
- A IA não inventa endereço: campo que o material não traz fica vazio, com a observação do que falta.
- Texto dentro do material que tente dar ordens à IA é ignorado e aparece em "Atenção".

**Comprovante pelo WhatsApp ao vivo:** quando o cliente manda a foto do comprovante, a IA lê e manda a leitura
ao responsável (valor confere ou não, recebedor, alertas). Quem libera continua sendo o responsável (`pago 12`).
Isso depende de o provedor entregar o arquivo junto com a mensagem: no webhook genérico (n8n), mandar `midia_tipo` e `midia_base64` junto.
na configuração do webhook; no webhook genérico, mandar `midia_tipo` e `midia_base64`. Na API da Meta ainda não lê a foto.

O que a IA diz sobre um comprovante é a leitura de uma imagem. Ela não vê a conta: confira no banco.
