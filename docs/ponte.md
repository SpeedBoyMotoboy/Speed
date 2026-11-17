> **DESATUALIZADO.** O documento atual é `docs/PROJETO.md`. A conexão do WhatsApp por Evolution/QR code citada aqui foi REMOVIDA (risco de banimento); só vale a Cloud API oficial da Meta em coexistência.

# Speed Despacho: ficha para as outras IAs e pessoas da equipe

Este arquivo é o ponto de contato do projeto **Speed Despacho** (repositório `SpeedBoyMotoboy/Speed`).
Quem cuida do site, do app de clientes, do WhatsApp ou do financeiro encontra aqui o que este sistema
oferece, o que ele espera dos outros e o que ainda não está pronto. Atualizado em 16/11/2026.

## 1. Situação agora

| Item | Estado |
|---|---|
| Código novo (pedido urgente, Pix, avulso, IA) | Na branch `claude/new-session-83gqyr`, PR `SpeedBoyMotoboy/Speed#1`, 50 testes passando |
| Produção (`https://despacho.srv2150999.hstgr.cloud`) | **Ainda na versão antiga.** As páginas `/pedir/` e `/acompanhar/` só existem depois que o Luan atualizar a VPS |
| WhatsApp automático | Programado, **não ligado** (falta escolher e conectar o provedor) |
| Pix | Programado. Opção escolhida pelo Luan: Pix na chave da empresa, com comprovante. Falta preencher a chave no painel |
| IA que confere pedidos | Programada, falta a chave de API no painel |

**Consequência para o site:** não publique botão apontando para `/pedir/` antes de a VPS ser atualizada;
até lá o endereço responde "página não encontrada".

## 2. Endereços (depois da atualização)

| Endereço | Para quem | O que é |
|---|---|---|
| `/pedir/` | Cliente | Entrega urgente: endereços, tipo de serviço, preço na hora, Pix |
| `/acompanhar/?c=CÓDIGO` | Cliente | Etapas do pedido; mostra o Pix enquanto não foi pago |
| `/app/` | Motoboy | Tela do motoboy (dentro do app Android) |
| `/painel/` | Luan | Operação, motoboys, WhatsApp, relatório, configurações |
| `/saude` | Monitoramento | Responde `{"ok":true}` |

Domínio próprio (ex.: `pedidos.speedboy.com.br`) ainda não existe. Para criar: DNS apontando para
`187.53.104.158`, trocar o `Host(...)` no compose da VPS e o campo "Endereço deste sistema" no painel.

## 3. Para quem cuida do site (speedboy.com.br)

- **Use link, não moldura.** O sistema envia `X-Frame-Options: DENY` e `frame-ancestors 'none'`: iframe não abre.
- **O site não consegue chamar a API pelo navegador.** Não há CORS liberado. Uma calculadora de preço dentro
  do site exigiria liberar isso aqui; peça a este projeto antes de construir.
- Botão sugerido: "Entrega urgente" → `https://despacho.srv2150999.hstgr.cloud/pedir/`. A página já usa as cores do site.
- O prazo mostrado ("Motoboy em até 30 minutos") é configurável no painel. Não prometa outro número no site.
- O preço é calculado pelo sistema (base + km + tipo de serviço). Não escreva valores fixos no site que possam contradizer.
- O canal principal continua sendo o WhatsApp `(27) 99916-5959`; quando o robô for ligado, ele atende nesse canal.

### Dados pessoais (para a política de privacidade)

| Dado | De quem | Para quê | Onde fica |
|---|---|---|---|
| Nome, WhatsApp, endereços de coleta e entrega, descrição do pedido | Cliente | Executar a entrega, avisar e cobrar | Banco do sistema, na VPS (Hostinger, Brasil) |
| E-mail | Cliente | Só se o Pix for pelo Mercado Pago (comprovante) | Idem |
| Conversa do WhatsApp com o robô | Cliente | Atendimento | Idem |
| Localização em tempo real | Motoboy, só durante o turno | Despacho e acompanhamento | Idem; apagada após 90 dias (configurável) |
| Nome, WhatsApp e último endereço no aparelho | Cliente | Preencher o próximo pedido | `localStorage` do navegador do próprio cliente |

Terceiros que recebem dados, e só quando o recurso está ligado:

| Terceiro | O que recebe | Quando |
|---|---|---|
| OpenStreetMap (Nominatim) | Texto do endereço | Sempre que um endereço é procurado no mapa |
| OpenRouteService | Coordenadas de coleta e entrega | Só se a chave de rota for preenchida |
| Anthropic (IA) | Endereços e descrição do pedido, **sem nome nem telefone** | Só com a conferência por IA ligada |
| Mercado Pago | Valor, e-mail e código do pedido | Só se o Pix automático for escolhido |
| Provedor de WhatsApp (Meta oficial ou n8n) | Telefone e mensagens | Só com o WhatsApp automático ligado |

