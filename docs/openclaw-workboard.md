# A fábrica do OpenClaw no escritório

Nota de design. Situação: **fatia 1 pronta** (só no modo demonstração); as outras ainda não existem.

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
| Degrau de confiança e "N de M autônomos" (`projectWorkboardTrust`) | Placa na sala |

Estágio (`WorkboardCardStage`, derivado pelo Gateway) para status e efeito:

| Estágio | Status | Efeito |
| --- | --- | --- |
| `running`, `grilling`, `verifying`, `reviewing` | `working` | |
| `questions`, `awaiting_review`, `review_incomplete`, `blocked` | `waiting` ("precisa de você") | |
| `queued` | (placa da fila) | |
| `published` | | festa |
| verificação `fail` | | alarme |

O balão mostra só o estágio e o título do cartão: nada de ferramenta por ferramenta (os transcripts dos nós só chegam
ao Gateway de madrugada, e o objetivo é o fluxo do projeto, não cada edição). Clicar no personagem é só leitura, com
dois links: "Abrir cartão" (Control UI) e "Transcript" (`/card/<cardId>` do agentplay).

`provider` continua dizendo a ferramenta (`claude`); a origem fábrica vai num campo próprio (`factory`) do agente e da
sala, que é o que o resto do Habblaud usa para tratar esses agentes à parte.

## De onde vêm os dados

`WorkboardSource`, uma terceira fonte no contrato `AgentSource` (`server/sources/source.ts`), ao lado da do Claude
Code e da do Codex. Ela fala com o WebSocket do Gateway como um dispositivo pareado com escopo `operator.read`
(desafio assinado com Ed25519 do `node:crypto`, sem dependência nova), escuta `plugin.workboard.changed` (só um sinal
de "mudou", sem dados) e relê `workboard.boards.list`, `workboard.overview` e `workboard.cards.list`. A tradução de
cartões para salas e personagens é uma função pura em `shared/workboard/`, a mesma que o modo demonstração usa.

Descartado: `openclaw workboard list --json` (a documentação do Workboard avisa que o acesso local pela CLI não é
seguro com o Gateway rodando, e não é ao vivo) e o pacote `@openclaw/gateway-client` (traria dependências de runtime).

## Onde roda

- **Portal no host do Gateway:** o Habblaud fica em `localhost` e o Gateway o publica como Portal (proxy reverso com
  origem própria). Conecta ao Gateway por loopback, então o pareamento é aprovado sozinho. Pede um modo portal,
  opcional (`HABBLAUD_PORTAL=1`): a borda aceita `Host: localhost:<porta>` com `Origin` igual a `X-Forwarded-Host`
  (a mesma regra do agentplay), o Habblaud fica só leitura (terminal, permissões, mensagens e `/api/world/*`
  fechados, porque quem abre o portal é um cliente da rede, não o usuário local) e nunca manda `X-Frame-Options`.
  `HABBLAUD_WORLD=0` nessa instância.
- **Estação de trabalho:** a mesma fonte, conectando ao Gateway pela rede (pareamento aprovado à mão uma vez). Os
  agentes da fábrica aparecem no escritório, mas **não sobem para o Habblaud World**: rodam nos nós, não "nesta
  máquina", e os Termos de Uso pedem os dados do escritório real deste computador. O filtro fica em
  `shared/world/projection.ts`, pelo campo `factory`. Para mostrá-los no prédio, só com o aval de quem opera o World.

## Fatias

1. **Mapeamento e demonstração.** `shared/workboard/`: tipos mínimos lidos do formato do Gateway (validados na
   borda), a tabela de estágios e a projeção pura para salas e agentes, com testes. Um roteiro de exemplo no formato
   real do `workboard.cards.list` (escrito à mão a partir do contrato `@openclaw/workboard-contract`, não gravado de
   um Gateway) entra no modo demonstração, com o prefixo `demo:`, que nunca sobe para o World. Sem rede.
2. **Cliente do Gateway e modo portal.** O `WorkboardSource` de verdade, o handshake e o pareamento, o modo portal e
   o filtro do World (antes de qualquer agente real da fábrica entrar no `Office`). Teste aberto à mão como Portal.
3. **OpenClaw e acabamento.** Entrada "Office" no menu do Workboard (no fork do OpenClaw, no mesmo molde do visor de
   transcripts: porta na configuração, RPC, página e `portal.open`), os links do personagem, a placa da fila, a placa
   de confiança e a cara de chão de fábrica.
4. **Estação de trabalho.** Conexão remota e pareamento manual.
