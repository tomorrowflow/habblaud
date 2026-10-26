# A fábrica do OpenClaw no escritório

Nota de design. Situação: **fatias 1 e 2 prontas** (modo demonstração, cliente do Gateway, filtro do World e modo
portal; ver `server/README.md`); da fatia 3, a parte do Habblaud está pronta (placas, chão de fábrica e "Abrir
cartão"), a entrada no menu do Workboard (fork do OpenClaw) ainda não; a fatia 4 ainda não existe.

A "fábrica" é o plugin Workboard do [OpenClaw](https://github.com/openclaw/openclaw) rodando no Gateway: cada quadro
(board) é um projeto, cada cartão (card) é um tíquete que um nó (máquina de build) executa com `claude -p`, um
verificador de outro modelo confere a rodada e um operador (ou um agente, no degrau b) aceita, pede retrabalho ou
publica o PR. A interface do Workboard já mostra isso como kanban e "Factory overview". O Habblaud mostra a mesma
coisa como escritório, **ao lado das suas sessões interativas**, e leva o "precisa de você" da fábrica para o mod do
Claude Code.

O Habblaud só **reflete** o quadro. Decisões (aceitar, retrabalho, responder perguntas, encerrar o grill) continuam no
Workboard, onde ficam o processo e o histórico.

## O que vira o quê

| Workboard | Habblaud |
| --- | --- |
| Quadro (`boardId`) | Uma sala, id `workboard:<boardId>`, com o nome do quadro e cara de "chão de fábrica". Nunca se mistura com a sala da pasta do mesmo repositório |
| Cartão em andamento | Um personagem, com aparência sorteada do `cardId` (o mesmo nas rodadas de retrabalho) |
| Verificação e sessão de grill | Personagens à parte, que vão até a mesa do cartão enquanto trabalham |
| Cartões na fila | Só uma placa "N na fila" na sala |
| Cartões concluídos, backlog e probes (`[PROBE:<braço>]`) | Não aparecem |
| "N de M autônomos" da semana (`week` de `workboard.overview`, o cabeçalho da Factory overview) | Placa na sala. O degrau de confiança é por classe de cartão, não por quadro: não aparece |

Estágio (`WorkboardCardStage`, derivado pelo Gateway) para status e efeito:

| Estágio | Status | Efeito |
| --- | --- | --- |
| `running`, `grilling`, `verifying`, `reviewing` | `working` | |
| `questions`, `awaiting_review`, `review_incomplete`, `blocked` | `waiting` ("precisa de você") | |
| `queued` | (placa da fila) | |
| `published` | | festa |
| verificação `fail` | | alarme |

O balão mostra só o estágio e o título do cartão: nada de ferramenta por ferramenta (os transcripts dos nós só chegam
ao Gateway de madrugada, e o objetivo é o fluxo do projeto, não cada edição). Clicar no personagem é só leitura, com o
link "Abrir cartão" (Control UI, `HABBLAUD_WORKBOARD_UI_URL`). Sem link de transcript: o token de portal do agentplay
pede `operator.write`, que o Habblaud não tem.

`provider` continua dizendo a ferramenta (`claude`); a origem fábrica vai num campo próprio (`factory`) do agente e da
sala, que é o que o resto do Habblaud usa para tratar esses agentes à parte.

## De onde vêm os dados

Um serviço próprio (`server/workboard/`), fora do contrato `AgentSource`: aquele contrato é de sessões que crescem
(transcript, terminal, `provider`), e a fábrica chega como um retrato inteiro do quadro que substitui o anterior. O
serviço fala com o WebSocket do Gateway como um dispositivo pareado com escopo `operator.read` (desafio assinado com
Ed25519 do `node:crypto`, sem dependência nova), escuta `plugin.workboard.changed` (só um sinal de "mudou", sem dados),
relê `workboard.boards.list`, `workboard.cards.list` e `workboard.overview` e entrega ao `Office` a projeção pura de
`shared/workboard/` (a mesma do modo demonstração). O `Office` guarda essa projeção como guarda a do demo: uma camada à parte, juntada no
snapshot, fora de `Office.list()`, que é o que alimenta o World.

Descartado: `openclaw workboard list --json` (a documentação do Workboard avisa que o acesso local pela CLI não é
seguro com o Gateway rodando, e não é ao vivo) e o pacote `@openclaw/gateway-client` (traria dependências de runtime).

## Onde roda

- **Portal no host do Gateway:** o Habblaud fica em `localhost` e o Gateway o publica como Portal (proxy reverso com
  origem própria). Conecta ao Gateway por loopback, então o pareamento é aprovado sozinho. Pede um modo portal,
  opcional (`HABBLAUD_PORTAL=1`): a borda aceita `Host: localhost:<porta>` com `Origin` igual a `X-Forwarded-Host`
  (a mesma regra do agentplay), a instância inteira fica só leitura (terminal, permissões, mensagens, histórico,
  personagem, demo e `/api/world/*` fechados), qualquer que seja o endereço de quem pede: pelo proxy, todo pedido
  chega de `127.0.0.1`, e quem abre o portal é um cliente da rede, não o usuário local e nunca manda `X-Frame-Options`.
  `HABBLAUD_WORLD=0` nessa instância.
- **Portal com o Habblaud no Docker:** o Gateway escuta só no loopback do host, e o loopback do container é outro. Abrir
  o Gateway na rede do Docker o deixaria ao alcance de qualquer container, inclusive as sandboxes dos agentes do
  OpenClaw, e ele não escuta em socket Unix. Então, com `HABBLAUD_WORKBOARD_URL` no loopback, o `npm run docker:up`
  põe o container na rede do host (`network_mode: host`, sem porta publicada) e o servidor escuta só em `127.0.0.1`.
  O container perde o isolamento de rede, mas fica igual ao `npm start` nisso e mantém o resto (somente leitura, sem
  capabilities, usuário `node`, só as pastas das conversas montadas). Como a conexão chega ao Gateway pelo loopback, o
  pareamento continua aprovado sozinho. O acesso remoto não combina com isso: o `docker:up` recusa os dois juntos.
- **Estação de trabalho:** a mesma fonte, conectando ao Gateway pela rede (pareamento aprovado à mão uma vez). Os
  agentes da fábrica aparecem no escritório, mas **não sobem para o Habblaud World**: rodam nos nós, não "nesta
  máquina", e os Termos de Uso pedem os dados do escritório real deste computador. O filtro fica em
  `shared/world/projection.ts`, pelo campo `factory`. Para mostrá-los no prédio, só com o aval de quem opera o World.

## Fatias

1. **Mapeamento e demonstração.** `shared/workboard/`: tipos mínimos lidos do formato do Gateway (validados na
   borda), a tabela de estágios e a projeção pura para salas e agentes, com testes. Um roteiro de exemplo no formato
   real do `workboard.cards.list` (escrito à mão a partir do contrato `@openclaw/workboard-contract`, não gravado de
   um Gateway) entra no modo demonstração, com o prefixo `demo:`, que nunca sobe para o World. Sem rede.
2. **Cliente do Gateway e modo portal.** O serviço da fábrica (`server/workboard/`), o handshake e o pareamento, o modo portal e
   o filtro do World (antes de qualquer agente real da fábrica entrar no `Office`). Teste aberto à mão como Portal.
3. **OpenClaw e acabamento.** Entrada "Office" no menu do Workboard (no fork do OpenClaw, no mesmo molde do visor de
   transcripts: porta na configuração, RPC, página e `portal.open`), os links do personagem, a placa da fila, a placa
   de confiança e a cara de chão de fábrica.
4. **Estação de trabalho.** Conexão remota e pareamento manual.
