// Borda do Gateway: converte as respostas de `workboard.boards.list`, `workboard.cards.list` e `workboard.overview`
// (JSON de fora, não confiável) no modelo mínimo. Tolerante: campos desconhecidos são ignorados, entradas malformadas caem, nunca lança.
import { STAGE_KINDS, VERDICTS, type FactoryBoard, type FactoryCard, type FactoryFrame, type FactoryTrust, type StageKind, type Verdict } from './model';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const oneOf = <T extends string>(set: readonly T[], v: unknown): T | undefined => ((set as readonly unknown[]).includes(v) ? (v as T) : undefined);

/** `[...]` ou `{ <chave>: [...] }`: as duas formas em que o Gateway entrega uma lista. */
function listOf(v: unknown, key: string): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v[key])) return v[key] as unknown[];
  return [];
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** `week` de `workboard.overview` (WorkboardTrustWeek): só as duas contagens, inteiras e coerentes. */
function parseTrust(raw: unknown): FactoryTrust | undefined {
  const week = isObj(raw) && isObj(raw.week) ? raw.week : undefined;
  const autonomous = count(week?.autonomous);
  const accepted = count(week?.accepted);
  if (autonomous === undefined || accepted === undefined || autonomous > accepted) return undefined;
  return { autonomous, accepted };
}

function parseBoard(raw: unknown): FactoryBoard | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  // Quadros de sessões não têm cartões de tíquete; arquivados saem do escritório.
  if (!id || raw.kind === 'sessions' || num(raw.archivedAt) !== undefined) return undefined;
  return { id, name: str(raw.name) ?? id };
}

/** O veredito vale para a rodada atual: o registro de uma rodada anterior é ignorado. */
function parseVerification(raw: Obj): { verdict: Verdict; at?: number } | undefined {
  const target = isObj(raw.metadata) && isObj(raw.metadata.automation) ? raw.metadata.automation.target : undefined;
  const v = isObj(target) && isObj(target.worktree) ? target.worktree.verification : undefined;
  if (!isObj(v) || v.phase !== 'done') return undefined;
  const verdict = oneOf(VERDICTS, v.verdict);
  if (!verdict) return undefined;
  const last = Array.isArray(raw.rounds) ? raw.rounds[raw.rounds.length - 1] : undefined;
  if (isObj(last) && num(last.round) !== undefined && num(v.round) !== undefined && last.round !== v.round) return undefined;
  return { verdict, at: num(v.endedAt) };
}

/** O Gateway só grava `automation.probe` em `cards.probe`; o título `[PROBE:<braço>]` cobre cartões de outra origem. */
function isProbe(raw: Obj, title: string): boolean {
  const automation = isObj(raw.metadata) ? raw.metadata.automation : undefined;
  return (isObj(automation) && isObj(automation.probe)) || /^\[PROBE:[^\]]*\]/.test(title);
}

function parseCard(raw: unknown, boardId: string): FactoryCard | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id);
  const title = str(raw.title);
  if (!id || !title) return undefined;
  if (isObj(raw.metadata) && num(raw.metadata.archivedAt) !== undefined) return undefined;
  const stage = isObj(raw.stage) ? raw.stage : undefined;
  const verification = parseVerification(raw);
  const card: FactoryCard = {
    id,
    boardId,
    title,
    stage: oneOf<StageKind>(STAGE_KINDS, stage?.kind),
    probe: isProbe(raw, title),
  };
  const since = num(stage?.since);
  if (since !== undefined) card.stageSince = since;
  const pr = str(raw.pullRequestUrl) ?? str(stage?.pullRequestUrl);
  if (pr) card.pullRequestUrl = pr;
  if (verification) {
    card.verificationVerdict = verification.verdict;
    if (verification.at !== undefined) card.verificationAt = verification.at;
  }
  return card;
}

/**
 * `raw`: `{ boards, cards, overviews? }`, com `boards` como em `workboard.boards.list`, e `cards` e `overviews` por
 * `boardId`, cada um como em `workboard.cards.list` (a lista, ou `{ cards }`) e em `workboard.overview`. Cartões de
 * quadros desconhecidos caem.
 */
export function parseFrame(raw: unknown): FactoryFrame {
  const frame: FactoryFrame = { boards: [], cards: [] };
  if (!isObj(raw)) return frame;
  const seen = new Set<string>();
  const overviews = isObj(raw.overviews) ? raw.overviews : {};
  for (const b of listOf(raw.boards, 'boards')) {
    const board = parseBoard(b);
    if (board && !seen.has(board.id)) {
      seen.add(board.id);
      const trust = Object.hasOwn(overviews, board.id) ? parseTrust(overviews[board.id]) : undefined;
      if (trust) board.trust = trust;
      frame.boards.push(board);
    }
  }
  if (!isObj(raw.cards)) return frame;
  const cardIds = new Set<string>();
  for (const board of frame.boards) {
    for (const c of listOf(raw.cards[board.id], 'cards')) {
      const card = parseCard(c, board.id);
      if (card && !cardIds.has(card.id)) {
        cardIds.add(card.id);
        frame.cards.push(card);
      }
    }
  }
  return frame;
}
