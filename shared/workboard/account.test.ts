import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../types';
import { FACTORY_ACCOUNT_ID, findAccount } from './account';

const conta: AccountInfo = { id: '.claude', short: 'C', name: 'Conta C', color: '#ec8a3c', configDir: '/h/.claude', sessions: 1, usageStatus: 'ok' };

describe('workboard: conta dos personagens da fábrica', () => {
  it('aparece como OpenClaw, mesmo fora do snapshot', () => {
    expect(findAccount([conta], FACTORY_ACCOUNT_ID)).toMatchObject({ name: 'OpenClaw', short: 'OC' });
    expect(findAccount(undefined, FACTORY_ACCOUNT_ID)?.name).toBe('OpenClaw');
  });

  it('as outras contas continuam vindo só do snapshot', () => {
    expect(findAccount([conta], '.claude')).toBe(conta);
    expect(findAccount([conta], '.claude-conta2')).toBeUndefined();
    expect(findAccount(undefined, '.claude')).toBeUndefined();
  });
});
