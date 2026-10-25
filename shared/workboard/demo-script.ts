// Roteiro do modo demonstração: cartões que andam por filas, construção, verificação (com uma reprovação e o retrabalho),
// revisão e publicação, no formato das respostas do Gateway (`workboard.boards.list`, `workboard.cards.list`).
// Escrito à mão a partir do contrato @openclaw/workboard-contract, não gravado de um Gateway.

/** Um instante bruto, como `parseFrame` o recebe. */
export interface RawFrame {
  boards: object[];
  cards: Record<string, { cards: object[]; statuses: readonly string[] }>;
}

interface ScriptCard {
  id: string;
  boardId: string;
  title: string;
  pr?: string;
  /** Um estágio por quadro do roteiro: `kind`, ou `kind:n` (rodada de retrabalho) / `kind:pass|fail` (veredito da verificação). */
  beats: readonly string[];
  /** Cartão de teste de harness: tem o estágio de um cartão qualquer e nunca deve aparecer. */
  probe?: true;
}

const BOARDS = [
  { id: 'loja', name: 'Loja online' },
  { id: 'pagamentos', name: 'API de pagamentos' },
] as const;

const STATUSES = ['triage', 'backlog', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done'] as const;

const CARDS: readonly ScriptCard[] = [
  {
    id: 'wb-101',
    boardId: 'loja',
    title: 'Checkout com Pix',
    pr: 'https://github.com/acme/loja/pull/42',
    beats: ['queued', 'queued', 'running', 'running', 'verifying', 'awaiting_review:fail', 'running:1', 'running:1', 'verifying', 'verifying', 'awaiting_review:pass', 'awaiting_review:pass', 'published', 'published', 'done', 'done'],
  },
  {
    id: 'wb-102',
    boardId: 'loja',
    title: 'Corrigir a rolagem do carrinho no celular',
    beats: ['queued', 'queued', 'queued', 'queued', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'verifying', 'verifying', 'awaiting_review:pass', 'awaiting_review:pass', 'done'],
  },
  {
    id: 'wb-201',
    boardId: 'pagamentos',
    title: 'Idempotência nos webhooks',
    pr: 'https://github.com/acme/pagamentos/pull/57',
    beats: ['running', 'running', 'grilling', 'grilling', 'grilling', 'running', 'running', 'running', 'reviewing', 'reviewing', 'awaiting_review:pass', 'published', 'published', 'done', 'done', 'done'],
  },
  {
    id: 'wb-202',
    boardId: 'pagamentos',
    title: 'Paginar a listagem de pedidos',
    beats: ['queued', 'queued', 'queued', 'queued', 'queued', 'running', 'questions', 'questions', 'questions', 'questions', 'running', 'running', 'running', 'blocked', 'blocked', 'done'],
  },
  {
    id: 'wb-203',
    boardId: 'pagamentos',
    title: '[PROBE:sem-skill] Idempotência nos webhooks',
    probe: true,
    beats: Array.from({ length: 16 }, () => 'running'),
  },
  {
    id: 'wb-204',
    boardId: 'pagamentos',
    title: 'Pesquisar outro gateway de cartão',
    beats: Array.from({ length: 16 }, () => 'backlog'),
  },
];

export const DEMO_FRAME_COUNT = CARDS[0].beats.length;

const STATUS_OF: Record<string, string> = {
  backlog: 'backlog',
  queued: 'todo',
  running: 'running',
  blocked: 'blocked',
  done: 'done',
};
const statusOf = (kind: string): string => STATUS_OF[kind] ?? 'review';

function stageOf(kind: string, detail: string | undefined, since: number, card: ScriptCard): object | undefined {
  const rework = Number(detail) || 0;
  switch (kind) {
    case 'backlog':
      return undefined;
    case 'running':
      return { kind, since, nodeId: 'node-build-1', reworkRound: rework };
    case 'grilling':
      return { kind, since, round: 1 };
    case 'review_incomplete':
      return { kind, since, missing: ['verdict'] };
    case 'published':
      return { kind, since, pullRequestUrl: card.pr, reworkRound: 1 };
    default:
      return { kind, since };
  }
}

function rawCard(card: ScriptCard, beat: string, since: number, index: number): object {
  const [kind, detail] = beat.split(':');
  const verdict = detail === 'pass' || detail === 'fail' ? detail : undefined;
  const raw: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    status: statusOf(kind),
    priority: 'normal',
    labels: [],
    position: index,
    createdAt: since - 3_600_000,
    updatedAt: since,
  };
  const stage = stageOf(kind, detail, since, card);
  if (stage) raw.stage = stage;
  if (kind === 'grilling') raw.grill = { status: 'open', rounds: 1, attachmentId: 'att-1' };
  if (card.pr && kind === 'published') raw.pullRequestUrl = card.pr;
  const metadata: Record<string, unknown> = {};
  if (card.probe) metadata.automation = { probe: { of: 'wb-201', arm: 'sem-skill', createdAt: since - 600_000 } };
  if (verdict) {
    raw.rounds = [{ round: 1 }];
    metadata.automation = {
      target: {
        kind: 'node-claude',
        nodeId: 'node-build-1',
        repoPath: '/srv/repos/app',
        worktreesRoot: '/srv/worktrees',
        worktree: {
          path: `/srv/worktrees/${card.id}`,
          branch: `workboard/${card.id}`,
          baseCommit: 'a1b2c3d',
          verification: { phase: 'done', round: 1, headCommit: 'e4f5a6b', startedAt: since - 60_000, endedAt: since, verdict, summary: verdict === 'fail' ? 'O pagamento duplica ao repetir o webhook.' : 'A prova rodou e nada quebrou.', findings: [] },
        },
      },
    };
  }
  if (Object.keys(metadata).length) raw.metadata = metadata;
  return raw;
}

/**
 * O quadro `index` do roteiro, que começou em `startedAt` (os anteriores, `stepMs` antes um do outro): o `since` de
 * cada estágio é o começo da sequência de quadros em que o cartão ficou nele.
 */
export function demoFrame(index: number, startedAt: number, stepMs: number): RawFrame {
  const cards: RawFrame['cards'] = {};
  for (const b of BOARDS) cards[b.id] = { cards: [], statuses: STATUSES };
  CARDS.forEach((card, i) => {
    const beat = card.beats[index];
    let first = index;
    while (first > 0 && card.beats[first - 1] === beat) first--;
    cards[card.boardId].cards.push(rawCard(card, beat, startedAt - (index - first) * stepMs, i));
  });
  const boards = BOARDS.map((b) => {
    const list = cards[b.id].cards as { status: string }[];
    const byStatus: Record<string, number> = {};
    for (const c of list) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return { ...b, kind: 'cards', total: list.length, active: list.filter((c) => c.status !== 'done').length, archived: 0, byStatus };
  });
  return { boards, cards };
}
