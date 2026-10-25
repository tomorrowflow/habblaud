import { describe, expect, it } from 'vitest';
import { parseFrame } from './parse';

const board = (id: string, extra: object = {}) => ({ id, name: `Quadro ${id}`, total: 1, active: 1, archived: 0, byStatus: {}, ...extra });
const card = (id: string, extra: object = {}) => ({ id, title: `Cartão ${id}`, status: 'running', priority: 'normal', labels: [], position: 0, createdAt: 1, updatedAt: 2, ...extra });

describe('workboard: leitura das respostas do Gateway', () => {
  it('lê quadros e cartões, ignorando campos desconhecidos', () => {
    const f = parseFrame({
      boards: [board('b1', { novidade: 1 })],
      cards: { b1: { cards: [card('c1', { stage: { kind: 'running', since: 5, nodeId: 'n' }, extra: {} })], statuses: [] } },
    });
    expect(f.boards).toEqual([{ id: 'b1', name: 'Quadro b1' }]);
    expect(f.cards).toEqual([{ id: 'c1', boardId: 'b1', title: 'Cartão c1', stage: 'running', stageSince: 5, probe: false }]);
  });

  it('aceita as listas soltas ou dentro de { boards } / { cards }', () => {
    const a = parseFrame({ boards: [board('b1')], cards: { b1: [card('c1')] } });
    const b = parseFrame({ boards: { boards: [board('b1')] }, cards: { b1: { cards: [card('c1')] } } });
    expect(a.cards.map((c) => c.id)).toEqual(['c1']);
    expect(b).toEqual(a);
  });

  it('nunca lança e devolve um quadro vazio para lixo', () => {
    for (const raw of [undefined, null, 7, 'x', [], {}, { boards: 3, cards: 4 }, { boards: [null, 1, 'x', []], cards: [] }]) {
      expect(parseFrame(raw)).toEqual({ boards: [], cards: [] });
    }
  });

  it('descarta entradas malformadas e mantém as boas ao lado', () => {
    const f = parseFrame({
      boards: [board('b1'), { name: 'sem id' }, board(''), board('b1'), board('arq', { archivedAt: 9 }), board('sess', { kind: 'sessions' })],
      cards: {
        b1: [card('ok'), card('', {}), { id: 'sem-titulo' }, card('t', { title: '  ' }), null, 'x', card('ok'), card('arquivado', { metadata: { archivedAt: 3 } })],
        desconhecido: [card('orfao')],
        arq: [card('do-arquivado')],
      },
    });
    expect(f.boards.map((b) => b.id)).toEqual(['b1']);
    expect(f.cards.map((c) => c.id)).toEqual(['ok']);
  });

  it('o quadro sem nome usa o id', () => {
    expect(parseFrame({ boards: [{ id: 'b1' }], cards: {} }).boards).toEqual([{ id: 'b1', name: 'b1' }]);
  });

  it('estágio ausente ou desconhecido vira undefined; campos de tipo errado caem', () => {
    const f = parseFrame({
      boards: [board('b1')],
      cards: {
        b1: [
          card('parado', { status: 'backlog' }),
          card('novo', { stage: { kind: 'estagio-do-futuro', since: 1 } }),
          card('ruim', { stage: { kind: 'running', since: 'ontem' }, grill: 'x', pullRequestUrl: 5 }),
        ],
      },
    });
    expect(f.cards.map((c) => c.stage)).toEqual([undefined, undefined, 'running']);
    expect(f.cards[2].stageSince).toBeUndefined();
    expect(f.cards[2].pullRequestUrl).toBeUndefined();
  });

  it('reconhece probes pela marca do Gateway ou pelo título', () => {
    const f = parseFrame({
      boards: [board('b1')],
      cards: {
        b1: [
          card('por-metadado', { metadata: { automation: { probe: { of: 'x', arm: 'a', createdAt: 1 } } } }),
          card('por-titulo', { title: '[PROBE:sem-skill] Algo' }),
          card('normal', { title: 'Falar do [PROBE:x] no meio' }),
        ],
      },
    });
    expect(f.cards.map((c) => c.probe)).toEqual([true, true, false]);
  });

  it('lê o PR e o grill aberto', () => {
    const f = parseFrame({
      boards: [board('b1')],
      cards: {
        b1: [
          card('pub', { stage: { kind: 'published', since: 1, pullRequestUrl: 'https://github.com/a/b/pull/3', reworkRound: 0 } }),
          card('grill', { stage: { kind: 'grilling', since: 1, round: 1 }, grill: { status: 'open', rounds: 1, attachmentId: 'a' } }),
        ],
      },
    });
    expect(f.cards[0].pullRequestUrl).toBe('https://github.com/a/b/pull/3');
  });

  describe('veredito da verificação', () => {
    const withVerification = (v: object, rounds?: object[]) =>
      card('v', { rounds, metadata: { automation: { target: { worktree: { verification: v } } } } });
    const parse = (c: object) => parseFrame({ boards: [board('b1')], cards: { b1: [c] } }).cards[0];

    it('lê o veredito e a hora do fim', () => {
      const c = parse(withVerification({ phase: 'done', round: 1, endedAt: 77, verdict: 'fail' }, [{ round: 1 }]));
      expect(c.verificationVerdict).toBe('fail');
      expect(c.verificationAt).toBe(77);
    });

    it('ignora verificação em andamento, veredito inválido e registro de outra rodada', () => {
      expect(parse(withVerification({ phase: 'running', round: 1 })).verificationVerdict).toBeUndefined();
      expect(parse(withVerification({ phase: 'done', round: 1, verdict: 'talvez' })).verificationVerdict).toBeUndefined();
      expect(parse(withVerification({ phase: 'done', round: 1, verdict: 'fail' }, [{ round: 1 }, { round: 2 }])).verificationVerdict).toBeUndefined();
    });
  });
});

