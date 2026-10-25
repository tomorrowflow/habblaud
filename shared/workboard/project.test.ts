import { describe, expect, it } from 'vitest';
import { ALARM_MS, PARTY_MS } from '../github';
import type { FactoryCard, FactoryFrame, StageKind } from './model';
import { STAGE_KINDS } from './model';
import { projectFactory, type ProjectOptions } from './project';

const NOW = 1_700_000_000_000;
const opts = (extra: Partial<ProjectOptions> = {}): ProjectOptions => ({ idPrefix: 'demo:', account: 'demo:.claude', now: NOW, createdAt: NOW - 600_000, ...extra });

const card = (id: string, stage: StageKind | undefined, extra: Partial<FactoryCard> = {}): FactoryCard => ({
  id,
  boardId: 'b1',
  title: `Cartão ${id}`,
  stage,
  stageSince: NOW - 5_000,
  probe: false,
  ...extra,
});
const frame = (...cards: FactoryCard[]): FactoryFrame => ({ boards: [{ id: 'b1', name: 'Loja' }, { id: 'b2', name: 'API' }], cards });
const only = (stage: StageKind | undefined, extra: Partial<FactoryCard> = {}, o = opts()) => projectFactory(frame(card('c1', stage, extra)), o);

describe('workboard: tabela de estágios', () => {
  const WORKING: StageKind[] = ['running', 'grilling', 'verifying', 'reviewing'];
  const WAITING: StageKind[] = ['questions', 'awaiting_review', 'review_incomplete', 'blocked'];

  it.each(WORKING)('%s: o construtor trabalha', (stage) => {
    const { agents } = only(stage);
    const builder = agents.find((a) => a.factory?.role === 'builder')!;
    expect(builder.status).toBe('working');
    expect(builder.waitingFor).toBeUndefined();
    expect(builder.kind).toBe('main');
    expect(builder.provider).toBe('claude');
  });

  it.each(WAITING)('%s: o construtor espera por você, com o motivo', (stage) => {
    const { agents } = only(stage);
    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('waiting');
    expect(agents[0].waitingFor).toBeTruthy();
  });

  it('queued: sem personagem, só a contagem da fila na sala', () => {
    const p = projectFactory(frame(card('c1', 'queued'), card('c2', 'queued'), card('c3', 'queued', { boardId: 'b2' })), opts());
    expect(p.agents).toEqual([]);
    expect(p.rooms.map((r) => [r.id, r.factory])).toEqual([
      ['demo:workboard:b1', { boardId: 'b1', queued: 2 }],
      ['demo:workboard:b2', { boardId: 'b2', queued: 1 }],
    ]);
  });

  it.each(['review', 'done'] as const)('%s e cartões sem estágio não aparecem', (stage) => {
    expect(only(stage)).toEqual({ rooms: [], agents: [] });
    expect(only(undefined)).toEqual({ rooms: [], agents: [] });
  });

  it('todo estágio tem uma decisão e nenhum projeta mais de um construtor', () => {
    for (const stage of STAGE_KINDS) {
      const { agents } = only(stage);
      expect(agents.filter((a) => a.factory?.role === 'builder').length).toBeLessThanOrEqual(1);
    }
  });

  it('o balão traz o estágio e o título, nada de ferramenta', () => {
    const { agents } = only('running', { title: 'Checkout com Pix' });
    expect(agents[0].activity?.text).toBe('Construindo: Checkout com Pix');
    expect(agents[0].activity?.tool).toBeUndefined();
    expect(agents[0].title).toBe('Checkout com Pix');
  });

  it('corta títulos longos e mascara segredos', () => {
    const { agents } = only('running', { title: `Usar a chave sk-ant-api03-${'a'.repeat(40)} em ${'x'.repeat(200)}` });
    expect(agents[0].activity!.text.length).toBeLessThanOrEqual(46);
    expect(JSON.stringify(agents[0])).not.toContain('sk-ant-api03-aaaa');
  });
});

describe('workboard: probes e concluídos', () => {
  it('probes nunca projetam, em nenhum estágio', () => {
    for (const stage of STAGE_KINDS) {
      expect(projectFactory(frame(card('p', stage, { probe: true, verificationVerdict: 'fail' })), opts())).toEqual({ rooms: [], agents: [] });
    }
  });

  it('um probe ao lado de um cartão normal não muda a sala nem a fila', () => {
    const p = projectFactory(frame(card('c1', 'running'), card('p', 'queued', { probe: true })), opts());
    expect(p.agents).toHaveLength(1);
    expect(p.rooms[0].factory).toEqual({ boardId: 'b1', queued: 0 });
  });
});

