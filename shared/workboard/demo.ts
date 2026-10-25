// A fábrica do modo demonstração: percorre o roteiro (um quadro a cada ~20 s, em laço) e projeta cada quadro no
// escritório. Puro; o simulador (shared/demo/simulator.ts) só junta o resultado ao seu snapshot.
import { DEMO_FRAME_COUNT, demoFrame } from './demo-script';
import { parseFrame } from './parse';
import { projectFactory, type FactoryProjection } from './project';

export const DEMO_FRAME_MS = 20_000;

export interface FactoryDemoOptions {
  idPrefix: string;
  account: string;
  /** Multiplicador de velocidade do demo (2 = um quadro a cada 10 s). */
  speed?: number;
}

export class FactoryDemo {
  private startedAt: number;
  private stepMs: number;
  private key = '';

  constructor(private opts: FactoryDemoOptions, now: number) {
    this.startedAt = now;
    this.stepMs = DEMO_FRAME_MS / (opts.speed ?? 1);
  }

  /** A fábrica em `now`; `changed` = difere da chamada anterior (quadro novo, festa ou alarme que começou ou venceu). */
  tick(now: number, avoidNames: ReadonlySet<string>): { view: FactoryProjection; changed: boolean } {
    const step = Math.max(0, Math.floor((now - this.startedAt) / this.stepMs));
    const frameStart = this.startedAt + step * this.stepMs;
    const frame = parseFrame(demoFrame(step % DEMO_FRAME_COUNT, frameStart, this.stepMs));
    const view = projectFactory(frame, { idPrefix: this.opts.idPrefix, account: this.opts.account, now, createdAt: this.startedAt, avoidNames });
    const key = JSON.stringify(view);
    const changed = key !== this.key;
    this.key = key;
    return { view, changed };
  }
}
