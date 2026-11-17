#!/usr/bin/env bash
# Liga o WhatsApp da empresa ao Speed Despacho, na mesma VPS.
#
# O que faz (pode rodar de novo sem estragar nada):
#   1. Sobe a Evolution API (conexão com o WhatsApp) em /docker/evolution, com senhas aleatórias.
#   2. Cria a conexão "speed" já apontando para o Speed Despacho (mensagens e fotos).
#   3. Grava no Speed Despacho o endereço e a chave da Evolution (ninguém precisa copiar chave).
#   4. Mostra o código para conectar o celular da empresa.
#
# Uso, no Console web da VPS, depois de atualizar o Speed Despacho:
#   bash /opt/speed-src/deploy/whatsapp-instalar.sh
#
# Não mexe no n8n, no Traefik nem no banco de pedidos (só na tabela de configurações).
set -euo pipefail

BASE="${BASE:-srv2150999.hstgr.cloud}"
EVO_HOST="evolution.$BASE"
DESPACHO_HOST="despacho.$BASE"
PASTA=/docker/evolution
CONTAINER_DESPACHO=despacho-speed-1
INSTANCIA=speed
IMAGEM=evoapicloud/evolution-api:v2.3.7

falha() { echo; echo "ERRO: $*" >&2; exit 1; }
passo() { echo; echo "==> $*"; }

[ "$(id -u)" = 0 ] || falha "rode como root (o Console web da Hostinger já entra como root)."
command -v docker >/dev/null || falha "Docker não encontrado."
command -v curl >/dev/null || falha "curl não encontrado."
command -v openssl >/dev/null || falha "openssl não encontrado."

passo "Conferindo o Speed Despacho"
docker inspect "$CONTAINER_DESPACHO" >/dev/null 2>&1 || falha "contêiner $CONTAINER_DESPACHO não existe."
codigo=$(curl -s -o /dev/null -w '%{http_code}' "https://$DESPACHO_HOST/api/publico/info" || true)
[ "$codigo" = 200 ] || falha "o Speed Despacho no ar ainda é a versão antiga (resposta $codigo). Atualize antes (comandos em docs/contexto-chat.md, seção 6)."
echo "ok: versão nova no ar."

# Lê e grava configurações do Speed Despacho direto no banco dele (dentro do contêiner).
config() {
  docker exec -i "$CONTAINER_DESPACHO" node --disable-warning=ExperimentalWarning -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/dados/speed.db");
    db.exec("PRAGMA busy_timeout = 5000");
    let entrada = "";
    process.stdin.on("data", (c) => { entrada += c; }).on("end", () => {
      const pedido = JSON.parse(entrada);
      const gravar = db.prepare("UPDATE config SET valor = ? WHERE chave = ?");
      for (const [k, v] of Object.entries(pedido.gravar || {})) {
        if (gravar.run(String(v), k).changes !== 1) { console.error("chave desconhecida: " + k); process.exit(2); }
      }
      const ler = db.prepare("SELECT valor FROM config WHERE chave = ?");
      console.log(JSON.stringify(Object.fromEntries((pedido.ler || []).map((k) => [k, ler.get(k)?.valor ?? null]))));
    });'
}
campo() { node_json="$1"; chave="$2"; printf '%s' "$node_json" | sed -n "s/.*\"$chave\":\"\([^\"]*\)\".*/\1/p"; }

passo "Preparando a pasta $PASTA"
mkdir -p "$PASTA"
cd "$PASTA"
if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
EVO_API_KEY=$(openssl rand -hex 24)
EVO_DB_SENHA=$(openssl rand -hex 16)
EOF
  echo "senhas novas criadas em $PASTA/.env (guardadas só nesta VPS)."
else
  echo "reaproveitando as senhas de $PASTA/.env."
fi
# shellcheck disable=SC1091
. ./.env

