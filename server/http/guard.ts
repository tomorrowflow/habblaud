// Proteções de borda do servidor HTTP (valem para a API, os estáticos e o Vite no modo dev).
//
// 1) DNS rebinding: um site malicioso pode fazer o próprio domínio resolver para 127.0.0.1 e,
//    assim, ler /api/snapshot "como se fosse a mesma origem". O navegador manda o cabeçalho Host
//    com o domínio do atacante, então só aceitamos Host que seja um IP literal, `localhost`
//    (ou `*.localhost`) ou um nome liberado em HABBLAUD_ALLOWED_HOSTS.
// 2) CSRF: requisições que mudam estado (POST) exigem `Content-Type: application/json` — o que um
//    formulário ou um fetch "simples" de outro site não consegue enviar sem preflight de CORS, que
//    este servidor nunca autoriza — e, quando há `Origin`, ele precisa ser da mesma origem ou local.
// 3) Modo portal (HABBLAUD_PORTAL=1): atrás do proxy do Portal do OpenClaw o `Host` chega reescrito para
//    `localhost:<porta>` e o endereço público vem em `X-Forwarded-Host`/`X-Forwarded-Proto` (o proxy apaga os
//    `X-Forwarded-*` que o cliente mandou). Aí o `Origin` do navegador é o do portal, não o do Host.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { tr } from '../../shared/i18n';

/** Nomes liberados por HABBLAUD_ALLOWED_HOSTS (lista separada por vírgula; porta é ignorada). */
export function parseAllowedHosts(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (raw ?? '').split(',')) {
    const name = hostnameOf(item.trim());
    if (name) out.add(name);
  }
  return out;
}

/**
 * Nome do host (minúsculo, sem porta e sem colchetes no IPv6) a partir de um cabeçalho Host
 * ou de um `host[:porta]`. Devolve undefined se o valor for inválido.
 */
export function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return undefined;
    const rest = v.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return undefined;
    return v.slice(1, end);
  }
  const m = /^([a-z0-9._-]+)(?::\d{1,5})?$/.exec(v);
  return m ? m[1].replace(/\.$/, '') : undefined;
}

function isLoopbackName(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '::1') return true;
  return isIP(name) === 4 && name.startsWith('127.');
}

/**
 * Cabeçalho Host local (`localhost`, `*.localhost`, 127.x ou `[::1]`; porta ignorada)? Usado pelo terminal, pelas
 * permissões e pelas mensagens, que só atendem quem abriu o Habblaud pelo próprio computador: um IP da rede ou um nome
 * de HABBLAUD_ALLOWED_HOSTS (proxy, túnel) não serve. Ausente ou inválido: false.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = hostnameOf(host);
  return !!name && isLoopbackName(name);
}

/**
 * Host aceito? IP literal (não há DNS envolvido, logo não há rebinding), `localhost`/`*.localhost`
 * (os navegadores resolvem sempre para o loopback) ou um nome de HABBLAUD_ALLOWED_HOSTS.
 * Sem cabeçalho Host (HTTP/1.0, ferramentas de linha de comando): aceito — navegadores sempre enviam.
 */
export function hostAllowed(host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (host === undefined) return true;
  const name = hostnameOf(host);
  if (!name) return false;
  return isIP(name) !== 0 || isLoopbackName(name) || allowed.has(name);
}

/**
 * Origin aceito para requisições que mudam estado: ausente (curl, scripts), da mesma origem que o
 * Host da requisição, local (localhost/loopback) ou um nome de HABBLAUD_ALLOWED_HOSTS.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (host !== undefined && url.host.toLowerCase() === host.trim().toLowerCase()) return true;
  const name = hostnameOf(url.host);
  return !!name && (isLoopbackName(name) || allowed.has(name));
}

/**
 * Pedido que passou pelo proxy do Portal do OpenClaw: tem `X-Forwarded-Host`. O proxy sempre o define (e apaga o que o
 * cliente mandou); um cliente local que fala direto com o Habblaud (hooks do Codex, curl) não o manda.
 */
export function isForwarded(req: IncomingMessage): boolean {
  return req.headers['x-forwarded-host'] !== undefined;
}

