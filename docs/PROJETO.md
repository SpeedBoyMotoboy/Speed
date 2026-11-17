# Speed Despacho: documento completo do projeto

Versão de 17/11/2026. Dono: Luan, SpeedBoy Motoboy (Vila Velha/ES).
Descreve o que o sistema é e faz, com todos os endereços e onde fica cada chave. Não traz regra de integração: isso é decisão do Luan.

---

## 1. Links

| O quê | Endereço |
|---|---|
| Painel do administrador | https://despacho.srv2150999.hstgr.cloud/painel/ |
| Pedido de entrega urgente (cliente) | https://despacho.srv2150999.hstgr.cloud/pedir/ |
| Acompanhamento de pedido (cliente) | https://despacho.srv2150999.hstgr.cloud/acompanhar/?c=CÓDIGO |
| Tela do motoboy (dentro do app Android) | https://despacho.srv2150999.hstgr.cloud/app/ |
| Teste de saúde | https://despacho.srv2150999.hstgr.cloud/saude → `{"ok":true}` |
| Teste de versão nova | https://despacho.srv2150999.hstgr.cloud/api/publico/info → deve trazer `"empresa"` |
| Entrada de pedidos por API | https://despacho.srv2150999.hstgr.cloud/api/entrada/demandas |
| Webhook de mensagens do WhatsApp | https://despacho.srv2150999.hstgr.cloud/api/whatsapp/webhook?s=SEGREDO |
| Aviso de pagamento do Mercado Pago | https://despacho.srv2150999.hstgr.cloud/api/pagamento/mp?s=SEGREDO |
| Repositório | https://github.com/SpeedBoyMotoboy/Speed |
| PR juntado (atendimento, Pix, IA) | https://github.com/SpeedBoyMotoboy/Speed/pull/1 |
| Site da empresa | https://www.speedboy.com.br |
| WhatsApp da empresa | https://wa.me/5527999165959 |
| Chave da IA | https://console.anthropic.com (API Keys, Billing) |
| Credenciais do Mercado Pago | Mercado Pago → Seu negócio → Configurações → Credenciais |
| Chave de rota pelas ruas (opcional) | https://openrouteservice.org |
| Painel da hospedagem | hPanel da Hostinger → VPS → Gerenciar → Console web |

## 2. Chaves, senhas e segredos

Nenhuma chave existe neste chat nem no GitHub. Todas ficam no servidor e são geradas ou digitadas por você.
Abaixo, onde cada uma está e como ver ou trocar.

| Chave | Para quê | Onde está / como obter |
|---|---|---|
| Senha do painel (usuário `admin`) | Entrar no painel | Gerada no primeiro início. Ver: `docker logs despacho-speed-1 2>&1 \| grep -A2 -i admin`. Trocar em Configurações → Senha do painel |
| Chave de API de entrada (`X-Api-Key`) | Outro sistema criar pedidos | Painel → Configurações → Entrada automática → **Gerar nova chave**. Aparece uma vez só; gerar outra cancela a anterior |
| Segredo do webhook (`s=`) | Proteger o webhook do WhatsApp e do Mercado Pago | Painel → Configurações → WhatsApp automático: aparece no endereço do webhook. Criado sozinho ao abrir Configurações pela primeira vez |
| Token da WhatsApp Cloud API | O sistema enviar mensagens | Token permanente de usuário do sistema (Meta Business) ou o que o parceiro oficial fornecer. Colado no painel (campo de senha; não volta para a tela) |
| App Secret da Meta | Conferir a assinatura de cada aviso da Meta | Painel de apps da Meta → Configurações do app → Básico. Colado no painel |
| Chave da IA (`sk-ant-...`) | Conferir pedidos, ler fotos e conversas | console.anthropic.com → API Keys → Create Key. Colada no painel |
| Access Token do Mercado Pago | Pix automático (opcional) | Credenciais de produção do Mercado Pago. Colado no painel |
| Chave do OpenRouteService | Distância pelas ruas (opcional) | openrouteservice.org. Colada no painel |
| Chave Pix da empresa | Pix copia e cola | CNPJ 46.178.859/0001-96 (ou a chave que você escolher). Digitada no painel |
| Chave de assinatura do APK | Atualizar o app sem desinstalar | GitHub → Settings → Secrets: `SPEED_KEYSTORE`, `SPEED_KEYSTORE_SENHA`, `SPEED_KEY_ALIAS` (se criadas) |
| PIN de cada motoboy | Login do motoboy | Definido no cadastro; não aparece depois (só trocar) |

