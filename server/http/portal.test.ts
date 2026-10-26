// Modo portal (HABBLAUD_PORTAL=1): borda que aceita o proxy do Portal do OpenClaw e instância só leitura.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseWorldConfig, terminalOffReason, messagesOffReason, loadConfig } from '../config';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { createApiHandler, sendJson, type ApiDeps } from './app';
import { createRequestGuard } from './guard';
import { Hub } from './sse';
import { createStaticHandler } from './static';

setQuiet(true);

const PUBLIC = 'http://192.168.1.50:41234';
const ok = (_req: http.IncomingMessage, res: http.ServerResponse) => sendJson(res, 200, { reached: true });

/** Dependências "ligadas" de todos os recursos que agem: no modo portal nenhum deve ser alcançado. */
const ALL_ON = {
  terminal: true,
  terminals: { attach: ok },
  sessions: { recent: () => [] },
  permissions: ok,
  messages: ok,
  pty: ok,
  spawn: { available: () => true, mode: () => 'cli', submit: () => ({ error: 'invalid', reason: 'x' }), get: () => undefined, poll: () => [], ack: () => {} },
  dictation: { available: () => true },
  deliveries: { list: async () => [] },
  files: { pollWait: async () => [], ack: () => {} },
  world: ok,
  renameRoom: () => 'x',
  updates: { status: () => ({ state: 'ok', available: false }), check: async () => ({ state: 'ok', available: false }) },
} as unknown as Partial<ApiDeps>;

interface Env {
  port: number;
  office: Office;
  close: () => Promise<void>;
}

async function start(portal: boolean, extra: Partial<ApiDeps> = ALL_ON): Promise<Env> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const dist = join(tmp.dir, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Habblaud</title>');
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10, canAnswer: () => !portal });
  hub.start();
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false, ...extra, portal });
  const serveStatic = createStaticHandler(dist, { embeddable: portal });
  const server = http.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const guard = createRequestGuard({ portal, port });
  server.on('request', (req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) serveStatic(req, res, url.pathname);
  });
  office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  return {
    port,
    office,
    close: () =>
      new Promise((done) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          done();
        });
      }),
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function raw(port: number, path: string, method: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** Os cabeçalhos que o proxy do Portal manda ao Habblaud. */
const proxied = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  Host: `localhost:${port}`,
  'X-Forwarded-Host': '192.168.1.50:41234',
  'X-Forwarded-Proto': 'http',
  'X-Forwarded-For': '192.168.1.77',
  ...extra,
});
const JSON_BODY = { 'Content-Type': 'application/json' };

