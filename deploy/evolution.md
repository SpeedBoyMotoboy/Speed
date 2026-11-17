# WhatsApp com Evolution API na mesma VPS

**Jeito fácil (recomendado):** depois de atualizar o Speed Despacho, rode no Console web da VPS:

```bash
bash /opt/speed-src/deploy/whatsapp-instalar.sh
```

O script sobe a Evolution (versão fixa v2.3.7), cria a conexão `speed` já apontando para o sistema, grava a chave no painel sozinho e mostra o código para conectar o celular. Pergunta antes de ligar o robô. O passo a passo manual abaixo fica como referência.

Guia de partida. **Não foi testado nesta VPS**: confira as variáveis na documentação oficial
(https://doc.evolution-api.com) antes de subir, porque mudam entre versões.

## 1. Subir a Evolution API

Crie `/docker/evolution/docker-compose.yml` (projeto separado; não mexe no n8n nem no Traefik):

```yaml
services:
  evolution:
    image: evoapicloud/evolution-api:latest
    restart: unless-stopped
    ports:
      - "8080"
    environment:
      - SERVER_URL=https://evolution.srv2150999.hstgr.cloud
      - AUTHENTICATION_API_KEY=TROQUE_POR_UMA_CHAVE_LONGA
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://evolution:TROQUE_A_SENHA@postgres:5432/evolution
      - CACHE_REDIS_ENABLED=true
      - CACHE_REDIS_URI=redis://redis:6379/1
      - CACHE_LOCAL_ENABLED=false
    volumes:
      - instancias:/evolution/instances
    depends_on: [postgres, redis]
    labels:
      - traefik.enable=true
      - traefik.http.routers.evolution.rule=Host(`evolution.srv2150999.hstgr.cloud`)
      - traefik.http.routers.evolution.entrypoints=websecure
      - traefik.http.routers.evolution.tls.certresolver=letsencrypt
      - traefik.http.services.evolution.loadbalancer.server.port=8080
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=evolution
      - POSTGRES_PASSWORD=TROQUE_A_SENHA
      - POSTGRES_DB=evolution
    volumes:
      - banco:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    restart: unless-stopped

volumes:
  instancias:
  banco:
```

```bash
cd /docker/evolution && docker compose up -d
```

## 2. Conectar o número

1. Abra `https://evolution.srv2150999.hstgr.cloud/manager` e entre com a API key.
2. Crie uma instância (ex.: `speed`) e leia o QR code com o WhatsApp da empresa.
3. Na instância, em **Webhook**: cole o endereço que o painel do Speed Despacho mostra em
   *Configurações → WhatsApp automático* e marque só o evento `MESSAGES_UPSERT`.

## 3. Ligar no Speed Despacho

*Configurações → WhatsApp automático*:

| Campo | Valor |
|---|---|
| Conexão | Evolution API |
| Endereço do servidor | `https://evolution.srv2150999.hstgr.cloud` |
| Instância | `speed` |
| Chave de acesso | a API key do passo 1 |
| WhatsApp do responsável | seu número |

Salve e clique em **Enviar mensagem de teste**.

## Cuidados

- Evolution usa o WhatsApp Web por baixo (não é oficial): use um número da empresa, não o pessoal,
  e evite disparo em massa, que pode levar a bloqueio do número.
- A VPS KVM 1 já roda n8n. Evolution + Postgres + Redis consomem memória: acompanhe com `docker stats`.