Comando para ver no servidor quais chaves já estão preenchidas (mostra só sim/não, nunca o valor):

```bash
docker exec despacho-speed-1 node --disable-warning=ExperimentalWarning -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/dados/speed.db");for(const k of ["api_chave_hash","whats_segredo","whats_token","ia_chave","mp_token","ors_chave","pix_chave","admin_telefone"])console.log(k.padEnd(16),(db.prepare("SELECT valor FROM config WHERE chave=?").get(k)?.valor||"")!==""?"preenchida":"vazia")'
```

## 3. Servidor (VPS)

| Item | Valor |
|---|---|
| Hospedagem | Hostinger KVM 1, `srv2150999.hstgr.cloud`, IP `187.53.104.158`, Campinas, Ubuntu 24.04, vence 11/11/2027 |
| Já rodava | Traefik (projeto `traefik`, portas 80/443 e HTTPS) e n8n (projeto `n8n-un0s`) |
| DNS | `*.srv2150999.hstgr.cloud` já aponta para a VPS |
| Código | `/opt/speed-src` |
| Compose | `/docker/despacho/docker-compose.yml` (imagem `speed-despacho:latest`, contêiner `despacho-speed-1`, porta interna 3000) |
| Banco | volume Docker `despacho_dados` → `/dados/speed.db` (SQLite). **Nunca apagar** |
| Variáveis | `TRUST_PROXY=1`, `TZ=America/Sao_Paulo` |

Comandos:

| Para quê | Comando |
|---|---|
| Cópia do banco | `docker cp despacho-speed-1:/dados/speed.db /root/speed-backup-$(date +%F).db` |
| Atualizar | `cd /opt/speed-src && git fetch origin claude/new-session-83gqyr && git checkout claude/new-session-83gqyr && git pull && docker build -t speed-despacho:latest . && cd /docker/despacho && docker compose up -d` |
| Log | `docker logs --tail 100 despacho-speed-1` |
| Reiniciar | `cd /docker/despacho && docker compose restart` |
| Atualizar (script, com cópia do banco) | `bash /opt/speed-src/deploy/atualizar.sh` |

**Publicação automática (GitHub → VPS).** A cada mudança juntada na branch principal (`claude/motoboy-tracking-app-t4fcoj`), o GitHub roda os testes e, se passarem, manda a VPS rodar `deploy/atualizar.sh`: cópia do banco em `/root/speed-backups` (30 últimas), baixa a versão, compila e troca o contêiner. Se a compilação falhar, o sistema no ar continua como estava. Dá para disparar à mão em GitHub → Actions → **Publicar na VPS** → Run workflow.

- Preparar (uma vez, na VPS): `bash /opt/speed-src/deploy/preparar-atualizacao-automatica.sh`. Cria a chave `/root/.ssh/speed-github`, que só consegue rodar a atualização, e mostra os valores a cadastrar.
- Segredos no GitHub (Settings → Secrets and variables → Actions): `VPS_HOST`, `VPS_PORTA`, `VPS_KNOWN_HOSTS`, `VPS_SSH_KEY`.
- Sem os segredos, o GitHub só roda os testes e avisa que falta configurar.
- Desligar: apagar a linha `speed-github-publicar` de `/root/.ssh/authorized_keys`.
- A pasta `/opt/speed-src` passa a ficar idêntica à branch principal (mudança feita à mão nela é desfeita).

## 4. Código