cat > docker-compose.yml <<EOF
# Evolution API: conexão do WhatsApp da empresa com o Speed Despacho.
# Gerado por /opt/speed-src/deploy/whatsapp-instalar.sh. Senhas em .env.
services:
  evolution:
    image: $IMAGEM
    restart: unless-stopped
    ports:
      - "8080"
    environment:
      - SERVER_URL=https://$EVO_HOST
      - SERVER_PORT=8080
      - AUTHENTICATION_API_KEY=\${EVO_API_KEY}
      - DEL_INSTANCE=false
      - LANGUAGE=pt-BR
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://evolution:\${EVO_DB_SENHA}@postgres:5432/evolution?schema=evolution_api
      - DATABASE_CONNECTION_CLIENT_NAME=speed
      - CACHE_REDIS_ENABLED=true
      - CACHE_REDIS_URI=redis://redis:6379/6
      - CACHE_REDIS_PREFIX_KEY=evolution
      - CACHE_LOCAL_ENABLED=false
      - WEBHOOK_GLOBAL_ENABLED=false
      - TZ=America/Sao_Paulo
    volumes:
      - instancias:/evolution/instances
    depends_on:
      - postgres
      - redis
    labels:
      - traefik.enable=true
      - traefik.http.routers.evolution.rule=Host(\`$EVO_HOST\`)
      - traefik.http.routers.evolution.entrypoints=websecure
      - traefik.http.routers.evolution.tls.certresolver=letsencrypt
      - traefik.http.services.evolution.loadbalancer.server.port=8080
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=evolution
      - POSTGRES_PASSWORD=\${EVO_DB_SENHA}
      - POSTGRES_DB=evolution
    volumes:
      - banco:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - cache:/data

volumes:
  instancias:
  banco:
  cache:
EOF

passo "Subindo a Evolution API (a primeira vez baixa as imagens, pode levar alguns minutos)"
docker compose up -d

passo "Esperando a Evolution responder em https://$EVO_HOST"
pronto=""
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null -H "apikey: $EVO_API_KEY" "https://$EVO_HOST/instance/fetchInstances"; then pronto=1; break; fi
  sleep 5
done
[ -n "$pronto" ] || falha "a Evolution não respondeu em 5 minutos. Veja: cd $PASTA && docker compose logs --tail 80 evolution"
echo "ok."

passo "Configurando o Speed Despacho"
atual=$(echo '{"ler":["whats_segredo","admin_telefone","robo_ativo","url_publica"]}' | config)
segredo=$(campo "$atual" whats_segredo)
if [ -z "$segredo" ]; then segredo=$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '='); fi
responsavel=$(campo "$atual" admin_telefone)
if [ -z "$responsavel" ]; then
  read -r -p "WhatsApp do responsável, que recebe os avisos (DDD + número, ex.: 27999165959): " responsavel
  responsavel=$(printf '%s' "$responsavel" | tr -cd '0-9')
  responsavel=${responsavel#55}
  [ ${#responsavel} -ge 10 ] && [ ${#responsavel} -le 11 ] || falha "telefone inválido. Rode de novo."
fi
echo
echo "O robô responde automaticamente TODO MUNDO que escrever para o número da empresa (inclusive clientes antigos)."
read -r -p "Ligar o robô agora? (s = sim / n = deixar só as conversas no painel) [n]: " ligar
case "$ligar" in s|S|sim|SIM) robo=1 ;; *) robo=0 ;; esac

printf '{"gravar":{"whats_provedor":"evolution","whats_url":"https://%s","whats_instancia":"%s","whats_token":"%s","whats_segredo":"%s","admin_telefone":"%s","robo_ativo":"%s","url_publica":"https://%s"}}' \
  "$EVO_HOST" "$INSTANCIA" "$EVO_API_KEY" "$segredo" "$responsavel" "$robo" "$DESPACHO_HOST" | config >/dev/null
docker restart "$CONTAINER_DESPACHO" >/dev/null
echo "ok: Speed Despacho ligado à Evolution (robô $([ "$robo" = 1 ] && echo ligado || echo desligado))."

passo "Criando a conexão \"$INSTANCIA\" e apontando as mensagens para o Speed Despacho"
webhook="https://$DESPACHO_HOST/api/whatsapp/webhook?s=$segredo"
existe=$(curl -fs -H "apikey: $EVO_API_KEY" "https://$EVO_HOST/instance/fetchInstances?instanceName=$INSTANCIA" || true)
if printf '%s' "$existe" | grep -q "\"$INSTANCIA\""; then
  echo "a conexão já existe; atualizando o endereço das mensagens."
  curl -fs -o /dev/null -X POST -H "apikey: $EVO_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"webhook\":{\"enabled\":true,\"url\":\"$webhook\",\"byEvents\":false,\"base64\":true,\"events\":[\"MESSAGES_UPSERT\"]}}" \
    "https://$EVO_HOST/webhook/set/$INSTANCIA" || falha "não consegui atualizar o webhook da conexão."
else
  curl -fs -o /dev/null -X POST -H "apikey: $EVO_API_KEY" -H 'Content-Type: application/json' \
    -d "{\"instanceName\":\"$INSTANCIA\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true,\"groupsIgnore\":true,\"rejectCall\":false,\"webhookUrl\":\"$webhook\",\"webhookByEvents\":false,\"webhookBase64\":true,\"webhookEvents\":[\"MESSAGES_UPSERT\"]}" \
    "https://$EVO_HOST/instance/create" || falha "não consegui criar a conexão. Veja: cd $PASTA && docker compose logs --tail 80 evolution"
fi
echo "ok."

passo "Conectar o celular da empresa"
read -r -p "Número do WhatsApp da EMPRESA, o que vai atender (DDD + número) [27999165959]: " numero
numero=$(printf '%s' "${numero:-27999165959}" | tr -cd '0-9'); numero=${numero#55}
resposta=$(curl -fs -H "apikey: $EVO_API_KEY" "https://$EVO_HOST/instance/connect/$INSTANCIA?number=55$numero" || true)
codigo=$(printf '%s' "$resposta" | sed -n 's/.*"pairingCode":"\([^"]*\)".*/\1/p')
echo
if [ -n "$codigo" ]; then
  echo "  No celular da empresa: WhatsApp → ⋮ → Aparelhos conectados → Conectar aparelho"
  echo "  → \"Conectar com número de telefone\" e digite o código:"
  echo
  echo "        $codigo"
  echo
  echo "  (o código vale poucos minutos; se vencer, rode o script de novo)"
else
  echo "  Não veio código. Conecte pelo QR code:"
fi
echo "  Ou pelo QR: abra https://$EVO_HOST/manager , entre com a chave abaixo, clique em \"$INSTANCIA\" e em Conectar."
echo "  Chave do gerenciador (fica salva em $PASTA/.env): $EVO_API_KEY"

cat <<EOF

==============================================================
 Pronto. Para conferir:
   1. Painel → Configurações → WhatsApp automático → "Enviar mensagem de teste"
      (chega no WhatsApp do responsável).
   2. De outro celular, mande "oi" para o número da empresa:
      o robô responde, ou a conversa aparece na aba WhatsApp do painel.
   Para ligar/desligar o robô depois: Configurações → "Robô atende e monta o pedido sozinho".
 Logs da Evolution:  cd $PASTA && docker compose logs --tail 80 evolution
==============================================================
EOF