describe('workboard: personagens', () => {
  it('o mesmo cartão mantém id e semente ao longo dos quadros e das rodadas de retrabalho', () => {
    const stages: StageKind[] = ['running', 'verifying', 'awaiting_review', 'running', 'verifying'];
    const builders = stages.map((s) => projectFactory(frame(card('wb-101', s)), opts()).agents.find((a) => a.factory?.role === 'builder')!);
    expect(new Set(builders.map((a) => a.id))).toEqual(new Set(['demo:workboard:wb-101']));
    expect(new Set(builders.map((a) => a.seed)).size).toBe(1);
    expect(new Set(builders.map((a) => a.name)).size).toBe(1);
  });

  it('cartões diferentes ganham ids, sementes e nomes diferentes', () => {
    const { agents } = projectFactory(frame(card('a', 'running'), card('b', 'running'), card('c', 'running')), opts());
    expect(new Set(agents.map((a) => a.id)).size).toBe(3);
    expect(new Set(agents.map((a) => a.seed)).size).toBe(3);
    expect(new Set(agents.map((a) => a.name)).size).toBe(3);
  });

  it('verificador e grill só existem nos seus estágios, ligados ao construtor', () => {
    for (const stage of STAGE_KINDS) {
      const roles = only(stage).agents.map((a) => a.factory?.role);
      expect(roles.includes('verifier')).toBe(stage === 'verifying');
      expect(roles.includes('grill')).toBe(stage === 'grilling');
    }
    const { agents } = only('verifying');
    const [builder, verifier] = [agents.find((a) => a.factory?.role === 'builder')!, agents.find((a) => a.factory?.role === 'verifier')!];
    expect(builder.status).toBe('working');
    expect(verifier).toMatchObject({ kind: 'sub', parentId: builder.id, roomId: builder.roomId, status: 'working', id: 'demo:workboard:c1:verifier' });
    expect(verifier.seed).not.toBe(builder.seed);
    expect(verifier.activity?.text).toBe('Verificando: Cartão c1');
  });

  it('o personagem fica na sala do quadro e guarda quadro, cartão e papel', () => {
    const { agents, rooms } = projectFactory(frame(card('c1', 'running', { boardId: 'b2' })), opts());
    expect(agents[0].roomId).toBe('demo:workboard:b2');
    expect(agents[0].factory).toEqual({ boardId: 'b2', cardId: 'c1', role: 'builder' });
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: 'demo:workboard:b2', name: 'API' });
  });

  it('evita os nomes que o escritório já usa', () => {
    const first = only('running').agents[0].name;
    const again = only('running', {}, opts({ avoidNames: new Set([first]) })).agents[0].name;
    expect(again).not.toBe(first);
  });

  it('salas sem fila, personagem nem efeito não existem', () => {
    expect(projectFactory(frame(), opts()).rooms).toEqual([]);
  });
});

describe('workboard: festa e alarme na sala do quadro', () => {
  it('cartão publicado há pouco: festa de PARTY_MS, sem personagem', () => {
    const url = 'https://github.com/acme/loja/pull/42';
    const p = only('published', { pullRequestUrl: url, stageSince: NOW - 3_000 });
    expect(p.agents).toEqual([]);
    expect(p.rooms[0].effect).toEqual({ kind: 'party', text: 'PR #42 aberto!', at: NOW - 3_000, until: NOW - 3_000 + PARTY_MS });
  });

  it('a festa acaba depois de PARTY_MS, mesmo com o cartão ainda publicado', () => {
    const p = only('published', { stageSince: NOW - PARTY_MS - 1 });
    expect(p.rooms).toEqual([]);
  });

  it('verificação reprovada: alarme na sala e o construtor esperando', () => {
    const p = only('awaiting_review', { verificationVerdict: 'fail', verificationAt: NOW - 2_000 });
    expect(p.rooms[0].effect).toMatchObject({ kind: 'alarm', at: NOW - 2_000, until: NOW - 2_000 + ALARM_MS, agentId: 'demo:workboard:c1' });
    expect(p.agents[0].status).toBe('waiting');
  });

  it('veredito aprovado ou com erro não faz alarme', () => {
    expect(only('awaiting_review', { verificationVerdict: 'pass' }).rooms[0].effect).toBeUndefined();
    expect(only('awaiting_review', { verificationVerdict: 'error' }).rooms[0].effect).toBeUndefined();
  });

  it('o alarme só vale enquanto o veredito vale: no retrabalho ele some', () => {
    expect(only('running', { verificationVerdict: 'fail' }).rooms[0].effect).toBeUndefined();
    expect(only('verifying', { verificationVerdict: 'fail' }).rooms[0].effect).toBeUndefined();
  });

  it('o alarme vence com o tempo', () => {
    expect(only('awaiting_review', { verificationVerdict: 'fail', verificationAt: NOW - ALARM_MS - 1 }).rooms[0].effect).toBeUndefined();
  });

  it('a festa passa na frente do alarme, e cada uma fica na sala do seu quadro', () => {
    const p = projectFactory(
      frame(
        card('a', 'awaiting_review', { verificationVerdict: 'fail', verificationAt: NOW - 1_000 }),
        card('b', 'published', { stageSince: NOW - 500 }),
        card('c', 'awaiting_review', { boardId: 'b2', verificationVerdict: 'fail', verificationAt: NOW - 1_000 }),
      ),
      opts(),
    );
    expect(p.rooms.map((r) => [r.id, r.effect?.kind])).toEqual([
      ['demo:workboard:b1', 'party'],
      ['demo:workboard:b2', 'alarm'],
    ]);
  });
});

describe('workboard: contagem da fila', () => {
  it('conta só os cartões na fila de cada quadro, ao lado dos personagens', () => {
    const p = projectFactory(frame(card('q1', 'queued'), card('q2', 'queued'), card('r', 'running'), card('d', 'done')), opts());
    expect(p.rooms).toHaveLength(1);
    expect(p.rooms[0].factory).toEqual({ boardId: 'b1', queued: 2 });
    expect(p.agents).toHaveLength(1);
  });
});