| Item | Valor |
|---|---|
| Branch com tudo | `claude/new-session-83gqyr` |
| Branch que a VPS usava | `claude/motoboy-tracking-app-t4fcoj` (tem tudo do PR #1; falta o que veio depois: ajustes da IA, script do WhatsApp e documentos) |
| Tecnologia | Node.js 22, SQLite embutido do Node, sem framework. Dependências: `leaflet` (mapa), `@anthropic-ai/sdk` 1.9.0 (IA), `qrcode-generator` (QR do Pix) |
| Testes | `cd server && npm test` → 54 passando |
| CI do GitHub | `.github/workflows/servidor.yml` (testes), `.github/workflows/android.yml` (APK) |

| Arquivo | Função |
|---|---|
| `server/src/index.js` | Início, admin inicial, rotinas (30 s regras, 10 s ofertas, 5 s envio de mensagens) |
| `server/src/app.js` | Rotas HTTP, segurança, arquivos |
| `server/src/servico.js` | Regras: motoboys, turnos, posições, alertas, demandas, preço, ofertas, repasse, pagamento, relatórios |
| `server/src/despacho.js` | Escolha do motoboy e ordem da rota |
| `server/src/atendimento.js` | Site, robô, avisos, fila de envio, Pix, IA, análise de arquivos |
| `server/src/robo.js` | Conversa do robô do WhatsApp |
| `server/src/ia.js` | Chamadas à IA (Claude) |
| `server/src/pix.js` | Pix copia e cola (BR Code) |
| `server/src/mercadopago.js` | Pix automático |
| `server/src/mensageiro.js` | WhatsApp: Cloud API da Meta (com coexistência e assinatura) e genérico |
| `server/src/whatsapp.js` | Leitura de conversa exportada (.txt/.zip) |
| `server/src/geo.js` | Distância e busca de endereço (OpenStreetMap; OpenRouteService opcional) |
| `server/src/db.js` | Tabelas, configurações padrão, atualização do banco antigo |
| `server/public/painel/` | Painel |
| `server/public/pedir/`, `acompanhar/`, `site/` | Páginas do cliente |
| `server/public/app/` | Tela do motoboy |
| `android/` | App Android (Java): WebView + rastreio com tela apagada |
| `deploy/atualizar.sh`, `deploy/preparar-atualizacao-automatica.sh` | Atualização da VPS (manual e automática) |

## 5. O que o sistema faz

### 5.1 Motoboys
- Cadastro: nome, telefone (login), PIN de 6 números, veículo (moto/bike), baú, bag, **tipo**.
- **Diária:** precisa de convocação no dia; turno fixo (8 h, configurável); recebe diária (+ almoço). Demanda comum vai direto para ele.
- **Avulso:** entra quando quer (máx. 12 h online); recebe oferta de entrega se estiver perto; aceita ou recusa; encerra quando quiser, sem entrega aberta; sai sozinho após 30 min sem sinal. Recebe repasse por entrega.
- Convocação manual (painel; mensagem automática se o WhatsApp estiver ligado) ou automática por rodízio (desligada; limite diário).
- Login com termo de ciência e consentimento (versionado). Um aparelho por turno.
- Rastreio: GPS a cada 5 s, envio a cada 15 s, guarda sem internet, volta após reiniciar o celular.
- Almoço: uma vez por turno, sem carga coletada.
- Alertas: parado, sem sinal, GPS desligado, GPS falso, salto de posição, confirmação longe do local (exige justificativa), troca de aparelho, turno encerrado com carga.

### 5.2 Pedidos (demandas)
- Origens: painel, site (`/pedir/`), robô do WhatsApp, API de entrada, análise de arquivo pela IA.
- Status: `sem_local` → `aguardando` → `atribuida` → `coletada` → `entregue` (ou `cancelada`).
- Pedido **retido**: espera aprovação no painel, confirmação do cliente ou pagamento.
- **Urgente** (site e WhatsApp): oferecido a todos online até 5 km da coleta; o primeiro que aceitar leva; raio dobra a cada 1,5 min sem aceite (até 8×); responsável avisado após 5 min.
- **Comum** (painel e API): vai direto ao motoboy de diária com menor acréscimo de km; sem diária disponível, vira oferta aos avulsos.
- Distância: linha reta × 1,35 (ou pelas ruas, com chave do OpenRouteService).
- Capacidade: 4 demandas por motoboy.
- Coleta e entrega entram na rota onde somam menos km (coleta antes da entrega).
- Entrega exige nome de quem recebeu.

### 5.3 Preço e repasse
- Preço = (valor base + km além dos incluídos × valor por km, respeitando o mínimo) + adicional do tipo de serviço. Cliente fixo pode ter percentual próprio.
- Tipos de serviço (editáveis): Entrega de documento ou encomenda; Ida e volta (leva e traz); Cartório ou protocolo; Xerox ou impressão + entrega; Visita ou vistoria com fotos; Compra e entrega.
- Repasse ao avulso: 60% do valor (padrão), mínimo R$ 15, ou percentual próprio por tipo de serviço. O avulso vê o valor antes de aceitar e os ganhos do turno.
- Tudo zero = cliente vê "valor a combinar".

### 5.4 Pagamento
- **Pix na chave da empresa** (sem taxa): copia e cola + QR com valor e `PEDIDO<n>`; cliente manda comprovante; responsável confirma no painel ("Confirmar pagamento") ou no WhatsApp (`pago 12` / `cancelar 12`). Não cancela sozinho; lembra o responsável.
- **Mercado Pago** (opcional, 0,99% por Pix): confirma sozinho; cancela se não pago no prazo (30 min).
- **Cliente fixo:** fatura mensal; pedido do site confirmado pelo WhatsApp dele ou no painel.
- Pedido pago e depois cancelado: aviso para devolver o Pix (devolução manual).
- Opções em "Antes de despachar um pedido do site": Pix próprio com comprovante; Mercado Pago; aprovação no painel; confirmação pelo WhatsApp; direto.

### 5.5 WhatsApp
- Provedores: WhatsApp Cloud API da Meta em coexistência (mesmo número no app WhatsApp Business e na API) ou genérico (n8n/Make) ligado a provedor oficial. **Conexão por QR code do WhatsApp Web (Evolution e afins) foi removida: risco de banimento.**
- Coexistência: resposta dada pelo app do celular chega como eco (`smb_message_echoes`), fica registrada e o robô se cala naquele contato por 12 h (`robo_pausa_horas`). Com App Secret salvo, todo aviso exige a assinatura da Meta.
- Fora da janela de 24 h a Meta só aceita modelo aprovado; o sistema ainda não envia modelos, então avisos e convocações para quem não escreveu recentemente falham (aparecem no painel).
- Robô de menu fixo: 1 pedir motoboy, 2 acompanhar, 3 atendente. Fluxo: coleta (texto ou localização) → confirma no mapa → entrega → descrição → (tipo de serviço) → resumo com preço → confirma → Pix. Lembra o último endereço de coleta do cliente.
- Atendente assume pela aba WhatsApp; cliente volta ao robô com "menu".
- Avisos ao cliente: motoboy a caminho (com link), coletado, entregue, cancelado, pagamento confirmado.
- Avisos ao motoboy: convocação, entrega disponível (com valor, se avulso).
- Avisos ao responsável: pedido sem local, pedido para aprovar, Pix pendente, comprovante recebido (com leitura da IA), cliente pedindo atendente, sem aceite, alertas de rota, devolução de Pix.
- Fila de envio com até 6 tentativas.
- Mensagem de motoboy cadastrado não aciona o robô.
- Importação de conversas exportadas (.txt/.zip).

### 5.6 IA (Claude)
- Modelo padrão `claude-opus-5-5`; opções `claude-sonnet-5-5` e `claude-haiku-5-5`. Sem chave, fica desligada e o resto funciona.
- Confere cada pedido do site e do WhatsApp: identifica o tipo de serviço pela descrição (preço corrigido antes de pagar), segura pedido duvidoso, escreve resumo. Recebe só endereços e descrição.
- Aba **IA**: até 6 fotos, PDFs ou conversas, com pergunta livre → resumo, resposta, pedidos com "Criar demanda" preenchido, leitura de comprovante (valor, recebedor, pedido compatível), alertas. Só o resultado é guardado (200 últimas).
- "Analisar com IA" em cada conversa da aba WhatsApp.
- Comprovante enviado como foto no WhatsApp: leitura vai ao responsável.

### 5.7 Painel
Abas: Operação (mapa ao vivo, fila, aprovações, alertas, motoboys em turno, "Falta configurar"), Motoboys, WhatsApp, IA, Relatório, Configurações. Som e contador no título quando chega pedido, alerta ou cliente esperando.

### 5.8 Relatórios (com CSV)
- Por motoboy: diárias, horas, entregas, km, minutos parado, alertas, repasses, total a pagar.
- Por cliente: entregas, km, valor (a cobrar).
- Entrega por entrega: cliente, serviço, motoboy, tipo, valor, repasse, o que fica.

## 6. API (todas as rotas)

Base: `https://despacho.srv2150999.hstgr.cloud`

| Acesso | Método e rota | Função |
|---|---|---|
| público | `GET /saude` | Saúde |
| público | `GET /api/termo` | Termo do motoboy |
| público | `GET /api/publico/info` | Nome, horário, mapa, prazo, tipos de serviço, forma de pagamento |
| público | `POST /api/publico/cotar` | Preço e distância de um trajeto |
| público | `POST /api/publico/pedidos` | Pedido pelo site |
| público | `GET /api/publico/pedido?c=CÓDIGO` | Situação de um pedido |
| segredo `s=` | `GET/POST /api/whatsapp/webhook` | Mensagens recebidas do WhatsApp (GET = verificação da Meta) |
| segredo `s=` | `POST /api/pagamento/mp` | Aviso do Mercado Pago |
| `X-Api-Key` | `POST /api/entrada/demandas` | Criar pedido de outro sistema |
| login motoboy | `POST /api/motoboy/login`; `GET /api/motoboy/estado`; `POST /api/motoboy/posicoes`, `/parada`, `/oferta`, `/encerrar`, `/almoco` | App do motoboy |
| login admin (cookie + `X-Speed: 1`) | `POST /api/admin/login`, `/logout`, `/senha` | Acesso |
| admin | `GET /api/admin/estado` | Tudo da tela de operação |
| admin | `POST /api/admin/motoboys`; `PUT /api/admin/motoboys/:id`; `POST .../convocar`, `.../desconvocar` | Motoboys |
| admin | `POST /api/admin/turnos/:id/encerrar`; `GET /api/admin/turnos/:id/trilha` | Turnos |
| admin | `POST /api/admin/demandas`; `PUT .../:id/locais`; `POST .../:id/atribuir`, `/cancelar`, `/liberar`, `/pago` | Pedidos |
| admin | `GET /api/admin/geocode?q=` | Busca de endereço |
| admin | `GET /api/admin/relatorio?de=&ate=` | Relatórios |
| admin | `GET/POST /api/admin/servicos`; `GET/POST /api/admin/clientes` | Tipos de serviço e clientes |
| admin | `POST/GET /api/admin/whatsapp`; `GET/DELETE /api/admin/whatsapp/:id`; `POST .../:id/responder`, `/modo`, `/analisar`; `POST /api/admin/whatsapp-teste` | Conversas |
| admin | `POST/GET /api/admin/analises`; `POST /api/admin/ia-teste` | IA |
| admin | `GET/PUT /api/admin/config`; `POST /api/admin/chave-api` | Configurações |

Formato do pedido por API:

```json
{ "cliente": "Loja X", "cliente_telefone": "27999990000", "requisito": "qualquer",
  "descricao": "2 caixas",
  "coleta":  { "endereco": "Rua A, 100, Centro, Vila Velha", "contato": "Maria", "lat": null, "lon": null },
  "entrega": { "endereco": "Rua B, 200, Centro, Vitória", "contato": "João", "lat": null, "lon": null } }
```
Resposta: `{ "id": 12, "status": "aguardando" | "sem_local" }`. `requisito`: `qualquer`, `moto`, `bau`, `bag`.

Formato do WhatsApp genérico: entrada `{ telefone, nome, texto, lat, lon, midia_tipo, midia_base64 }`; saída (o sistema envia) `POST { telefone, texto }` com `Authorization: Bearer <chave>`.

Não existe hoje: consulta por chave do estado da operação (motoboys, fila, alertas, relatórios) e aviso de saída quando um pedido muda de status.

## 7. Banco de dados (`/dados/speed.db`)

| Tabela | Conteúdo |
|---|---|
| `config` | Configurações (seção 8) |
| `admins`, `sessoes` | Acesso (senhas em scrypt, tokens só em hash) |
| `motoboys`, `convocacoes`, `turnos`, `posicoes`, `alertas` | Operação dos motoboys |
| `demandas` | Pedidos (endereços, status, valor, repasse, pagamento, Pix, IA) |
| `ofertas` | Ofertas a motoboys (aberta, aceita, recusada, encerrada) |
| `servicos` | Tipos de serviço |
| `clientes` | Clientes (fixo/fatura, % da tabela, último endereço, e-mail) |
| `conversas`, `mensagens` | WhatsApp (importado e ao vivo) |
| `saida` | Fila de mensagens a enviar |
| `analises` | Resultados da IA |
| `auditoria` | Tudo que o admin e o sistema fazem |

## 8. Configurações (padrão)

| Chave | Padrão | Chave | Padrão |
|---|---|---|---|
| horas_turno | 8 | preco_base / preco_km_incluso / preco_km / preco_minimo | 0 |
| prorrogacao_max_min | 120 | urgente_prazo_min | 30 |
| parado_min | 8 | repasse_pct | 60 |
| espera_parada_min | 20 | repasse_minimo | 15 |
| sem_sinal_min | 3 | oferta_raio_km | 5 |
| cerca_m | 150 | oferta_alerta_min | 5 |
| bike_max_km | 5 | avulso_max_horas | 12 |
| capacidade | 4 | site_confirmacao | painel |
| retencao_dias | 90 | pagamento_validade_min | 30 |
| diaria_valor / almoco_valor | 0 | pix_tipo | cnpj |
| almoco_min | 60 | pedidos_site | sim |
| cidade_base | vazio | rastreio_cliente | não |
| mapa_lat / mapa_lon | -23.5505 / -46.6333 (São Paulo) | atendimento_inicio / fim | vazio (sempre) |
| empresa_nome | SpeedBoy | robo_ativo / avisos_cliente | sim |
| cidades_atendidas | Vila Velha, Vitória, Serra, Cariacica, Viana | convocacao_auto | não (máx. 3/dia, após 3 min) |
| ia_ativa / ia_modelo | sim / claude-opus-5-5 | whats_provedor | vazio (desligado) |

## 9. Dados da empresa

| Campo | Valor |
|---|---|
| Nome | SpeedBoy Motoboy |
| Endereço | R. Henrique Laranja, 325, Centro, Vila Velha/ES, CEP 29106-690 |
| WhatsApp | (27) 99916-5959 |
| CNPJ | 46.178.859/0001-96 |
| Horário | Seg a sex, 7h às 22h; coletas até 18h |
| Cidades | Vila Velha, Vitória, Serra, Cariacica, Viana |
| Coordenadas | -20.3357855, -40.2968724 |

## 10. Situação em 17/11/2026

- **Pronto e testado:** tudo da seção 5 (54 testes, fluxo completo no navegador, instalação de produção simulada, chamada à IA testada contra API simulada).
- **Não verificado:** se a VPS já está na versão nova; IA com chave real; Pix lido no app de um banco; WhatsApp Cloud API com conta real da Meta.
- **Falta preencher no painel:** preços, tipos de serviço, diária, cidade base (`Espírito Santo`), centro do mapa (`-20.3358`, `-40.2969`), horário, chave Pix, WhatsApp do responsável e da empresa, chave da IA, conexão do WhatsApp.
- **Falta fazer:** cadastrar motoboys (diária/avulso); gerar o APK (variável `SPEED_SERVIDOR` = `https://despacho.srv2150999.hstgr.cloud` no GitHub); revisar o termo do motoboy com advogado ou contador (não cobre o avulso).
- **Limites:** sem app de iPhone; robô do WhatsApp é de menu (a IA confere, não conversa); envio de modelo aprovado (fora da janela de 24 h) não implementado.
