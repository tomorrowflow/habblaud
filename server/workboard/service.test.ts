// A fábrica do OpenClaw de ponta a ponta contra o Gateway de mentira (test/fake-gateway.ts): pareamento, token do
// dispositivo em disco, releitura no `changed`, a camada no snapshot (fora de Office.list()) e o sumiço depois de 60 s
// fora do ar.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { HAS_POSIX_MODES, tempDir } from '../test/fixtures';
import { startFakeGateway, type FakeGateway } from '../test/fake-gateway';
import { DeviceStore } from './device';
import { WorkboardService } from './service';

setQuiet(true);

const FAST = { debounceMs: 20, reprojectMs: 40, staleMs: 400, backoffMinMs: 20, backoffMaxMs: 60, challengeMs: 1_000, rpcMs: 1_000 };
const NOW = Date.now();
const card = (id: string, kind: string, title: string) => ({ id, title, stage: { kind, since: NOW - 60_000 } });

async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`esperando: ${what}`);
    await new Promise((ok) => setTimeout(ok, 5));
  }
}

const closers: Array<() => unknown> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function setup(opts: { file?: string } = {}) {
  const gw = await startFakeGateway();
  closers.push(() => gw.close());
  gw.boards = [{ id: 'loja', name: 'Loja online' }];
  gw.cards = { loja: [card('wb-1', 'running', 'Checkout com Pix'), card('wb-2', 'awaiting_review', 'Rolagem do carrinho')] };
  const tmp = tempDir();
  closers.push(() => tmp.cleanup());
  const file = opts.file ?? join(tmp.dir, 'workboard.json');
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: NOW,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
  });
  const make = () => {
    const svc = new WorkboardService({ url: gw.url, token: gw.token, store: new DeviceStore(file), office, version: '9.9.9', timing: FAST });
    closers.push(() => svc.stop());
    return svc;
  };
  return { gw, office, file, make, snap: () => office.commit().snapshot };
}

const factoryIds = (s: { agents: { id: string }[]; rooms: { id: string }[] }) => [...s.rooms, ...s.agents].map((x) => x.id).filter((id) => id.startsWith('factory:'));

