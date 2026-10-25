// A tabela de estágios: para cada `kind` de `WorkboardCardStage`, o que o cartão vira no escritório. É o único lugar
// que decide isso; um estágio novo no modelo não compila até ganhar a sua linha.
import type { FactoryRole } from '../types';
import { tr } from '../i18n';
import type { StageKind } from './model';

/** Personagem à parte que acompanha o construtor enquanto o estágio dura. */
export interface ExtraRole {
  role: Exclude<FactoryRole, 'builder'>;
  label: () => string;
}

export type Place =
  | { kind: 'absent' }
  /** Sem personagem: só entra na contagem "N na fila" da sala. */
  | { kind: 'queue' }
  /** Sem personagem: festa na sala. */
  | { kind: 'party' }
  | { kind: 'character'; status: 'working'; label: () => string; extras: readonly ExtraRole[] }
  | { kind: 'character'; status: 'waiting'; label: () => string; waitingFor: () => string; extras: readonly ExtraRole[] };

export interface StageRule {
  place: Place;
  /** Neste estágio um veredito `fail` da verificação ainda vale e dispara o alarme da sala. */
  verdictLive: boolean;
}

const absent: StageRule = { place: { kind: 'absent' }, verdictLive: false };

const working = (label: () => string, extras: readonly ExtraRole[] = []): Place => ({ kind: 'character', status: 'working', label, extras });
const waiting = (label: () => string, waitingFor: () => string): Place => ({ kind: 'character', status: 'waiting', label, waitingFor, extras: [] });

export const STAGE_RULES: Record<StageKind, StageRule> = {
  queued: { place: { kind: 'queue' }, verdictLive: false },
  running: { place: working(() => tr('Construindo')), verdictLive: false },
  grilling: { place: working(() => tr('No grill'), [{ role: 'grill', label: () => tr('Fazendo o grill') }]), verdictLive: false },
  verifying: { place: working(() => tr('Em verificação'), [{ role: 'verifier', label: () => tr('Verificando') }]), verdictLive: false },
  reviewing: { place: working(() => tr('Em revisão')), verdictLive: true },
  questions: { place: waiting(() => tr('Com perguntas'), () => tr('responder as perguntas do cartão')), verdictLive: false },
  awaiting_review: { place: waiting(() => tr('Aguardando revisão'), () => tr('decidir a rodada')), verdictLive: true },
  review_incomplete: { place: waiting(() => tr('Revisão incompleta'), () => tr('decidir a rodada sem a revisão completa')), verdictLive: true },
  blocked: { place: waiting(() => tr('Bloqueado'), () => tr('destravar o cartão')), verdictLive: false },
  published: { place: { kind: 'party' }, verdictLive: false },
  review: absent,
  done: absent,
};
