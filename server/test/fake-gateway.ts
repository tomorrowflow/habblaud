// Gateway do OpenClaw de mentira, para os testes da fábrica (server/workboard/): o WebSocket feito à mão sobre o
// `upgrade` do http (RFC 6455, só texto, como em fake-world.ts), com o que o cliente do Habblaud usa do protocolo:
// `connect.challenge`, o `connect` com a assinatura Ed25519 conferida de verdade (payload v3), o pareamento (o primeiro
// `connect` de um dispositivo novo recebe PAIRING_REQUIRED até `approve`), o `hello-ok` com o token do dispositivo, as
// respostas de `workboard.boards.list` e `workboard.cards.list` e o evento `plugin.workboard.changed`.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { devicePayloadV3 } from '../workboard/device';

export interface FakeConnect {
  deviceId: string;
  auth: { token?: string; deviceToken?: string };
  /** Como terminou: hello-ok ou o código do erro. */
  result: string;
}

export interface FakeGateway {
  url: string;
  /** Segredo compartilhado aceito em `auth.token`. */
  token: string;
  boards: object[];
  cards: Record<string, object[]>;
  connects: FakeConnect[];
  /** Pedidos de pareamento pendentes (requestId -> deviceId). */
  pending: Map<string, string>;
  /** Pedidos recebidos depois do connect (método e parâmetros). */
  requests: Array<{ method: string; params: unknown }>;
  /** Aprova um pedido (ou todos). */
  approve(requestId?: string): void;
  /** Revoga os tokens emitidos (o próximo connect com token do dispositivo recebe AUTH_DEVICE_TOKEN_MISMATCH). */
  revokeTokens(): void;
  /** Avisa as conexões prontas de que o Workboard mudou. */
  changed(): void;
  /** Derruba as conexões e, com `refuse`, recusa as próximas (Gateway fora do ar). */
  down(refuse: boolean): void;
  readonly open: number;
  close(): Promise<void>;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

type Obj = Record<string, unknown>;

export async function startFakeGateway(opts: { token?: string; port?: number; autoApprove?: boolean } = {}): Promise<FakeGateway> {
  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  const sockets = new Set<{ socket: Socket; send: (msg: object) => void; ready: boolean }>();
  const approved = new Set<string>();
  const tokens = new Map<string, string>();
  let refuse = false;
  let seq = 0;

  const fake: FakeGateway = {
    url: '',
    token: opts.token ?? 'segredo-do-gateway',
    boards: [],
    cards: {},
    connects: [],
    pending: new Map(),
    requests: [],
    approve(requestId) {
      for (const [id, deviceId] of fake.pending) {
        if (requestId && id !== requestId) continue;
        approved.add(deviceId);
        fake.pending.delete(id);
      }
    },
    revokeTokens() {
      tokens.clear();
    },
    changed() {
      for (const c of sockets) if (c.ready) c.send({ type: 'event', event: 'plugin.workboard.changed', payload: { epoch: 'fake', revision: ++seq } });
    },
    down(r) {
      refuse = r;
      for (const c of sockets) c.socket.destroy();
      sockets.clear();
    },
    get open() {
      return sockets.size;
    },
    close: () =>
      new Promise((ok) => {
        fake.down(true);
        server.close(() => ok());
      }),
  };

  /** Confere o `connect` como o Gateway: id = SHA-256 da chave crua, desafio certo e assinatura do payload v3. */
  function checkDevice(p: Obj, nonce: string, ts: number): string | undefined {
    const d = p.device as Obj | undefined;
    const client = p.client as Obj | undefined;
    if (!d || !client || typeof d.publicKey !== 'string' || typeof d.signature !== 'string') return 'DEVICE_IDENTITY_REQUIRED';
    const raw = Buffer.from(d.publicKey, 'base64url');
    if (raw.length !== 32) return 'DEVICE_AUTH_PUBLIC_KEY_INVALID';
    if (d.id !== createHash('sha256').update(raw).digest('hex')) return 'DEVICE_AUTH_DEVICE_ID_MISMATCH';
    if (d.nonce !== nonce) return 'DEVICE_AUTH_NONCE_MISMATCH';
    if (d.signedAt !== ts) return 'DEVICE_AUTH_SIGNATURE_EXPIRED';
    const auth = (p.auth ?? {}) as Obj;
    const payload = devicePayloadV3({
      deviceId: d.id as string,
      clientId: String(client.id),
      clientMode: String(client.mode),
      role: String(p.role),
      scopes: (p.scopes as string[]) ?? [],
      signedAtMs: ts,
      token: (auth.deviceToken ?? auth.token) as string | undefined,
      nonce,
      platform: client.platform as string | undefined,
      deviceFamily: client.deviceFamily as string | undefined,
    });
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(d.signature, 'base64url')) ? undefined : 'DEVICE_AUTH_SIGNATURE_INVALID';
  }

