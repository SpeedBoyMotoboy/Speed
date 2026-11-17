# Speed Despacho: contexto completo para continuar em outro chat

> Colar ou anexar este arquivo num chat novo. Escrito em 17/11/2026. Substitui o documento de contexto anterior (16/11).
> **Dono:** Luan, da SpeedBoy Motoboy (Vila Velha/ES). E-mail e senhas não ficam aqui de propósito.

## 1. Instruções para o Claude no chat novo

- Português do Brasil, curto e direto (Luan usa o modo "caveman": frases curtas, resultado primeiro).
- Código no GitHub `SpeedBoyMotoboy/Speed`. Trabalhar na branch `claude/new-session-83gqyr` (ou criar nova a partir dela).
- Testes: `cd server && npm test` (54 passando em 17/11).
- **Nunca** apagar o volume Docker `despacho_dados` (é o banco) nem mexer nos projetos `n8n-un0s` e `traefik` da VPS.
- Senhas, tokens e chaves: o Luan digita no painel. Nunca pedir para colar no chat nem pôr em código.
- Decisão de dinheiro, preço e contrato com motoboy é do Luan.
- O chat na nuvem **não alcança** a VPS, o Chrome do Luan nem a API da Anthropic (proxy bloqueia). Testes de IA e Pix foram feitos com serviços simulados.

## 2. O que é o sistema

Sistema interno da SpeedBoy para: convocar motoboys, rastrear localização no turno, receber pedidos (site, WhatsApp, painel, API), cobrar por Pix, distribuir automaticamente e pagar motoboys. Separado do app de clientes (`SpeedBoy-APP`) e do site (`speedboy-site`, speedboy.com.br, que outra equipe/IA está editando).

| Parte | Pasta | Função |
|---|---|---|
| Servidor + painel | `server/` (Node 22, SQLite embutido, sem framework) | Regras, banco, painel em `/painel/` |
| Tela do motoboy | `server/public/app/` | Dentro do app Android em `/app/` |
| Pedido do cliente | `server/public/pedir/` | Entrega urgente com preço e Pix |
| Acompanhamento | `server/public/acompanhar/?c=CÓDIGO` | Etapas, Pix pendente, motoboy no mapa (opcional) |
| App Android | `android/` | WebView + rastreio em segundo plano |

## 3. Endereços e acessos

