// O Habblaud como dispositivo pareado do Gateway do OpenClaw: o par de chaves Ed25519 (node:crypto) e o token do
// dispositivo (`hello-ok.auth.deviceToken`) em <dataDir>/workboard.json, modo 600 e gravação atômica, como o world.json
// (server/world/settings.ts). A chave privada e o token nunca vão para log, snapshot nem navegador.
//
// Portado do OpenClaw: o id do dispositivo é o SHA-256 (hex) da chave pública crua e a chave vai como base64url dos 32
// bytes crus (src/infra/device-identity.ts, deriveDeviceIdFromPublicKey; src/infra/ed25519-signature.ts); a assinatura
// é Ed25519 do texto UTF-8 em base64url (signEd25519Payload) sobre o payload v3
// (packages/gateway-client/src/device-auth.ts, buildDeviceAuthPayloadV3).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { log } from '../log';

export interface DeviceRecord {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  /** Token do dispositivo emitido pelo Gateway depois do pareamento: segredo. */
  deviceToken?: string;
  updatedAt: number;
}

const MAX_FILE = 64 * 1024;

/** Os 32 bytes crus da chave pública Ed25519 (o fim do DER SPKI). */
function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return der.subarray(der.length - 32);
}

export const publicKeyBase64Url = (publicKeyPem: string): string => rawPublicKey(publicKeyPem).toString('base64url');

export const deviceIdOf = (publicKeyPem: string): string => createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex');

export function newDevice(now: number): DeviceRecord {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { deviceId: deviceIdOf(publicKeyPem), publicKeyPem, privateKeyPem, updatedAt: now };
}

/** Metadado do payload como o Gateway compara: sem espaços nas pontas e só ASCII em minúsculas. */
const normalizeMeta = (v: string | undefined): string => (v ?? '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

/** O texto assinado no `connect` (v3): amarra o desafio, o cliente, o papel, os escopos e o token enviado. */
export function devicePayloadV3(p: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: readonly string[];
  signedAtMs: number;
  token?: string;
  nonce: string;
  platform?: string;
  deviceFamily?: string;
}): string {
  return ['v3', p.deviceId, p.clientId, p.clientMode, p.role, p.scopes.join(','), String(p.signedAtMs), p.token ?? '', p.nonce, normalizeMeta(p.platform), normalizeMeta(p.deviceFamily)].join('|');
}

export const signPayload = (privateKeyPem: string, payload: string): string => sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64url');

function parseRecord(raw: unknown): DeviceRecord | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.publicKeyPem !== 'string' || typeof v.privateKeyPem !== 'string') return undefined;
  try {
    // A chave privada precisa ser a da pública (arquivo editado à mão): assina e confere.
    const probe = signPayload(v.privateKeyPem, 'habblaud');
    if (!verify(null, Buffer.from('habblaud'), v.publicKeyPem, Buffer.from(probe, 'base64url'))) return undefined;
    const rec: DeviceRecord = { deviceId: deviceIdOf(v.publicKeyPem), publicKeyPem: v.publicKeyPem, privateKeyPem: v.privateKeyPem, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 };
    if (typeof v.deviceToken === 'string' && v.deviceToken.trim()) rec.deviceToken = v.deviceToken;
    return rec;
  } catch {
    return undefined;
  }
}

/** O arquivo workboard.json. Sem arquivo (ou ilegível), cria um dispositivo novo: o Gateway pede pareamento de novo. */
export class DeviceStore {
  private record: DeviceRecord | undefined;

  /** `file` null = só em memória (testes). */
  constructor(
    readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  get(): DeviceRecord {
    if (!this.record) this.record = this.read() ?? this.write(newDevice(this.now()));
    return { ...this.record };
  }

  /** Guarda (ou apaga, com undefined) o token do dispositivo. */
  setToken(token: string | undefined): void {
    const { deviceToken: _old, ...rest } = this.get();
    this.write({ ...rest, ...(token ? { deviceToken: token } : {}), updatedAt: this.now() });
  }

  private read(): DeviceRecord | undefined {
    if (!this.file) return undefined;
    try {
      const st = statSync(this.file);
      if (st.size > MAX_FILE) throw new Error('too large');
      if ((st.mode & 0o077) !== 0) chmodSync(this.file, 0o600);
      const rec = parseRecord(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!rec) log.warn(tr('workboard.json fora do formato: um dispositivo novo será pareado com o Gateway.'));
      return rec;
    } catch (err) {
      // Só o código do erro: o conteúdo tem a chave privada.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') log.warn(tr('workboard.json ilegível ({0}): um dispositivo novo será pareado com o Gateway.', [code ?? 'JSON']));
      return undefined;
    }
  }

  private write(rec: DeviceRecord): DeviceRecord {
    this.record = rec;
    if (!this.file) return rec;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      log.clearOnce('workboard-write');
    } catch (err) {
      rmSync(tmp, { force: true });
      log.warnOnce('workboard-write', tr('Não foi possível gravar {0} ({1}); o pareamento com o Gateway vale só nesta execução.', [this.file, (err as NodeJS.ErrnoException).code ?? '?']));
    }
    return rec;
  }
}
