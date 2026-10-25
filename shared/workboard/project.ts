// Projeção pura da fábrica no escritório: um instante do Workboard (FactoryFrame) vira salas e personagens, pela
// tabela de estágios. Sem estado: festa e alarme saem dos horários do próprio cartão (`since` do estágio publicado,
// `endedAt` da verificação) e do `now`.
import { maskSecrets, truncate } from '../activity';
import { bannerOf, ALARM_MS, PARTY_MS } from '../github';
import { hash32 } from '../hash';
import { tr } from '../i18n';
import { pickName } from '../names';
import type { Activity, AgentInfo, FactoryRole, RoomEffect, RoomInfo } from '../types';
import type { FactoryCard, FactoryFrame } from './model';
import { STAGE_RULES, type ExtraRole } from './stages';

export interface ProjectOptions {
  /** Prefixo dos ids de salas e agentes ("demo:" no demo, que nunca sobe para o World). */
  idPrefix: string;
  /** Conta (AccountInfo.id) a que os personagens são ligados. */
  account: string;
  now: number;
  /** `createdAt` das salas. */
  createdAt: number;
  /** Nomes já usados no escritório, para não repetir. */
  avoidNames?: ReadonlySet<string>;
}

/** A vaga (`slot`) é do escritório que recebe as salas, não da fábrica. */
export type FactoryRoom = Omit<RoomInfo, 'slot'>;

export interface FactoryProjection {
  rooms: FactoryRoom[];
  agents: AgentInfo[];
}

const ROLE_NAME: Record<FactoryRole, () => string> = {
  builder: () => tr('Construtor'),
  verifier: () => tr('Verificador'),
  grill: () => tr('Grill'),
};
const ROLE_ICON: Record<FactoryRole, string> = { builder: '🏭', verifier: '🔍', grill: '🔥' };
const MAX_ACTIVITY = 46;
const MAX_TITLE = 120;

/** Prefixo dos ids da fábrica de verdade (server/workboard/); como `demo:`, nunca sobe para o World. */
export const FACTORY_ID_PREFIX = 'factory:';
export const isFactoryId = (id: string): boolean => id.startsWith(FACTORY_ID_PREFIX);

export const factoryAgentId = (prefix: string, cardId: string, role: FactoryRole): string =>
  `${prefix}workboard:${cardId}${role === 'builder' ? '' : `:${role}`}`;

export const factoryRoomId = (prefix: string, boardId: string): string => `${prefix}workboard:${boardId}`;

type Draft = Omit<AgentInfo, 'name' | 'look'>;

function draft(card: FactoryCard, role: FactoryRole, label: string, status: 'working' | 'waiting', waitingFor: string | undefined, o: ProjectOptions): Draft {
  const since = card.stageSince ?? o.createdAt;
  const id = factoryAgentId(o.idPrefix, card.id, role);
  const builderId = factoryAgentId(o.idPrefix, card.id, 'builder');
  const title = truncate(maskSecrets(card.title), MAX_TITLE);
  const activity: Activity = {
    id: `${id}:${card.stage}`,
    kind: status === 'waiting' ? 'wait' : 'other',
    icon: status === 'waiting' ? '⏳' : ROLE_ICON[role],
    text: truncate(tr('{0}: {1}', [label, title]), MAX_ACTIVITY),
    detail: title,
    at: since,
  };
  const info: Draft = {
    id,
    kind: role === 'builder' ? 'main' : 'sub',
    provider: 'claude',
    roomId: factoryRoomId(o.idPrefix, card.boardId),
    role: ROLE_NAME[role](),
    title,
    sessionId: builderId,
    account: o.account,
    status,
    activity,
    recent: [activity],
    tasks: [],
    startedAt: since,
    lastEventAt: since,
    statusSince: since,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: hash32(`workboard:${card.id}${role === 'builder' ? '' : `:${role}`}`),
    factory: { boardId: card.boardId, cardId: card.id, role },
  };
  if (role !== 'builder') info.parentId = builderId;
  if (waitingFor) info.waitingFor = waitingFor;
  return info;
}

function draftsOf(card: FactoryCard, o: ProjectOptions): Draft[] {
  const place = card.stage ? STAGE_RULES[card.stage].place : undefined;
  if (place?.kind !== 'character') return [];
  const waitingFor = place.status === 'waiting' ? place.waitingFor() : undefined;
  const extras = place.extras.map((x: ExtraRole) => draft(card, x.role, x.label(), 'working', undefined, o));
  return [draft(card, 'builder', place.label(), place.status, waitingFor, o), ...extras];
}

const prNumber = (url: string | undefined): number | undefined => {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : undefined;
};

/** Festa (cartão publicado há pouco) ou alarme (verificação reprovada ainda em jogo); a festa passa na frente. */
function effectOf(cards: readonly FactoryCard[], o: ProjectOptions): RoomEffect | undefined {
  let party: RoomEffect | undefined;
  let alarm: RoomEffect | undefined;
  for (const c of cards) {
    if (!c.stage) continue;
    const rule = STAGE_RULES[c.stage];
    if (rule.place.kind === 'party' && c.stageSince !== undefined) {
      const fx: RoomEffect = { kind: 'party', text: bannerOf({ kind: 'pr_opened', number: prNumber(c.pullRequestUrl) })!, at: c.stageSince, until: c.stageSince + PARTY_MS };
      if (fx.until > o.now && (!party || fx.at > party.at)) party = fx;
    }
    if (rule.verdictLive && c.verificationVerdict === 'fail') {
      const at = c.verificationAt ?? c.stageSince ?? o.createdAt;
      const fx: RoomEffect = { kind: 'alarm', text: tr('Verificação falhou'), at, until: at + ALARM_MS, agentId: factoryAgentId(o.idPrefix, c.id, 'builder') };
      if (fx.until > o.now && (!alarm || fx.at > alarm.at)) alarm = fx;
    }
  }
  return party ?? alarm;
}

/** Salas e personagens do instante `frame`. Probes, cartões parados e concluídos não aparecem; a fila vira só a contagem da sala. */
export function projectFactory(frame: FactoryFrame, o: ProjectOptions): FactoryProjection {
  const cards = frame.cards.filter((c) => !c.probe);
  const drafts = cards.flatMap((c) => draftsOf(c, o)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set(o.avoidNames);
  const agents = drafts.map((info) => {
    const person = pickName(info.id, used);
    used.add(person.name);
    return { ...info, name: person.name, look: person.look };
  });
  const rooms: FactoryRoom[] = [];
  for (const board of frame.boards) {
    const mine = cards.filter((c) => c.boardId === board.id);
    const id = factoryRoomId(o.idPrefix, board.id);
    const queued = mine.filter((c) => c.stage && STAGE_RULES[c.stage].place.kind === 'queue').length;
    const effect = effectOf(mine, o);
    if (!queued && !effect && !agents.some((a) => a.roomId === id)) continue;
    const factory: NonNullable<RoomInfo['factory']> = { boardId: board.id, queued };
    // "0 de 0 autônomos" não diz nada: a placa só aparece com algum cartão aceito na semana.
    if (board.trust?.accepted) factory.trust = { ...board.trust };
    const room: FactoryRoom = { id, name: board.name, path: `workboard:${board.id}`, seed: hash32(id), createdAt: o.createdAt, factory };
    if (effect) room.effect = effect;
    rooms.push(room);
  }
  return { rooms, agents };
}
