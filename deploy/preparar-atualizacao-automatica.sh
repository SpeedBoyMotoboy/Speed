#!/usr/bin/env bash
# Prepara a VPS para o GitHub publicar o Speed Despacho sozinho. Rodar UMA vez, no Console web:
#   bash /opt/speed-src/deploy/preparar-atualizacao-automatica.sh
#
# Cria uma chave SSH que só consegue rodar a atualização (deploy/atualizar.sh): não abre terminal,
# não copia arquivo, não faz túnel. Mostra no fim os três valores para cadastrar no GitHub.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Rode como root."; exit 1; }
PASTA=/root/.ssh
CHAVE=$PASTA/speed-github
COMANDO='bash /opt/speed-src/deploy/atualizar.sh'

mkdir -p "$PASTA"
chmod 700 "$PASTA"
touch "$PASTA/authorized_keys"
chmod 600 "$PASTA/authorized_keys"

if [ ! -f "$CHAVE" ]; then
  ssh-keygen -q -t ed25519 -N '' -C speed-github-publicar -f "$CHAVE"
fi
publica=$(cat "$CHAVE.pub")
# Troca a linha antiga desta chave (se houver) pela versão restrita.
grep -v 'speed-github-publicar' "$PASTA/authorized_keys" > "$PASTA/authorized_keys.novo" || true
echo "restrict,command=\"$COMANDO\" $publica" >> "$PASTA/authorized_keys.novo"
mv "$PASTA/authorized_keys.novo" "$PASTA/authorized_keys"
chmod 600 "$PASTA/authorized_keys"

porta=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
porta=${porta:-22}
ip=$(curl -fs -4 https://ifconfig.me || hostname -I | awk '{print $1}')
conhecidos=$(ssh-keyscan -p "$porta" -t ed25519 127.0.0.1 2>/dev/null | sed "s/^[^ ]*/$ip/")
[ "$porta" = 22 ] || conhecidos=$(printf '%s' "$conhecidos" | sed "s/^$ip/[$ip]:$porta/")

cat <<EOF

==================================================================
 Cadastre no GitHub: repositório Speed → Settings → Secrets and variables
 → Actions → aba "Secrets" → New repository secret. Crie estes:

 1) Nome: VPS_HOST
    Valor: $ip

 2) Nome: VPS_PORTA
    Valor: $porta

 3) Nome: VPS_KNOWN_HOSTS
    Valor (uma linha):
$conhecidos

 4) Nome: VPS_SSH_KEY
    Valor (copie TUDO, da linha BEGIN até a linha END, inclusive):
EOF
cat "$CHAVE"
cat <<EOF

 Esta chave só roda a atualização do Speed Despacho. Depois de colar no GitHub,
 limpe a tela com o comando: clear
 Para cancelar a publicação automática: apague a linha "speed-github-publicar"
 de /root/.ssh/authorized_keys.
==================================================================
EOF
