import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../types';
import { cardUrl, factoryCardUrl } from './links';

const BASE = 'https://gateway.local:18789';
const factory = (boardId: string, cardId: string): Pick<AgentInfo, 'factory'> => ({ factory: { boardId, cardId, role: 'builder' } });

describe('workboard: link "Abrir cartão"', () => {
  it('cardUrl aponta para o cartão na Control UI, com os ids escapados', () => {
    const url = new URL(cardUrl(BASE, 'loja online', 'wb/1?x'));
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe('/workboard/loja%20online');
    expect(url.searchParams.get('card')).toBe('wb/1?x');
    expect(url.hash).toBe('');
  });

  it('só personagens da fábrica e só com a Control UI configurada', () => {
    expect(factoryCardUrl(factory('loja', 'wb-1'), BASE)).toBe(cardUrl(BASE, 'loja', 'wb-1'));
    expect(factoryCardUrl(factory('loja', 'wb-1'), undefined)).toBeUndefined();
    expect(factoryCardUrl({}, BASE)).toBeUndefined();
  });
});