| Item | Valor |
|---|---|
| Repositório | `https://github.com/SpeedBoyMotoboy/Speed` |
| Branch que a VPS usa | `claude/motoboy-tracking-app-t4fcoj` (PR #1 já juntado nela em 16/11 22:28 UTC) |
| Branch de trabalho | `claude/new-session-83gqyr` = tudo do PR #1 + 1 commit novo (`867602f`, ajustes da IA) ainda não juntado |
| Painel | https://despacho.srv2150999.hstgr.cloud/painel/ (usuário `admin`) |
| VPS | Hostinger KVM 1, `srv2150999.hstgr.cloud`, IP `187.53.104.158`, Ubuntu 24.04, Traefik + n8n já rodando |
| Código na VPS | `/opt/speed-src`; compose em `/docker/despacho/docker-compose.yml`; contêiner `despacho-speed-1` |

## 4. Funcionalidades (todas no código; ver seção 7 para o que está no ar)

**Base (já existia):** cadastro de motoboys, convocação, login com PIN e termo, turno de 8 h, rastreio GPS, alertas (parado, sem sinal, GPS falso/desligado, salto, fora do local, troca de aparelho, carga pendente), despacho automático pelo menor acréscimo de km, almoço, relatório de diárias, importação de conversa do WhatsApp.

**Entrega urgente (`/pedir/`):** "Motoboy em até 30 minutos" (configurável). Cliente informa coleta, entrega, tipo de serviço; vê preço; paga Pix; pedido só é oferecido aos motoboys depois de pago. Cores do speedboy.com.br.

**Preço:** (valor base + km além do incluído, respeitando o mínimo) + adicional do tipo de serviço. Distância = linha reta × 1,35, ou pelas ruas com chave gratuita do OpenRouteService. Tipos de serviço padrão: Entrega de documento ou encomenda; Ida e volta; Cartório ou protocolo; Xerox ou impressão + entrega; Visita ou vistoria com fotos; Compra e entrega (valores editáveis no painel).

**Pix (decisão do Luan: Pix na própria chave, sem taxa):** sistema gera copia e cola (BR Code conferido contra o exemplo do Banco Central) com valor e `PEDIDO<n>`; QR desenhado no navegador. Cliente manda comprovante pelo WhatsApp. Luan libera pelo botão "Confirmar pagamento" ou respondendo `pago 12` (cancelar: `cancelar 12`) no WhatsApp do robô. Pix manual não cancela sozinho; lembra o responsável. Mercado Pago continua como opção automática (taxa 0,99% por Pix).

**Motoboys:** *Diária* (convocado, cumpre turno, recebe diária; demanda comum vai direto para ele). *Avulso* (entra/sai quando quer, recebe oferta se estiver perto, aceita ou recusa, repasse por entrega). Oferta urgente vai a todos online até 5 km da coleta; primeiro que aceita leva; raio dobra a cada 1,5 min sem aceite; responsável avisado após 5 min. Repasse padrão 60% do valor, mínimo R$ 15 (Luan: "50% a 70%, mínimo R$ 15"), ajustável por tipo de serviço. Avulso vê o valor antes de aceitar e os ganhos do turno.

**Cliente fixo:** fatura mensal, percentual próprio da tabela; pedido pelo site só sai após confirmar pelo WhatsApp dele ou aprovação no painel.

**WhatsApp automático (não ligado ainda):** robô de **menu fixo** (não é conversa por IA): pedir motoboy, acompanhar, atendente. Avisos automáticos ao cliente, convocação do motoboy, alertas ao responsável. Atendente responde pela aba WhatsApp. Provedores: Evolution API, Meta Cloud API ou webhook genérico (n8n/Make). Guia: `deploy/evolution.md` (não testado na VPS).

**IA (Claude, modelo padrão `claude-opus-5-5`; opções Sonnet 5.5 e Haiku 5.5):** precisa de chave da API (console.anthropic.com → Billing com crédito → API Keys). Sem chave fica desligada e os pedidos seguem normais.
- Confere cada pedido (site e WhatsApp): identifica o tipo de serviço pela descrição (cliente vê o preço corrigido antes de pagar), segura pedido duvidoso para aprovação, escreve resumo. Recebe só endereços e descrição, nunca nome/telefone.
- Aba **IA** do painel: até 6 fotos, PDFs ou conversas (.txt/.zip) com pergunta livre → resumo, pedidos prontos com botão "Criar demanda" preenchido, leitura de comprovante (valor, recebedor, qual pedido pendente tem aquele valor). Arquivo não é guardado, só o resultado.
- Botão "Analisar com IA" em cada conversa da aba WhatsApp.
- Comprovante enviado como foto no WhatsApp: IA lê e manda a leitura ao responsável (quem libera continua sendo ele).

**Relatórios:** por motoboy (diárias + repasses), por cliente (a cobrar), entrega por entrega (valor, repasse, o que fica), com CSV.

## 5. Arquivos principais

| Arquivo | Função |
|---|---|
| `server/src/servico.js` | Regras: turnos, demandas, preço, ofertas, repasse, pagamento, relatórios |
| `server/src/atendimento.js` | Site, robô, avisos, fila de envio, Pix, IA, análise de arquivos |
| `server/src/robo.js` | Conversa do robô (função pura) |
| `server/src/ia.js` | Chamadas à API da Anthropic (SDK `@anthropic-ai/sdk` 1.9.0, saída estruturada, fallback) |
| `server/src/pix.js` | BR Code (Pix copia e cola) |
| `server/src/mensageiro.js` | Provedores de WhatsApp |
| `server/src/mercadopago.js` | Pix automático (opcional) |
| `server/src/db.js` | Esquema, configurações padrão, migração automática do banco antigo |
| `docs/novidades-v2.md` | Detalhe de cada etapa e comandos de publicação |
| `docs/ponte.md` | Ficha para as outras IAs/pessoas (site, app, WhatsApp, dados pessoais para a política de privacidade) |

## 6. Atualizar a VPS (hPanel → VPS → Gerenciar → Console web)

Cópia de segurança antes:

```bash
docker cp despacho-speed-1:/dados/speed.db /root/speed-backup-$(date +%F).db
```

Atualizar (pega tudo, inclusive o commit novo):

```bash
cd /opt/speed-src && git fetch origin claude/new-session-83gqyr && git checkout claude/new-session-83gqyr && git pull && docker build -t speed-despacho:latest . && cd /docker/despacho && docker compose up -d
```

Ver log: `docker logs --tail 100 despacho-speed-1`. O banco antigo é atualizado sozinho (testado).

## 7. Situação em 17/11/2026

**Feito e verificado:** todo o código acima, 54 testes, fluxo completo no navegador (pedido → Pix → confirmação → oferta → aceite), instalação de produção simulada a partir de cópia limpa do GitHub, chamada real do SDK contra API simulada.

**Não verificado:** se a VPS já foi atualizada (o chat não alcança); IA com chave real; Pix lido no app de um banco real; Evolution API na VPS.

**Último assunto:** Luan disse "A IA não foi implementada". Verificado: está implementada e no GitHub; provavelmente aparece desligada (sem chave) ou a VPS não foi atualizada. Perguntado se ele queria a IA **conduzindo a conversa do robô no WhatsApp** (hoje é menu fixo). **Sem resposta ainda.**

## 8. Pendências

1. Atualizar a VPS (seção 6) e confirmar que aparece a aba **IA**.
2. Colar a chave da IA e clicar em "Testar a IA".
3. Configurações: chave Pix (tipo, chave, nome, cidade), WhatsApp do comprovante, "Antes de despachar" = "Cliente paga no meu Pix e manda o comprovante", preços, valor de cada tipo de serviço, cidade base `Espírito Santo`, centro do mapa `-20.3358`, `-40.2969`, horário (seg a sex 7h–22h, coletas até 18h), diária.
4. Ligar o WhatsApp: `bash /opt/speed-src/deploy/whatsapp-instalar.sh` na VPS (sobe a Evolution, liga ao painel, mostra o código para conectar o celular; não testado na VPS real). Site: botão para `https://despacho.srv2150999.hstgr.cloud/pedir/` (equipe do site).
5. Cadastrar motoboys (diária ou avulso). Gerar APK (variável `SPEED_SERVIDOR` no GitHub).
6. Revisar o termo do motoboy com advogado/contador (não cobre o avulso; risco de vínculo).
7. Fazer um Pix de valor baixo lendo o QR no app do banco antes de divulgar.
8. Juntar o commit `867602f` (branch `claude/new-session-83gqyr`) na branch da VPS, se for usar o comando antigo de atualização.
9. "Ponte" com outras IAs: Luan não explicou o que é. Ficha pronta em `docs/ponte.md`.
10. Decidir se a IA deve conduzir a conversa do WhatsApp.
