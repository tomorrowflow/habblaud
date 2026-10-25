// Links da gaveta de um personagem da fábrica para o Workboard (só navegação: abrem em outra aba e valem também no
// modo portal, que é só leitura). A base é HABBLAUD_WORKBOARD_UI_URL (server/config.ts, parseWorkboardUiUrl), que o
// snapshot leva em `meta.workboardUi`; sem ela, nada de link.
import type { AgentInfo } from '../types';

/**
 * O cartão `cardId` do quadro `boardId` na Control UI do OpenClaw, a partir da base sem barra no fim: a página do
 * quadro (`/workboard/<boardId>`) abre o cartão de `?card=`.
 */
export function cardUrl(base: string, boardId: string, cardId: string): string {
  return `${base}/workboard/${encodeURIComponent(boardId)}?card=${encodeURIComponent(cardId)}`;
}

/** O "Abrir cartão" de um agente: só para personagens da fábrica e com a Control UI configurada. */
export function factoryCardUrl(agent: Pick<AgentInfo, 'factory'>, base: string | undefined): string | undefined {
  return agent.factory && base ? cardUrl(base, agent.factory.boardId, agent.factory.cardId) : undefined;
}