describe('modo portal: borda', () => {
  let env: Env;
  beforeEach(async () => {
    env = await start(true);
  });
  afterEach(async () => {
    await env.close();
  });

  it('serve API, estáticos e SSE com Host local e Origin igual à origem pública', async () => {
    const h = proxied(env.port, { Origin: PUBLIC, 'Sec-Fetch-Site': 'same-origin' });
    expect((await raw(env.port, '/api/snapshot', 'GET', h)).status).toBe(200);
    const page = await raw(env.port, '/', 'GET', h);
    expect(page.status).toBe(200);
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['content-security-policy']).toBeUndefined();
    const stream = await new Promise<number>((done, fail) => {
      const req = http.get({ host: '127.0.0.1', port: env.port, path: '/api/stream', headers: h }, (res) => {
        done(res.statusCode ?? 0);
        req.destroy();
      });
      req.on('error', fail);
    });
    expect(stream).toBe(200);
  });

  it('sem Origin (navegação, curl) também passa', async () => {
    expect((await raw(env.port, '/api/snapshot', 'GET', proxied(env.port))).status).toBe(200);
  });

  it('recusa Origin diferente da origem pública, no GET e no POST', async () => {
    for (const origin of ['http://evil.example', 'http://192.168.1.50:9999', 'https://192.168.1.50:41234', 'null']) {
      expect((await raw(env.port, '/api/snapshot', 'GET', proxied(env.port, { Origin: origin }))).status).toBe(403);
      expect((await raw(env.port, '/api/demo', 'POST', proxied(env.port, { Origin: origin, ...JSON_BODY }), '{}')).status).toBe(403);
    }
  });

  it('recusa Host que não é local ou sem a porta, e X-Forwarded-* incompletos', async () => {
    const base = { 'X-Forwarded-Host': '192.168.1.50:41234', 'X-Forwarded-Proto': 'http' };
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: `10.0.0.5:${env.port}`, ...base })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: 'attacker.example', ...base })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: 'localhost', ...base })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: `localhost:${env.port + 1}`, ...base })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: `localhost:${env.port}`, 'X-Forwarded-Host': '192.168.1.50:41234' })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: `localhost:${env.port}`, 'X-Forwarded-Host': 'a b', 'X-Forwarded-Proto': 'http' })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', proxied(env.port, { 'X-Forwarded-Proto': 'ftp' }))).status).toBe(403);
  });

  it('recusa chamadas de API de outro site (Sec-Fetch-Site)', async () => {
    expect((await raw(env.port, '/api/snapshot', 'GET', proxied(env.port, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403);
    expect((await raw(env.port, '/', 'GET', proxied(env.port, { 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(200);
  });

  it('POST de API continua exigindo JSON', async () => {
    const r = await raw(env.port, '/api/updates/check', 'POST', proxied(env.port, { Origin: PUBLIC, 'Content-Type': 'text/plain' }), 'x');
    expect(r.status).toBe(415);
  });

  it('pedido sem X-Forwarded-Host segue a regra de sempre (Host de fora continua recusado)', async () => {
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: 'attacker.example' })).status).toBe(403);
    expect((await raw(env.port, '/api/snapshot', 'GET', { Host: `localhost:${env.port}` })).status).toBe(200);
  });
});

describe('modo portal: só leitura', () => {
  let env: Env;
  beforeEach(async () => {
    env = await start(true);
  });
  afterEach(async () => {
    await env.close();
  });
  const call = (method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    raw(env.port, path, method, proxied(env.port, { Origin: PUBLIC, ...(body !== undefined ? JSON_BODY : {}), ...headers }), body);

  it('recusa tudo o que age, com os mesmos códigos de recurso desligado', async () => {
    const closed: [string, string, number][] = [
      ['GET', '/api/agents/.claude:1/terminal', 403],
      ['GET', '/api/sessions/recent', 403],
      ['GET', '/api/sessions/.claude/s1/terminal', 403],
      ['GET', '/api/permissions', 403],
      ['POST', '/api/permissions', 403],
      ['GET', '/api/permissions/abc/wait', 403],
      ['POST', '/api/messages', 403],
      ['GET', '/api/messages/abc', 403],
      ['POST', '/api/mod/inbox', 403],
      ['POST', '/api/mod/inbox/ack', 403],
      ['POST', '/api/codex/bridge/poll', 403],
      ['PUT', '/api/agents/.claude:1/character', 403],
      ['DELETE', '/api/agents/.claude:1/character', 403],
      ['POST', '/api/rooms/rename', 403],
      ['POST', '/api/agents/.claude:1/stop', 403],
      ['POST', '/api/agents/.claude:1/takeover', 403],
      ['GET', '/api/pty/list', 403],
      ['GET', '/api/spawn', 403],
      ['POST', '/api/spawn', 403],
      ['POST', '/api/spawn/attachments', 403],
      ['GET', '/api/dictation', 403],
      ['POST', '/api/dictation', 403],
      ['GET', '/api/deliveries', 403],
      ['GET', '/api/deliveries/file/x', 403],
      ['POST', '/api/host/files/poll', 403],
      ['POST', '/api/host/dictation/poll', 403],
      ['POST', '/api/host/spawn/poll', 403],
      ['POST', '/api/codex/events', 403],
      ['POST', '/api/demo', 403],
      ['POST', '/api/updates/check', 403],
      ['GET', '/api/world/state', 404],
      ['POST', '/api/world/login', 404],
    ];
    for (const [method, path, status] of closed) {
      const r = await call(method, path, method === 'GET' ? undefined : '{}');
      expect([method, path, r.status, r.body.includes('reached')]).toEqual([method, path, status, false]);
    }
  });

  it('o 403 do portal diz que a instância é só leitura', async () => {
    const r = await call('POST', '/api/demo', '{"enabled":true}');
    expect(JSON.parse(r.body).error).toMatch(/portal/);
    expect(env.office.isDemo()).toBe(false);
  });

  it('eventos do Codex só valem direto, sem passar pelo proxy', async () => {
    const direct = await raw(env.port, '/api/codex/events', 'POST', { Host: `localhost:${env.port}`, ...JSON_BODY }, '{}');
    expect(direct.status).not.toBe(403);
    const viaProxy = await raw(env.port, '/api/codex/events', 'POST', proxied(env.port, { Origin: PUBLIC, ...JSON_BODY }), '{}');
    expect(viaProxy.status).toBe(403);
  });

  it('as leituras seguem abertas', async () => {
    expect((await call('GET', '/api/snapshot')).status).toBe(200);
    expect((await call('GET', '/api/agents/.claude:1')).status).toBe(200);
    expect((await call('GET', '/api/stats')).status).not.toBe(403);
    expect((await call('GET', '/api/updates')).status).toBe(200);
    expect((await call('GET', '/api/mod/summary')).status).toBe(200);
  });

  it('/api/health diz portal e mostra os recursos desligados; /api/access também', async () => {
    const health = JSON.parse((await call('GET', '/api/health')).body);
    expect(health).toMatchObject({ ok: true, portal: true, terminal: false, permissions: false, pty: false, messages: false });
    const access = JSON.parse((await call('GET', '/api/access')).body);
    expect(access).toEqual({ remote: false, local: false, permissions: false, messages: false, terminal: false, spawn: false, world: false, portal: true });
  });

  it('o snapshot sai sem permissão respondível (canAnswer falso)', async () => {
    const snap = JSON.parse((await call('GET', '/api/snapshot')).body);
    expect(snap.meta.terminal).toBeFalsy();
  });
});

describe('sem o modo portal nada muda', () => {
  let env: Env;
  beforeEach(async () => {
    env = await start(false);
  });
  afterEach(async () => {
    await env.close();
  });

  it('health sem o campo portal, recursos pelo Host local e X-Frame-Options', async () => {
    const h = { Host: `localhost:${env.port}` };
    const health = JSON.parse((await raw(env.port, '/api/health', 'GET', h)).body);
    expect(health).not.toHaveProperty('portal');
    expect(health).toMatchObject({ terminal: true, permissions: true, messages: true, pty: true });
    expect((await raw(env.port, '/', 'GET', h)).headers['x-frame-options']).toBe('DENY');
    expect((await raw(env.port, '/api/messages', 'POST', { ...h, ...JSON_BODY }, '{}')).body).toContain('reached');
  });

  it('com X-Forwarded-Host o Origin do portal é recusado como antes', async () => {
    const r = await raw(env.port, '/api/demo', 'POST', proxied(env.port, { Origin: PUBLIC, ...JSON_BODY }), '{"enabled":true}');
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/Origem|Origin|origen/i);
  });
});

describe('modo portal: configuração', () => {
  const env = { HABBLAUD_PORTAL: '1' };
  it('desliga terminal, mensagens e World', () => {
    expect(terminalOffReason(env, '127.0.0.1', false)).toMatch(/portal/);
    expect(messagesOffReason(env, '127.0.0.1', false)).toMatch(/portal/);
    expect(parseWorldConfig(env, []).enabled).toBe(false);
    const cfg = loadConfig({ ...env, HABBLAUD_HOST: '127.0.0.1' }, []);
    expect(cfg).toMatchObject({ portal: true, terminal: false, messages: false });
    expect(cfg.world.enabled).toBe(false);
  });
  it('desligado por padrão', () => {
    expect(terminalOffReason({}, '127.0.0.1', false)).toBeUndefined();
    expect(parseWorldConfig({}, []).enabled).toBe(true);
    expect(loadConfig({ HABBLAUD_PORTAL: '0' }, []).portal).toBe(false);
    expect(loadConfig({}, []).portal).toBe(false);
  });
});
