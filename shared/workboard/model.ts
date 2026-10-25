// Modelo mínimo da fábrica (Workboard do OpenClaw): só o que o escritório precisa dos quadros e cartões do Gateway.
// Puro (sem Node/DOM). O formato bruto é lido e validado em parse.ts.

/** Os `kind` de `WorkboardCardStage` (@openclaw/workboard-contract). */
export const STAGE_KINDS = [
  'queued',
  'running',
  'questions',
  'grilling',
  'verifying',
  'reviewing',
  'review_incomplete',
  'awaiting_review',
  'published',
  'blocked',
  'review',
  'done',
] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const VERDICTS = ['pass', 'fail', 'error'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * A autonomia da semana do quadro, a mesma do cabeçalho da Factory overview do Workboard ("N of M autonomous this
 * week"): `week` de `workboard.overview`, contada como em `workboard.cards.trust`. Autônomo = aceito sem nenhum toque
 * humano (sem retrabalho, commit de fora nem bloqueio).
 */
export interface FactoryTrust {
  autonomous: number;
  accepted: number;
}

export interface FactoryBoard {
  id: string;
  name: string;
  /** Ausente quando o Gateway não respondeu a `workboard.overview` (ou respondeu fora do formato). */
  trust?: FactoryTrust;
}

export interface FactoryCard {
  id: string;
  boardId: string;
  title: string;
  /** Ausente nos cartões parados (backlog, ideias...) e nos estágios que o Habblaud não conhece. */
  stage: StageKind | undefined;
  /** Desde quando o cartão está no estágio (epoch ms), quando o Gateway informa. */
  stageSince?: number;
  /** Veredito da verificação da rodada atual e quando terminou. */
  verificationVerdict?: Verdict;
  verificationAt?: number;
  pullRequestUrl?: string;
  /** Cartão de teste de harness (`workboard.cards.probe`): nunca aparece. */
  probe: boolean;
}

/** Um instante da fábrica: o que `boards.list` e `cards.list` (um por quadro) devolveram. */
export interface FactoryFrame {
  boards: FactoryBoard[];
  cards: FactoryCard[];
}
