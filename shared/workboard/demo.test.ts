// A fábrica no modo demonstração: o roteiro, a fábrica sozinha e junta ao simulador (sem chegar ao Habblaud World).
import { describe, expect, it } from 'vitest';
import { DemoSimulator } from '../demo/simulator';
import { hash32 } from '../hash';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../types';
import { project, type WorldIdSource } from '../world/projection';
import { DEMO_FRAME_MS, FactoryDemo } from './demo';
import { DEMO_FRAME_COUNT, demoFrame } from './demo-script';
import { parseFrame } from './parse';

const T0 = 1_700_000_000_000;

function walk(factory: FactoryDemo, frames: number) {
  const seen = { agents: new Map<string, AgentInfo>(), effects: [] as { kind: string; text: string; frame: number }[], queued: 0, statuses: new Set<string>(), roles: new Set<string>() };
  for (let t = 0; t < frames * DEMO_FRAME_MS; t += 250) {
    const { view } = factory.tick(T0 + t, new Set());
    for (const a of view.agents) {
      seen.agents.set(a.id, a);
      seen.statuses.add(a.status);
      seen.roles.add(a.factory!.role);
    }
    for (const r of view.rooms) {
      seen.queued = Math.max(seen.queued, r.factory!.queued);
      if (r.effect && !seen.effects.some((e) => e.kind === r.effect!.kind && e.text === r.effect!.text && e.frame === Math.floor(t / DEMO_FRAME_MS))) {
        seen.effects.push({ kind: r.effect.kind, text: r.effect.text, frame: Math.floor(t / DEMO_FRAME_MS) });
      }
    }
  }
  return seen;
}

describe('workboard: roteiro do demo', () => {
  it('é lido sem perdas e traz dois quadros e um probe e um cartão parado que nunca projetam', () => {
    const f = parseFrame(demoFrame(0, T0, DEMO_FRAME_MS));
    expect(f.boards.map((b) => b.id)).toEqual(['loja', 'pagamentos']);
    expect(f.cards).toHaveLength(6);
    expect(f.cards.filter((c) => c.probe)).toHaveLength(1);
    expect(f.cards.some((c) => c.stage === undefined)).toBe(true);
  });

  it('o since de um estágio vai até o quadro em que o cartão entrou nele', () => {
    const at = (i: number) => parseFrame(demoFrame(i, T0 + i * DEMO_FRAME_MS, DEMO_FRAME_MS)).cards.find((c) => c.id === 'wb-101')!;
    expect(at(2).stageSince).toBe(T0 + 2 * DEMO_FRAME_MS);
    expect(at(3).stageSince).toBe(T0 + 2 * DEMO_FRAME_MS);
    expect(at(5)).toMatchObject({ stage: 'awaiting_review', verificationVerdict: 'fail' });
  });

  it('percorre fila, construção, verificação com reprovação e retrabalho, revisão, publicação, grill e perguntas', () => {
    const seen = walk(new FactoryDemo({ idPrefix: 'demo:', account: 'demo:.claude' }, T0), DEMO_FRAME_COUNT);
    expect(seen.queued).toBeGreaterThan(0);
    expect([...seen.statuses].sort()).toEqual(['waiting', 'working']);
    expect([...seen.roles].sort()).toEqual(['builder', 'grill', 'verifier']);
    const kinds = seen.effects.map((e) => e.kind);
    expect(kinds).toContain('alarm');
    expect(kinds).toContain('party');
    expect(seen.effects.filter((e) => e.kind === 'party').map((e) => e.text)).toEqual(['PR #57 aberto!', 'PR #42 aberto!']);
    expect([...seen.agents.keys()]).not.toContain('demo:workboard:wb-203');
    expect([...seen.agents.keys()]).not.toContain('demo:workboard:wb-204');
  });

  it('a reprovação vem antes do retrabalho do mesmo cartão, que mantém o personagem', () => {
    const f = new FactoryDemo({ idPrefix: 'demo:', account: 'a' }, T0);
    const builder = (frame: number) => f.tick(T0 + frame * DEMO_FRAME_MS, new Set()).view.agents.find((a) => a.id === 'demo:workboard:wb-101')!;
    const failed = builder(5);
    const rework = builder(6);
    expect(failed.status).toBe('waiting');
    expect(rework.status).toBe('working');
    expect(rework.seed).toBe(failed.seed);
    expect(rework.name).toBe(failed.name);
  });

  it('volta ao começo depois do último quadro', () => {
    const f = new FactoryDemo({ idPrefix: 'demo:', account: 'a' }, T0);
    const first = f.tick(T0, new Set()).view;
    const wrapped = f.tick(T0 + DEMO_FRAME_COUNT * DEMO_FRAME_MS, new Set()).view;
    expect(wrapped.rooms.map((r) => r.factory)).toEqual(first.rooms.map((r) => r.factory));
  });

  it('só avisa mudança quando o quadro ou um efeito muda', () => {
    const f = new FactoryDemo({ idPrefix: 'demo:', account: 'a' }, T0);
    expect(f.tick(T0, new Set()).changed).toBe(true);
    expect(f.tick(T0 + 250, new Set()).changed).toBe(false);
    expect(f.tick(T0 + 2 * DEMO_FRAME_MS, new Set()).changed).toBe(true);
  });
});

