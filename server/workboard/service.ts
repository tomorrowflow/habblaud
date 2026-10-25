// A fábrica do OpenClaw no escritório (docs/openclaw-workboard.md, "De onde vêm os dados"): cliente do WebSocket do
// Gateway (o `WebSocket` global do Node, sem dependência) como dispositivo pareado com `operator.read`. Escuta
// `plugin.workboard.changed` (só o sinal de "mudou"), relê `workboard.boards.list`, `workboard.cards.list` e
// `workboard.overview` (a autonomia da semana) e entrega ao Office a projeção pura de shared/workboard/, com ids
// `factory:` (fora de Office.list(), então fora do World).
//
// Handshake portado de docs/gateway/protocol/handshake.md e auth.md, docs/gateway/clients.md ("Choose scopes and pair
// the device", passos 1 a 5) e packages/gateway-client/src (client.ts, buildConnect e buildDeviceConnectParams;
// connect-auth.ts, selectGatewayConnectAuth) do OpenClaw: espera `connect.challenge`, assina o payload v3 com o `ts` do
// desafio como `signedAt`, manda `connect` (protocolo 4) e guarda `hello-ok.auth.deviceToken`. Com o token do
// dispositivo guardado, ele vai em `auth.deviceToken` (e é o token assinado); recusado, volta ao segredo compartilhado.
import { tr } from '../../shared/i18n';
import { FACTORY_ACCOUNT_ID } from '../../shared/workboard/account';
import { parseFrame } from '../../shared/workboard/parse';
import { FACTORY_ID_PREFIX, projectFactory, type FactoryProjection } from '../../shared/workboard/project';
import type { FactoryFrame } from '../../shared/workboard/model';
import type { AgentInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { devicePayloadV3, publicKeyBase64Url, signPayload, type DeviceStore } from './device';

export type WorkboardState = 'off' | 'connecting' | 'pairing' | 'connected' | 'error';

/** O campo `workboard` do /api/health. */
export interface WorkboardHealth {
  state: WorkboardState;
  /** Quadros no último retrato (só conectado). */
  boards?: number;
  error?: string;
}

export const WORKBOARD_CHANGED_EVENT = 'plugin.workboard.changed';
export const PROTOCOL_VERSION = 4;
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.read'];

export const WORKBOARD_TIMING = {
  /** Espera depois de um `changed` antes de reler (junta rajadas). */
  debounceMs: 500,
  /** Projeta de novo sem mudança no Gateway (festa e alarme vencem pelo relógio). */
  reprojectMs: 5_000,
  /** Fora do ar há tanto tempo: a fábrica some do escritório (nada de cartão velho posando de ao vivo). */
  staleMs: 60_000,
  /** O `connect.challenge` precisa chegar em tanto tempo depois de abrir. */
  challengeMs: 10_000,
  rpcMs: 15_000,
  backoffMinMs: 1_000,
  /** O mesmo teto dos nós do OpenClaw esperando aprovação (docs/gateway/pairing.md). */
  backoffMaxMs: 30_000,
};
export type WorkboardTiming = typeof WORKBOARD_TIMING;

export interface WorkboardServiceOptions {
  url: string;
  /** Segredo compartilhado do Gateway (HABBLAUD_WORKBOARD_TOKEN). */
  token?: string;
  store: DeviceStore;
  office: { list(): AgentInfo[]; setFactory(view: FactoryProjection | null): void };
  version: string;
  now?: () => number;
  timing?: Partial<WorkboardTiming>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly details: Obj | undefined,
  ) {
    super(message);
  }
}

/** Uma conexão: do `open` ao `close`. Uma nova a cada tentativa, para nada de uma vazar na seguinte. */
interface Link {
  ws: WebSocket;
  pending: Map<string, Pending>;
  seq: number;
  /** O `hello-ok` chegou. */
  ready: boolean;
  /** O `connect` foi com o token do dispositivo guardado. */
  usedDeviceToken: boolean;
  challengeTimer?: ReturnType<typeof setTimeout>;
}

export class WorkboardService {
  private readonly t: WorkboardTiming;
  private readonly now: () => number;
  private link: Link | undefined;
  private state: WorkboardState = 'off';
  private error: string | undefined;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reprojectTimer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private readAgain = false;
  private frame: FactoryFrame | undefined;
  /** Desde quando a conexão caiu (com um retrato na mão). */
  private downSince: number | undefined;
  private lastView = 'null';
  private pairingRequest: string | undefined;
  /** O token do dispositivo acabou de ser recusado: a próxima tentativa (com o segredo) vai sem espera. */
  private retryNow = false;
  private readonly createdAt: number;
  private stopped = true;

  constructor(private readonly o: WorkboardServiceOptions) {
    this.t = { ...WORKBOARD_TIMING, ...o.timing };
    this.now = o.now ?? Date.now;
    this.createdAt = this.now();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.state = 'connecting';
    this.reprojectTimer = setInterval(() => this.project(), this.t.reprojectMs);
    this.reprojectTimer.unref?.();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.reprojectTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    this.drop(this.link);
    this.state = 'off';
  }

