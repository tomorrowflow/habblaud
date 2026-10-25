// A conta dos personagens da fábrica: não é uma conta deste computador (os cartões rodam nos nós do OpenClaw), então
// nunca está em OfficeSnapshot.accounts nem tem uso. Os painéis e o mundo a mostram por esta apresentação fixa.
import type { AccountInfo } from '../types';

/** AccountInfo.id (e AgentInfo.account) dos personagens da fábrica, ao vivo e no demo. */
export const FACTORY_ACCOUNT_ID = 'openclaw';

export const FACTORY_ACCOUNT: Readonly<AccountInfo> = {
  id: FACTORY_ACCOUNT_ID,
  short: 'OC',
  name: 'OpenClaw',
  color: '#e0573f',
  configDir: '',
  sessions: 0,
  usageStatus: 'disabled',
};

/** A conta `id` de `accounts`; a da fábrica, que nunca vem no snapshot, pela apresentação fixa. */
export function findAccount(accounts: readonly AccountInfo[] | undefined, id: string): AccountInfo | undefined {
  return accounts?.find((a) => a.id === id) ?? (id === FACTORY_ACCOUNT_ID ? FACTORY_ACCOUNT : undefined);
}
