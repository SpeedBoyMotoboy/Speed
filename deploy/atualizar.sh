#!/usr/bin/env bash
# Atualiza o Speed Despacho na VPS com a versão mais nova da branch principal do GitHub.
# Roda sozinho quando o GitHub publica (chave restrita, ver preparar-atualizacao-automatica.sh)
# e também pode ser rodado à mão:  bash /opt/speed-src/deploy/atualizar.sh
#
# Se a compilação falhar, o sistema que está no ar continua rodando como estava.
set -euo pipefail

# Este arquivo está dentro da pasta que vai ser atualizada: roda a partir de uma cópia.
if [ "${SPEED_COPIA:-}" != 1 ]; then
  copia=$(mktemp /tmp/speed-atualizar.XXXXXX)
  cp "$0" "$copia"
  SPEED_COPIA=1 exec bash "$copia" "$@"
fi
trap 'rm -f "$0"' EXIT

RAMO="${SPEED_RAMO:-claude/motoboy-tracking-app-t4fcoj}"
FONTE="${SPEED_FONTE:-/opt/speed-src}"
COMPOSE="${SPEED_COMPOSE:-/docker/despacho}"
CONTAINER=despacho-speed-1
COPIAS="${SPEED_COPIAS:-/root/speed-backups}"
ENDERECO="${SPEED_ENDERECO:-https://despacho.srv2150999.hstgr.cloud}"

# Uma atualização por vez.
exec 9>/tmp/speed-atualizar.lock
flock -n 9 || { echo "Já tem uma atualização rodando. Tente de novo em alguns minutos."; exit 1; }

echo "==> Cópia de segurança do banco"
mkdir -p "$COPIAS"
docker cp "$CONTAINER:/dados/speed.db" "$COPIAS/speed-$(date +%F-%H%M%S).db"
ls -1t "$COPIAS"/speed-*.db | tail -n +31 | xargs -r rm -f   # guarda as 30 últimas
echo "ok ($COPIAS)"

echo "==> Baixando a versão nova ($RAMO)"
cd "$FONTE"
antes=$(git rev-parse --short HEAD)
git fetch -q origin "$RAMO"
# A pasta é só cópia de publicação: fica idêntica ao GitHub.
git checkout -q -B "$RAMO" FETCH_HEAD
git reset -q --hard FETCH_HEAD
depois=$(git rev-parse --short HEAD)
echo "versão: $antes -> $depois ($(git log -1 --format=%s))"

echo "==> Compilando"
docker build -q -t speed-despacho:latest . >/dev/null

echo "==> Trocando o contêiner"
cd "$COMPOSE"
docker compose up -d

echo "==> Conferindo"
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "$ENDERECO/saude"; then
    echo "ok: no ar com a versão $depois."
    exit 0
  fi
  sleep 2
done
echo "ERRO: o sistema não respondeu em 60 s depois da troca. Veja: docker logs --tail 100 $CONTAINER" >&2
exit 1
