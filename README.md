# Speed Despacho

Sistema interno da Speed para convocar motoboys, acompanhar a localização durante o turno e
distribuir as demandas automaticamente. É separado do app de clientes.

| Parte | Onde fica | Para quem |
|---|---|---|
| Servidor + painel | `server/` | Você (administração), no navegador: `/painel/` |
| Tela do motoboy | `server/public/app/` | Aparece dentro do app Android: `/app/` |
| App Android | `android/` | Motoboy. Faz o rastreio com a tela apagada |

## Como funciona

1. **Convocar.** No painel, aba *Motoboys*, botão *Convocar*. Sem convocação no dia, o login é recusado.
   O painel abre o WhatsApp com a mensagem pronta para avisar o motoboy.
2. **Login = turno.** O motoboy entra com telefone + senha de 6 números e aceita o termo. O turno dura
   8 h (configurável) e a localização é enviada só nesse período. Não há botão de sair: o turno termina
   sozinho ou você encerra pelo painel.
3. **Demanda.** Você cria no painel (ou ela chega pela entrada automática). O sistema escolhe o motoboy em
   turno que atende a exigência (baú, bag, só moto; bike só em trecho curto) e para quem a demanda soma
   menos quilômetros na rota. Coleta e entrega entram na ordem que encurta o caminho.
4. **Ninguém em turno?** A demanda fica na fila e o painel sugere quem convocar, em rodízio
   (quem está há mais tempo sem diária e tem o equipamento).
5. **Controle.** O painel mostra o mapa ao vivo e abre alerta quando o motoboy:
   fica parado no meio da rota, fica sem sinal, desliga o GPS, usa GPS falso, "pula" de posição,
   confirma coleta/entrega longe do local (o app exige justificativa) ou troca de aparelho.
6. **Almoço.** Uma vez por turno, pelo app, sem carga coletada. Durante o almoço o alerta de parado pausa.
7. **Pagamento.** Aba *Relatório*: diárias, horas, entregas, km, minutos parado em alerta e valor
   (diária + almoço), com planilha para baixar.

## Rodar no computador (teste)

Precisa do Node.js 22.13 ou mais novo.

```bash
cd server
npm install
ADMIN_PASSWORD='escolha-uma-senha-forte' npm start
```

Abra `http://localhost:3000/painel/` (usuário `admin`). A tela do motoboy fica em
`http://localhost:3000/app/` — no navegador serve para testar; o rastreio de verdade é pelo app Android.

Testes: `npm test`.

## Colocar no ar

O servidor precisa de **endereço com HTTPS** (o app Android recusa conexão sem HTTPS) e de **disco
persistente** para a pasta do banco. Há um `Dockerfile` na raiz; qualquer hospedagem que rode Docker com
volume serve (VPS, Railway, Fly.io, Render com disco).

| Variável | Para quê | Padrão |
|---|---|---|
| `ADMIN_PASSWORD` | Senha do painel no primeiro início. Sem ela, uma senha aleatória aparece no log | — |
| `ADMIN_USER` | Usuário do painel | `admin` |
| `DADOS_DIR` | Pasta do banco (monte o volume aqui) | `./dados` (`/dados` no Docker) |
| `PORT` | Porta | `3000` |
| `TRUST_PROXY` | `1` se houver proxy/HTTPS na frente (quase toda hospedagem) | desligado |
| `COOKIE_SECURE` | `1` exige HTTPS no cookie do painel | ligado em produção |
| `TZ` | Fuso horário | `America/Sao_Paulo` |

### Instalação em VPS (Hostinger ou outra)

Precisa de uma VPS com Docker (na Hostinger: VPS KVM com o modelo "Docker") e de um endereço
(ex.: `despacho.suaempresa.com.br`) com registro DNS tipo A apontando para o IP da VPS.
Hospedagem compartilhada de site não serve: o sistema fica ligado o tempo todo e grava o banco em disco.

```bash
git clone https://github.com/SpeedBoyMotoboy/Speed.git && cd Speed
cp .env.example .env      # preencha DOMINIO e ADMIN_PASSWORD
docker compose up -d --build
```

O Caddy tira o certificado HTTPS sozinho. Em um ou dois minutos o painel abre em `https://SEU-DOMINIO/painel/`.
Atualizar depois: `git pull && docker compose up -d --build`.

Faça cópia de segurança do banco de tempos em tempos:
`docker compose cp speed:/dados/speed.db ./speed-backup.db`

## Gerar o app Android (APK)

O GitHub compila sozinho a cada alteração em `android/`:

1. No repositório: *Settings → Secrets and variables → Actions → Variables* → crie `SPEED_SERVIDOR`
   com o endereço do servidor (ex.: `https://despacho.suaempresa.com.br`). Sem isso, o app pergunta o
   endereço na primeira abertura.
2. Aba *Actions* → *App Android (APK)* → *Run workflow*. Ao terminar, baixe `speed-motoboy-apk`.
3. Envie o APK ao motoboy e instale (Android 8 ou mais novo; é preciso permitir "instalar apps desconhecidos").

No primeiro uso o app pede: localização, GPS ligado, notificações e tirar a restrição de bateria
(sem isso alguns celulares matam o rastreio com a tela apagada).

Para atualizar o app sem desinstalar, use sempre a mesma chave de assinatura: variáveis de ambiente
`SPEED_KEYSTORE`, `SPEED_KEYSTORE_SENHA` e `SPEED_KEY_ALIAS` na compilação. A tela do motoboy vem do
servidor, então a maioria das mudanças chega sem precisar de APK novo.

## Entrada automática de demandas

Em *Configurações* gere a chave de API. O app de clientes, um cenário do Make ou um robô de WhatsApp
envia:

```
POST /api/entrada/demandas
X-Api-Key: <chave>
Content-Type: application/json

{ "cliente": "Loja X", "requisito": "bau", "descricao": "2 caixas",
  "coleta":  { "endereco": "Rua A, 100", "contato": "Maria" },
  "entrega": { "endereco": "Rua B, 200", "contato": "João" } }
```

`requisito`: `qualquer`, `moto`, `bau` ou `bag`. O endereço vira ponto no mapa pelo OpenStreetMap; se
não for encontrado, a demanda aparece em *Sem local no mapa* para você marcar. Preencha *Cidade base*
em Configurações para a busca acertar mais.

## Segurança

- Senhas guardadas com scrypt; tokens de sessão guardados só como hash.
- 5 senhas erradas bloqueiam o login por 15 minutos.
- Um aparelho por turno: login novo derruba o anterior e gera alerta.
- A localização só é aceita com turno ativo; posições são apagadas após o prazo de guarda (90 dias, configurável).
- O motoboy só enxerga a própria rota. O painel exige cookie `HttpOnly`/`SameSite=Strict`.
- Tudo que o admin faz (convocar, encerrar turno, trocar motoboy) fica registrado na tabela `auditoria`.

## Limites desta versão

- **iPhone:** não há app; pelo navegador o rastreio só funciona com a tela ligada.
- **Distâncias** são em linha reta com fator de correção, não o trajeto real pelas ruas.
- **Aviso de convocação** é pelo WhatsApp (o app não recebe notificação estando fechado e fora de turno).
- **Termo e modelo de trabalho:** o texto do termo é um modelo. Diária, horário, rastreamento e
  obrigação de atender podem caracterizar vínculo de emprego — revise com advogado ou contador.