Não há cookies de rastreio nem analytics. O único cookie é o de login do painel do administrador.
O cliente só vê o motoboy no mapa se o Luan ligar essa opção (está desligada; o termo do motoboy precisa prever).
Pedidos e clientes não são apagados sozinhos: não prometa prazo de exclusão automática.

## 4. Para quem cuida do app de clientes (SpeedBoy-APP)

Entrada de demandas de servidor para servidor:

```
POST https://despacho.srv2150999.hstgr.cloud/api/entrada/demandas
X-Api-Key: <chave gerada no painel>
Content-Type: application/json

{ "cliente": "Loja X", "cliente_telefone": "27999990000", "requisito": "qualquer", "descricao": "2 caixas",
  "coleta":  { "endereco": "Rua A, 100, Centro, Vila Velha", "contato": "Maria" },
  "entrega": { "endereco": "Rua B, 200, Centro, Vitória", "contato": "João" } }
```

- A chave é secreta: **nunca** no código do app ou do navegador; só em servidor ou automação (Make, n8n).
- `requisito`: `qualquer`, `moto`, `bau` ou `bag`. Pode mandar `lat`/`lon` em cada ponto se já tiver.
- Resposta: `{ "id": 12, "status": "aguardando" | "sem_local" }`. `sem_local` = o mapa não achou o endereço; o Luan marca no painel.
- Demanda criada assim é **comum** (não urgente): vai direto para o motoboy de diária, sem Pix e sem oferta.
- A resposta ainda não devolve o link de acompanhamento. Se o app precisar, peça a este projeto.

## 5. Para quem cuida do WhatsApp e do atendimento

- O robô atende no número da empresa: menu → coleta → entrega → descrição → preço → confirma → Pix → acompanha.
- Com a IA ligada, o cliente só descreve o serviço; ela identifica o tipo (entrega, cartório, xerox, visita...).
- "Atendente" passa a conversa para uma pessoa. A pessoa responde pela aba *WhatsApp* do painel.
- O cliente recebe aviso automático: motoboy a caminho, coletado, entregue, cancelado.
- Comandos do responsável (só do número cadastrado): `pago 12` libera o pedido, `cancelar 12` cancela.
- Aba *IA* do painel: quem atende envia fotos, prints, comprovantes, PDFs ou conversas exportadas; a IA devolve os pedidos prontos para virar demanda e a leitura do comprovante. O arquivo não fica guardado.
- Provedores aceitos: WhatsApp Cloud API (Meta) ou webhook genérico (n8n/Make), só oficiais. Detalhes e no README.

## 6. Regras que valem para todos

| Assunto | Regra |
|---|---|
| Preço | (valor base + km além do incluído, respeitando o mínimo) + adicional do tipo de serviço. Tudo definido no painel |
| Pagamento | Pedido urgente só é oferecido aos motoboys depois de pago. Cliente fixo vai para fatura mensal |
| Motoboy diária | Convocado, cumpre turno, recebe diária. Demanda comum vai direto para ele |
| Motoboy avulso | Entra quando quer, aceita oferta se estiver perto, recebe repasse por entrega (padrão 60%, mínimo R$ 15) |
| Cidades | Vila Velha, Vitória, Serra, Cariacica, Viana |
| Horário | Atendimento seg a sex 7h às 22h; coletas até 18h (configurável no painel) |

## 7. Como pedir algo a este projeto

- Mudança de código: branch a partir de `claude/new-session-83gqyr` (ou da `main`, depois do merge) e `npm test` dentro de `server/`.
- Nunca colocar senha, token ou chave em código, commit ou conversa. Chaves entram pelo painel, digitadas pelo Luan.
- Na VPS: não mexer nos projetos `n8n-un0s` e `traefik`; nunca apagar o volume `despacho_dados` (é o banco).
- Decisão de dinheiro, de preço ou de contrato com motoboy é do Luan. As IAs propõem; ele aprova.

## 8. Pendências do Luan

1. Atualizar a VPS (comandos em `docs/novidades-v2.md`).
2. No painel: chave Pix, preços, valor de cada tipo de serviço, cidade base e centro do mapa.
3. Ligar o WhatsApp automático e colar a chave da IA.
4. Cadastrar os motoboys (diária ou avulso).
5. Revisar o termo do motoboy com advogado ou contador (o texto atual não cobre o avulso).