  server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (refuse || typeof key !== 'string') return void socket.destroy();
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const conn = {
      socket,
      ready: false,
      send: (msg: object) => {
        if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))));
      },
    };
    sockets.add(conn);
    const nonce = randomBytes(12).toString('base64url');
    const ts = Date.now();
    conn.send({ type: 'event', event: 'connect.challenge', payload: { nonce, ts } });
    const closeConn = () => {
      socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
      socket.end();
      sockets.delete(conn);
    };
    const fail = (id: unknown, code: string, message: string, details: Obj = {}) => {
      conn.send({ type: 'res', id, ok: false, error: { code: code === 'PAIRING_REQUIRED' ? 'NOT_PAIRED' : 'INVALID_REQUEST', message, details: { code, ...details } } });
    };
    const onConnect = (id: unknown, p: Obj) => {
      const d = (p.device ?? {}) as Obj;
      const auth = (p.auth ?? {}) as { token?: string; deviceToken?: string };
      const record = (result: string) => fake.connects.push({ deviceId: String(d.id), auth: { ...auth }, result });
      const bad = p.minProtocol !== 4 || p.maxProtocol !== 4 ? 'PROTOCOL_MISMATCH' : checkDevice(p, nonce, ts);
      if (bad) {
        record(bad);
        fail(id, bad, 'device auth failed');
        return closeConn();
      }
      const deviceId = String(d.id);
      if (auth.deviceToken !== undefined ? tokens.get(deviceId) !== auth.deviceToken : auth.token !== fake.token) {
        const code = auth.deviceToken !== undefined ? 'AUTH_DEVICE_TOKEN_MISMATCH' : 'AUTH_TOKEN_MISMATCH';
        record(code);
        fail(id, code, 'unauthorized');
        return closeConn();
      }
      if (opts.autoApprove) approved.add(deviceId);
      if (!approved.has(deviceId)) {
        let requestId = [...fake.pending].find(([, dev]) => dev === deviceId)?.[0];
        if (!requestId) {
          requestId = `req-${fake.pending.size + 1}`;
          fake.pending.set(requestId, deviceId);
        }
        record('PAIRING_REQUIRED');
        fail(id, 'PAIRING_REQUIRED', 'pairing required', { requestId, deviceId });
        return closeConn();
      }
      let deviceToken = tokens.get(deviceId);
      if (!deviceToken) {
        deviceToken = randomBytes(24).toString('base64url');
        tokens.set(deviceId, deviceToken);
      }
      record('hello-ok');
      conn.ready = true;
      conn.send({
        type: 'res',
        id,
        ok: true,
        payload: {
          type: 'hello-ok',
          protocol: 4,
          server: { version: 'fake', connId: `c${sockets.size}` },
          features: { methods: ['workboard.boards.list', 'workboard.cards.list'], events: ['plugin.workboard.changed'] },
          snapshot: {},
          auth: { deviceToken, role: 'operator', scopes: ['operator.read'] },
          policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
        },
      });
    };
    const onText = (text: string) => {
      const msg = JSON.parse(text) as Obj;
      if (msg.type !== 'req') return;
      if (msg.method === 'connect') return onConnect(msg.id, (msg.params ?? {}) as Obj);
      if (!conn.ready) return fail(msg.id, 'NOT_CONNECTED', 'connect first');
      fake.requests.push({ method: String(msg.method), params: msg.params });
      if (msg.method === 'workboard.boards.list') return conn.send({ type: 'res', id: msg.id, ok: true, payload: { boards: fake.boards } });
      if (msg.method === 'workboard.cards.list') {
        const boardId = String((msg.params as Obj | undefined)?.boardId);
        return conn.send({ type: 'res', id: msg.id, ok: true, payload: { cards: fake.cards[boardId] ?? [], revision: { epoch: 'fake', revision: seq, boardId } } });
      }
      fail(msg.id, 'UNKNOWN_METHOD', 'unknown method');
    };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskOff + (i % 4)];
        buf = buf.subarray(off + len);
        if (opcode === 0x8) return closeConn();
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        else if (opcode === 0x1) onText(payload.toString('utf8'));
      }
    });
    const gone = () => void sockets.delete(conn);
    socket.on('close', gone);
    socket.on('error', gone);
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 0, '127.0.0.1', ok));
  fake.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