  health(): WorkboardHealth {
    const h: WorkboardHealth = { state: this.state };
    if (this.state === 'connected' && this.frame) h.boards = this.frame.boards.length;
    if (this.error && (this.state === 'error' || this.state === 'pairing')) h.error = this.error;
    return h;
  }

  // ---------------------------------------------------------------- conexão

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url);
    } catch (err) {
      return this.fail(tr('endereço do Gateway recusado ({0})', [errMsg(err)]));
    }
    const link: Link = { ws, pending: new Map(), seq: 0, ready: false, usedDeviceToken: false };
    this.link = link;
    link.challengeTimer = setTimeout(() => {
      this.setError(tr('o Gateway não mandou o desafio (connect.challenge)'));
      ws.close();
    }, this.t.challengeMs);
    ws.onmessage = (ev) => {
      if (this.link !== link || typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isObj(msg)) this.onFrame(link, msg);
    };
    ws.onclose = () => this.onClose(link);
    // O `close` vem logo depois do `error`; o motivo fica para o health.
    ws.onerror = () => {
      if (this.link === link && !link.ready) this.setError(tr('sem conexão com o Gateway em {0}', [this.o.url]));
    };
  }

  private onFrame(link: Link, msg: Obj): void {
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') return this.onChallenge(link, msg.payload);
      if (msg.event === WORKBOARD_CHANGED_EVENT && link.ready) this.scheduleRefresh();
      return;
    }
    if (msg.type !== 'res' || typeof msg.id !== 'string') return;
    const p = link.pending.get(msg.id);
    if (!p) return;
    link.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) return p.resolve(msg.payload);
    const e = isObj(msg.error) ? msg.error : {};
    const details = isObj(e.details) ? e.details : undefined;
    const code = typeof details?.code === 'string' ? details.code : typeof e.code === 'string' ? e.code : undefined;
    p.reject(new GatewayError(typeof e.message === 'string' ? e.message.slice(0, 200) : tr('erro do Gateway'), code, details));
  }

  private onChallenge(link: Link, payload: unknown): void {
    clearTimeout(link.challengeTimer);
    const nonce = isObj(payload) && typeof payload.nonce === 'string' && payload.nonce ? payload.nonce : undefined;
    const ts = isObj(payload) ? payload.ts : undefined;
    // Um desafio sem `ts` inteiro e não negativo é inválido (handshake.md).
    if (!nonce || typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0) {
      this.setError(tr('desafio do Gateway fora do formato'));
      return link.ws.close();
    }
    const device = this.o.store.get();
    const deviceToken = device.deviceToken;
    link.usedDeviceToken = !!deviceToken;
    const token = deviceToken ?? this.o.token;
    const platform = process.platform;
    const signature = signPayload(
      device.privateKeyPem,
      devicePayloadV3({ deviceId: device.deviceId, clientId: CLIENT_ID, clientMode: CLIENT_MODE, role: ROLE, scopes: SCOPES, signedAtMs: ts, token, nonce, platform }),
    );
    const params = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: CLIENT_ID, displayName: 'Habblaud', version: this.o.version, platform, mode: CLIENT_MODE },
      role: ROLE,
      scopes: SCOPES,
      caps: [],
      ...(deviceToken ? { auth: { deviceToken } } : this.o.token ? { auth: { token: this.o.token } } : {}),
      device: { id: device.deviceId, publicKey: publicKeyBase64Url(device.publicKeyPem), signature, signedAt: ts, nonce },
    };
    this.request(link, 'connect', params).then(
      (hello) => this.onHello(link, hello),
      (err: unknown) => this.onConnectError(link, err),
    );
  }

  private onHello(link: Link, hello: unknown): void {
    if (this.link !== link) return;
    if (!isObj(hello) || hello.type !== 'hello-ok') {
      this.setError(tr('resposta do Gateway fora do formato'));
      return link.ws.close();
    }
    const auth = isObj(hello.auth) ? hello.auth : {};
    if (typeof auth.deviceToken === 'string' && auth.deviceToken && auth.deviceToken !== this.o.store.get().deviceToken) {
      this.o.store.setToken(auth.deviceToken);
    }
    if (this.state === 'pairing') log.info(tr('Fábrica do OpenClaw: dispositivo aprovado no Gateway.'));
    link.ready = true;
    this.state = 'connected';
    this.error = undefined;
    this.attempt = 0;
    this.downSince = undefined;
    this.pairingRequest = undefined;
    log.clearOnce('workboard-error');
    void this.refresh();
  }

  private onConnectError(link: Link, err: unknown): void {
    if (this.link !== link) return;
    const e = err instanceof GatewayError ? err : undefined;
    if (e?.code === 'PAIRING_REQUIRED') {
      const requestId = typeof e.details?.requestId === 'string' ? e.details.requestId : undefined;
      this.state = 'pairing';
      this.error = tr('aguardando aprovação no Gateway{0}', [requestId ? ` (${requestId})` : '']);
      // Um aviso por pedido (a cada nova tentativa o Gateway devolve o mesmo, até aprovar).
      if ((requestId ?? '?') !== this.pairingRequest) {
        this.pairingRequest = requestId ?? '?';
        log.warn(
          tr('Fábrica do OpenClaw: o Gateway pede para aprovar este dispositivo. No computador do Gateway, rode `openclaw devices list` e depois `openclaw devices approve {0}` (ou aprove na Control UI, em Settings → Devices).', [
            requestId ?? '<requestId>',
          ]),
        );
      }
    } else if (link.usedDeviceToken && e?.code?.startsWith('AUTH_')) {
      // Token do dispositivo revogado ou trocado: esquece e tenta de novo já, com o segredo compartilhado.
      this.o.store.setToken(undefined);
      this.retryNow = true;
    } else {
      this.setError(e ? `${e.message}${e.code ? ` (${e.code})` : ''}` : errMsg(err));
      log.warnOnce('workboard-error', tr('Fábrica do OpenClaw: o Gateway recusou a conexão: {0}', [this.error]));
    }
    link.ws.close();
  }

  private onClose(link: Link): void {
    if (this.link !== link) return;
    this.drop(link);
    if (this.stopped) return;
    if (link.ready) {
      this.downSince = this.now();
      this.state = 'connecting';
      this.error = undefined;
    }
    this.retry();
  }

  private fail(message: string): void {
    this.setError(message);
    this.retry();
  }

  /** Erro na conexão (o pareamento pendente continua sendo o estado, com o motivo novo). */
  private setError(message: string): void {
    if (this.state !== 'pairing') this.state = 'error';
    this.error = message;
  }

  private retry(): void {
    const delay = this.retryNow ? 0 : this.backoff();
    this.retryNow = false;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private backoff(): number {
    const base = Math.min(this.t.backoffMaxMs, this.t.backoffMinMs * 2 ** Math.min(this.attempt, 20));
    return Math.round(Math.min(this.t.backoffMaxMs, base * (0.75 + Math.random() * 0.5)));
  }

  /** Fecha a conexão `link` e recusa os pedidos dela. */
  private drop(link: Link | undefined): void {
    if (!link) return;
    if (this.link === link) this.link = undefined;
    clearTimeout(link.challengeTimer);
    for (const p of link.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GatewayError(tr('conexão com o Gateway fechada'), undefined, undefined));
    }
    link.pending.clear();
    if (link.ws.readyState === WebSocket.CONNECTING || link.ws.readyState === WebSocket.OPEN) link.ws.close();
  }

  private request(link: Link, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (link.ws.readyState !== WebSocket.OPEN) return reject(new GatewayError(tr('conexão com o Gateway fechada'), undefined, undefined));
      const id = String(++link.seq);
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new GatewayError(tr('o Gateway não respondeu a {0}', [method]), undefined, undefined));
      }, this.t.rpcMs);
      link.pending.set(id, { resolve, reject, timer });
      link.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  // ---------------------------------------------------------------- leitura e projeção

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, this.t.debounceMs);
  }

  /** Relê os quadros e os cartões de cada um; um `changed` no meio da leitura pede outra volta. */
  private async refresh(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        const link = this.link;
        if (!link?.ready) return;
        const boards = await this.request(link, 'workboard.boards.list', {});
        const cards: Obj = {};
        const overviews: Obj = {};
        for (const b of parseFrame({ boards }).boards) {
          cards[b.id] = await this.request(link, 'workboard.cards.list', { boardId: b.id });
          overviews[b.id] = await this.overview(link, b.id);
        }
        this.frame = parseFrame({ boards, cards, overviews });
        this.project();
      } while (this.readAgain);
    } catch (err) {
      log.warnOnce('workboard-read', tr('Fábrica do OpenClaw: não foi possível ler o Workboard ({0}).', [errMsg(err)]));
    } finally {
      this.reading = false;
    }
  }

  /** A overview só dá a placa de autonomia: sem ela (Gateway sem o método, erro), a sala fica sem a placa. */
  private async overview(link: Link, boardId: string): Promise<unknown> {
    try {
      return await this.request(link, 'workboard.overview', { boardId });
    } catch (err) {
      log.warnOnce('workboard-overview', tr('Fábrica do OpenClaw: sem a autonomia dos quadros (workboard.overview: {0}).', [errMsg(err)]));
      return undefined;
    }
  }

  private project(): void {
    const now = this.now();
    if (this.frame && this.downSince !== undefined && now - this.downSince >= this.t.staleMs) this.frame = undefined;
    const view = this.frame
      ? projectFactory(this.frame, {
          idPrefix: FACTORY_ID_PREFIX,
          account: FACTORY_ACCOUNT_ID,
          now,
          createdAt: this.createdAt,
          avoidNames: new Set(this.o.office.list().map((a) => a.name)),
        })
      : null;
    // A cada 5 s a projeção costuma sair igual: só avisa o Office quando muda.
    const key = JSON.stringify(view);
    if (key === this.lastView) return;
    this.lastView = key;
    this.o.office.setFactory(view);
  }
}