const isFactoryRoom = (r: RoomInfo) => r.factory !== undefined;
const isFactoryAgent = (a: AgentInfo) => a.factory !== undefined;

describe('workboard: dentro do simulador', () => {
  function run(opts: { factory?: boolean }, until = 5 * 60_000) {
    const sim = new DemoSimulator({ seed: 7, sessions: 3, idPrefix: 'demo:', ...opts }, T0);
    const snaps: OfficeSnapshot[] = [];
    for (let t = 0; t <= until; t += 250) {
      if (sim.tick(T0 + t).changed || t === 0) snaps.push(sim.snapshot(T0 + t));
    }
    return snaps;
  }

  it('o snapshot do demo traz salas e agentes da fábrica com prefixo demo:, ao lado do escritório simulado', () => {
    const snaps = run({ factory: true });
    const last = snaps[snaps.length - 1];
    const rooms = snaps.flatMap((s) => s.rooms.filter(isFactoryRoom));
    const agents = snaps.flatMap((s) => s.agents.filter(isFactoryAgent));
    expect(rooms.length).toBeGreaterThan(0);
    expect(agents.length).toBeGreaterThan(0);
    for (const r of rooms) expect(r.id).toMatch(/^demo:workboard:/);
    for (const a of agents) expect(a.id).toMatch(/^demo:workboard:/);
    expect(last.agents.some((a) => !isFactoryAgent(a))).toBe(true);
    expect(last.rooms.some((r) => !isFactoryRoom(r))).toBe(true);
    expect(rooms.some((r) => r.effect?.kind === 'alarm')).toBe(true);
    expect(rooms.some((r) => r.effect?.kind === 'party')).toBe(true);
  });

  it('as vagas, os ids e os nomes não colidem com o escritório simulado', () => {
    for (const s of run({ factory: true })) {
      expect(new Set(s.rooms.map((r) => r.slot)).size).toBe(s.rooms.length);
      expect(new Set(s.agents.map((a) => a.id)).size).toBe(s.agents.length);
      expect(new Set(s.agents.map((a) => a.name)).size).toBe(s.agents.length);
    }
  });

  it('sem a opção, nada da fábrica entra e o escritório simulado é o mesmo', () => {
    const without = run({}, 60_000);
    const withFactory = run({ factory: true }, 60_000);
    expect(without.flatMap((s) => [...s.rooms.filter(isFactoryRoom), ...s.agents.filter(isFactoryAgent)])).toEqual([]);
    const simulated = (s: OfficeSnapshot) => ({ rooms: s.rooms.filter((r) => !isFactoryRoom(r)).map((r) => r.id), agents: s.agents.filter((a) => !isFactoryAgent(a)).map((a) => a.id) });
    expect(simulated(withFactory[withFactory.length - 1]).rooms).toEqual(simulated(without[without.length - 1]).rooms);
  });

  it('o Habblaud World nunca recebe a fábrica', () => {
    const ids: WorldIdSource & { asked: string[] } = {
      asked: [],
      floorId(roomId) {
        this.asked.push(roomId);
        return `f_${hash32(roomId).toString(16).padStart(10, '0')}`;
      },
      agentId(agentId) {
        this.asked.push(agentId);
        return `a_${hash32(agentId).toString(16).padStart(8, '0')}`;
      },
    };
    const snaps = run({ factory: true });
    for (const s of snaps) {
      const uplink = project({ rooms: s.rooms, agents: s.agents, theme: 'none', version: '1.0.3', options: { compactions: false, tokensVisible: true } }, ids, T0);
      expect(uplink.floors).toEqual([]);
    }
    expect(ids.asked.some((id) => id.includes('workboard'))).toBe(false);
  });
});
