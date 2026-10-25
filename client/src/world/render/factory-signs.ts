// Placas da sala da fábrica, em pixels (a fonte 3x5 de art/pixelfont.ts, como as placas das fachadas da cidade):
// a etiqueta "N na fila", pendurada logo abaixo da placa com o nome, e o quadrinho "N de M / autônomos" com a barra da
// fração, no lugar do relógio e do pôster. Geradas uma vez por texto (canvas em cache), nunca por frame.
import type { Sprite } from '../../art/api';
import { pixelText, pixelTextWidth } from '../../art/pixelfont';
import { tr } from '../../../../shared/i18n';

const OUTLINE = '#151a26';
const CHAIN = '#7a8190';
const TAG = '#f2c14e';
const TAG_HI = '#f8d77f';
const TAG_TEXT = '#2b2f3b';
const BOARD = '#2b3346';
const BOARD_HI = '#3a4458';
const BOARD_TEXT = '#f3f5fa';
const BOARD_NUM = '#ffe08a';
const BAR = '#4cae6a';

/** Largura máxima do quadrinho: o vão entre a placa com o nome e a janela (salas ao norte; world/layout/room.ts). */
const TRUST_MAX_W = 45;
/** A etiqueta não passa da largura da placa com o nome. */
const TAG_MAX_W = 42;

const cache = new Map<string, Sprite>();

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Texto cortado na largura `w` (a fonte não tem reticências: só some o que não cabe). */
function clippedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 3, w, 10);
  ctx.clip();
  pixelText(ctx, text, x, y, color);
  ctx.restore();
}

/** Etiqueta "N na fila" com as duas correntinhas; âncora no meio do topo (o pé da placa com o nome). */
export function queueTag(queued: number): Sprite {
  const text = tr('{0} na fila', [queued]);
  const key = `q|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tw = Math.min(TAG_MAX_W - 6, pixelTextWidth(text));
  const w = tw + 6;
  const chain = 3;
  const h = chain + 9;
  const { c, ctx } = canvas(w, h);
  rect(ctx, 3, 0, 1, chain, CHAIN);
  rect(ctx, w - 4, 0, 1, chain, CHAIN);
  rect(ctx, 1, chain, w - 2, 9, OUTLINE);
  rect(ctx, 0, chain + 1, w, 7, OUTLINE);
  rect(ctx, 1, chain + 1, w - 2, 7, TAG);
  rect(ctx, 1, chain + 1, w - 2, 1, TAG_HI);
  clippedText(ctx, text, 3, chain + 2, tw, TAG_TEXT);
  const s = { canvas: c, ax: Math.floor(w / 2), ay: 0 };
  cache.set(key, s);
  return s;
}

/**
 * Quadrinho da autonomia da semana: "N de M" em cima, "autônomos" embaixo (com espaço para o acento) e a barra da
 * fração. Âncora no meio da base (o rodapé da face da parede), como os itens de parede.
 */
export function trustBoard(autonomous: number, accepted: number): Sprite {
  const line1 = tr('{0} de {1}', [autonomous, accepted]);
  const line2 = tr('autônomos');
  const key = `t|${line1}|${line2}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tw = Math.min(TRUST_MAX_W - 6, Math.max(pixelTextWidth(line1), pixelTextWidth(line2)));
  const w = tw + 6;
  const h = 22;
  const { c, ctx } = canvas(w, h);
  rect(ctx, 1, 0, w - 2, h, OUTLINE);
  rect(ctx, 0, 1, w, h - 2, OUTLINE);
  rect(ctx, 1, 1, w - 2, h - 2, BOARD);
  rect(ctx, 1, 1, w - 2, 1, BOARD_HI);
  const center = (t: string) => 3 + Math.max(0, Math.floor((tw - pixelTextWidth(t)) / 2));
  clippedText(ctx, line1, center(line1), 3, tw, BOARD_NUM);
  clippedText(ctx, line2, center(line2), 11, tw, BOARD_TEXT);
  rect(ctx, 3, 18, tw, 2, OUTLINE);
  rect(ctx, 3, 18, Math.round((tw * autonomous) / Math.max(1, accepted)), 2, BAR);
  // 2 px acima do rodapé, como os quadros da parede
  const s = { canvas: c, ax: Math.floor(w / 2), ay: h + 4 };
  cache.set(key, s);
  return s;
}
