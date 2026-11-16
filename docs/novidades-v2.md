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
| `server/src/mensageiro.js` | Evolution API, Meta Cloud API e webhook genérico |
| `server/public/pedir/`, `acompanhar/`, `site/` | Páginas públicas |
| `deploy/evolution.md` | Guia para subir a Evolution API na VPS |

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
4. WhatsApp automático: ver `deploy/evolution.md`. Sem isso o robô e os avisos ficam desligados; o site de pedidos funciona com aprovação no painel.
5. "Cliente vê o motoboy no mapa": só ligar depois de incluir isso no termo do motoboy.

## Limites

- Evolution API não é oficial do WhatsApp (risco de bloqueio do número). A API oficial da Meta exige modelo aprovado para mensagem fora da janela de 24 h.
- O robô entende texto e localização; áudio e foto ele pede para escrever.
- Endereço que o mapa não acha entra como "sem local" e o responsável é avisado.