/** Uma resposta de `workboard.overview` no formato de WorkboardOverviewResult (@openclaw/workboard-contract). */
const overview = (week: object) => ({
  boardId: 'b1',
  generatedAt: 1_700_000_000_000,
  needsYou: [{ cardId: 'c9', boardId: 'b1', title: 'Pedido', reason: 'questions', since: 1 }],
  inFlight: [],
  shipped: [],
  insights: [],
  open: { running: 1, todo: 2 },
  week,
});

describe('workboard: autonomia da semana (workboard.overview)', () => {
  it('lê a autonomia de `week`, ignorando o resto da overview', () => {
    const f = parseFrame({
      boards: [board('b1'), board('b2')],
      cards: {},
      overviews: { b1: overview({ weekStart: 1, accepted: 5, autonomous: 3, medianLeadTimeMs: 9 }), b2: overview({ weekStart: 1, accepted: 0, autonomous: 0 }) },
    });
    expect(f.boards).toEqual([
      { id: 'b1', name: 'Quadro b1', trust: { autonomous: 3, accepted: 5 } },
      { id: 'b2', name: 'Quadro b2', trust: { autonomous: 0, accepted: 0 } },
    ]);
  });

  it('sem overview ou com overview malformada, o quadro fica sem autonomia', () => {
    const bad = [undefined, null, 'x', [], {}, { week: null }, { week: { accepted: 5 } }, { week: { accepted: '5', autonomous: 3 } }, { week: { accepted: 2, autonomous: 3 } }, { week: { accepted: -1, autonomous: 0 } }, { week: { accepted: 2.5, autonomous: 1 } }, { week: { accepted: Infinity, autonomous: 1 } }];
    for (const o of bad) {
      const f = parseFrame({ boards: [board('b1')], cards: {}, overviews: { b1: o } });
      expect(f.boards).toEqual([{ id: 'b1', name: 'Quadro b1' }]);
    }
    expect(parseFrame({ boards: [board('b1')], cards: {}, overviews: 'lixo' }).boards).toEqual([{ id: 'b1', name: 'Quadro b1' }]);
    expect(parseFrame({ boards: [board('b1')], cards: {} }).boards).toEqual([{ id: 'b1', name: 'Quadro b1' }]);
  });

  it('a overview de um quadro que não está na lista não cria quadro', () => {
    const f = parseFrame({ boards: [board('b1')], cards: {}, overviews: { outro: overview({ accepted: 1, autonomous: 1 }), toString: overview({ accepted: 1, autonomous: 1 }) } });
    expect(f.boards).toEqual([{ id: 'b1', name: 'Quadro b1' }]);
  });
});