describe('WorkboardService', () => {
  it('pareamento: espera a aprovação no Gateway, depois a fábrica entra no snapshot (e só nele)', async () => {
    const { gw, office, file, make, snap } = await setup();
    const svc = make();
    svc.start();
    await waitFor(() => svc.health().state === 'pairing', 'pedido de pareamento');
    expect(svc.health().error).toContain('req-1');
    expect(gw.connects[0]).toMatchObject({ result: 'PAIRING_REQUIRED', auth: { token: gw.token } });
    expect(factoryIds(snap())).toEqual([]);

    gw.approve('req-1');
    await waitFor(() => svc.health().state === 'connected' && factoryIds(snap()).length > 0, 'conectado e projetado');
    expect(svc.health()).toEqual({ state: 'connected', boards: 1 });
    const s = snap();
    const room = s.rooms.find((r) => r.id === 'factory:workboard:loja')!;
    expect(room).toMatchObject({ name: 'Loja online', factory: { boardId: 'loja', queued: 0 } });
    expect(typeof room.slot).toBe('number');
    const builder = s.agents.find((a) => a.id === 'factory:workboard:wb-1')!;
    expect(builder).toMatchObject({ roomId: room.id, status: 'working', factory: { cardId: 'wb-1', role: 'builder' } });
    expect(s.agents.find((a) => a.id === 'factory:workboard:wb-2')).toMatchObject({ status: 'waiting' });
    // Camada à parte: a gaveta abre, mas nada que percorre os agentes reais (World, mensagens, editor) os vê.
    expect(office.detail(builder.id)?.agent.name).toBe(builder.name);
    expect(office.has(builder.id)).toBe(false);
    expect(office.list()).toEqual([]);
    expect(office.inFactory(builder.id)).toBe(true);

    // O token do dispositivo ficou guardado, com modo 600, e nunca o segredo compartilhado.
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.deviceToken).toEqual(expect.any(String));
    expect(saved.deviceId).toBe(gw.connects[0].deviceId);
    expect(readFileSync(file, 'utf8')).not.toContain(gw.token);
    if (HAS_POSIX_MODES) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('plugin.workboard.changed: relê os quadros e os cartões', async () => {
    const { gw, make, snap } = await setup();
    const svc = make();
    svc.start();
    await waitFor(() => gw.pending.size === 1, 'pedido');
    gw.approve();
    await waitFor(() => snap().agents.some((a) => a.id === 'factory:workboard:wb-1'), 'primeira leitura');
    const reads = gw.requests.length;

    gw.boards.push({ id: 'pagamentos', name: 'API de pagamentos' });
    gw.cards.pagamentos = [card('wb-9', 'verifying', 'Idempotência')];
    gw.cards.loja = [card('wb-2', 'awaiting_review', 'Rolagem do carrinho')];
    gw.changed();
    await waitFor(() => snap().agents.some((a) => a.id === 'factory:workboard:wb-9'), 'releitura');
    const s = snap();
    expect(s.agents.some((a) => a.id === 'factory:workboard:wb-1')).toBe(false);
    expect(s.rooms.find((r) => r.id === 'factory:workboard:pagamentos')?.name).toBe('API de pagamentos');
    expect(svc.health().boards).toBe(2);
    expect(gw.requests.slice(reads).map((r) => r.method)).toEqual([
      'workboard.boards.list',
      'workboard.cards.list',
      'workboard.overview',
      'workboard.cards.list',
      'workboard.overview',
    ]);
    expect(gw.requests.slice(reads).map((r) => r.params)).toEqual([{}, { boardId: 'loja' }, { boardId: 'loja' }, { boardId: 'pagamentos' }, { boardId: 'pagamentos' }]);
  });

  it('a autonomia da semana (workboard.overview) chega à sala; sem a overview, a sala fica sem a placa', async () => {
    const { gw, make, snap } = await setup();
    gw.boards.push({ id: 'pagamentos', name: 'API de pagamentos' });
    gw.cards.pagamentos = [card('wb-9', 'verifying', 'Idempotência')];
    // `loja` sem overview: o Gateway responde "método desconhecido", como um Workboard sem a Factory overview.
    gw.overviews.pagamentos = { boardId: 'pagamentos', generatedAt: NOW, needsYou: [], inFlight: [], shipped: [], insights: [], open: {}, week: { weekStart: NOW, accepted: 5, autonomous: 3 } };
    const svc = make();
    svc.start();
    await waitFor(() => gw.pending.size === 1, 'pedido');
    gw.approve();
    await waitFor(() => snap().rooms.some((r) => r.id === 'factory:workboard:pagamentos'), 'projetado');
    const rooms = Object.fromEntries(snap().rooms.map((r) => [r.id, r.factory]));
    expect(rooms['factory:workboard:pagamentos']).toEqual({ boardId: 'pagamentos', queued: 0, trust: { autonomous: 3, accepted: 5 } });
    expect(rooms['factory:workboard:loja']).toEqual({ boardId: 'loja', queued: 0 });

    gw.overviews.pagamentos = { ...gw.overviews.pagamentos, week: { weekStart: NOW, accepted: 6, autonomous: 4 } };
    gw.changed();
    await waitFor(() => snap().rooms.find((r) => r.id === 'factory:workboard:pagamentos')?.factory?.trust?.accepted === 6, 'autonomia relida');
  });

  it('reconexão: usa o token do dispositivo guardado (sem pedir pareamento); revogado, volta ao segredo compartilhado', async () => {
    const { gw, make, file } = await setup();
    const first = make();
    first.start();
    await waitFor(() => gw.pending.size === 1, 'pedido');
    gw.approve();
    await waitFor(() => first.health().state === 'connected', 'pareado');
    const token = (JSON.parse(readFileSync(file, 'utf8')) as { deviceToken: string }).deviceToken;
    first.stop();

    const second = make();
    second.start();
    await waitFor(() => second.health().state === 'connected', 'reconectado');
    expect(gw.connects.at(-1)).toEqual({ deviceId: gw.connects[0].deviceId, auth: { deviceToken: token }, result: 'hello-ok' });
    expect(gw.connects.some((c) => c.result.startsWith('DEVICE_AUTH'))).toBe(false);

    gw.revokeTokens();
    gw.down(false);
    await waitFor(() => gw.connects.at(-1)?.result === 'hello-ok' && gw.connects.at(-1)?.auth.token === gw.token, 'de volta com o segredo');
    expect(gw.connects.at(-2)).toMatchObject({ auth: { deviceToken: token }, result: 'AUTH_DEVICE_TOKEN_MISMATCH' });
    await waitFor(() => second.health().state === 'connected', 'conectado de novo');
    const fresh = (JSON.parse(readFileSync(file, 'utf8')) as { deviceToken: string }).deviceToken;
    expect(fresh).not.toBe(token);
  });

  it('fora do ar: os cartões ficam até 60 s (aqui, staleMs) e depois a fábrica some do escritório', async () => {
    const { gw, make, snap } = await setup();
    const svc = make();
    svc.start();
    await waitFor(() => gw.pending.size === 1, 'pedido');
    gw.approve();
    await waitFor(() => factoryIds(snap()).length > 0, 'projetado');

    const downAt = Date.now();
    gw.down(true);
    await waitFor(() => svc.health().state !== 'connected', 'queda percebida');
    expect(factoryIds(snap()).length).toBeGreaterThan(0);
    await waitFor(() => factoryIds(snap()).length === 0, 'fábrica retirada', 2_000);
    expect(Date.now() - downAt).toBeGreaterThanOrEqual(FAST.staleMs - 20);
    expect(svc.health().state).toMatch(/connecting|error/);
  });
});