/**
 * Origem pública do portal (`<proto>://<host[:porta]>`, minúscula) a partir de `X-Forwarded-Proto` e `X-Forwarded-Host`,
 * ou undefined se faltar, vier repetido ou for inválido.
 */
export function forwardedOrigin(headers: IncomingMessage['headers']): string | undefined {
  const proto = headers['x-forwarded-proto'];
  const host = headers['x-forwarded-host'];
  if (typeof proto !== 'string' || typeof host !== 'string') return undefined;
  const p = proto.trim().toLowerCase();
  if ((p !== 'http' && p !== 'https') || !hostnameOf(host)) return undefined;
  return `${p}://${host.trim().toLowerCase()}`;
}

/** `Host` local com porta (`localhost:<porta>`, 127.x ou `[::1]`), como o proxy do portal o reescreve; `port` confere a porta. */
function isPortalUpstreamHost(host: string | undefined, port: number | undefined): boolean {
  if (!host || !isLoopbackHost(host)) return false;
  const m = /:(\d{1,5})$/.exec(host.trim());
  return !!m && (port === undefined || Number(m[1]) === port);
}

export function isJsonContentType(value: string | undefined): boolean {
  return !!value && /^application\/json\s*(;|$)/i.test(value.trim());
}

function reject(res: ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export interface GuardOptions {
  /** Nomes extras aceitos no Host/Origin (HABBLAUD_ALLOWED_HOSTS). */
  allowedHosts?: ReadonlySet<string>;
  /** Modo portal (HABBLAUD_PORTAL=1): aceita pedidos do proxy do Portal do OpenClaw (ver o item 3 acima). */
  portal?: boolean;
  /** Porta em que o servidor escuta; no modo portal, o `Host` reescrito pelo proxy precisa trazê-la. */
  port?: number;
}

/**
 * Devolve um filtro para o início de cada requisição: responde (e devolve true) quando a
 * requisição deve ser recusada; senão devolve false e não toca na resposta.
 */
export function createRequestGuard(opts: GuardOptions = {}): (req: IncomingMessage, res: ServerResponse) => boolean {
  const allowed = opts.allowedHosts ?? new Set<string>();
  return (req, res) => {
    const host = req.headers.host;
    if (opts.portal && isForwarded(req)) return guardPortal(req, res, opts.port);
    if (!hostAllowed(host, allowed)) {
      reject(
        res,
        403,
        tr('Host não permitido: {0}. Abra o Habblaud por http://localhost (ou pelo IP) ', [String(host).slice(0, 100)]) +
          tr('ou libere o nome em HABBLAUD_ALLOWED_HOSTS.'),
      );
      return true;
    }
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!originAllowed(origin, host, allowed)) {
      reject(res, 403, tr('Origem não permitida.'));
      return true;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/api/') && !isJsonContentType(req.headers['content-type'])) {
      reject(res, 415, tr('Envie o corpo como JSON (Content-Type: application/json).'));
      return true;
    }
    return false;
  };
}

/**
 * Pedido do proxy do Portal: o `Host` tem de ser o local reescrito por ele, e o `Origin` (se houver, em qualquer método)
 * tem de ser exatamente a origem pública que ele declara. Um site que aponte o próprio domínio para a máquina não passa
 * pelo proxy, e uma página não consegue mandar `X-Forwarded-Host` sem um preflight de CORS, que este servidor nunca
 * autoriza. Na API, `Sec-Fetch-Site` de outro site é recusado (as chamadas da página são da mesma origem).
 */
function guardPortal(req: IncomingMessage, res: ServerResponse, port: number | undefined): boolean {
  const method = req.method ?? 'GET';
  const publicOrigin = forwardedOrigin(req.headers);
  if (!isPortalUpstreamHost(req.headers.host, port) || !publicOrigin) {
    reject(res, 403, tr('Pedido do portal inválido: o proxy precisa mandar Host local, X-Forwarded-Host e X-Forwarded-Proto.'));
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || origin.trim().toLowerCase() !== publicOrigin)) {
    reject(res, 403, tr('Origem não permitida.'));
    return true;
  }
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/api/')) {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      reject(res, 403, tr('Origem não permitida.'));
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !isJsonContentType(req.headers['content-type'])) {
      reject(res, 415, tr('Envie o corpo como JSON (Content-Type: application/json).'));
      return true;
    }
  }
  return false;
}
