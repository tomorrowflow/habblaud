// HABBLAUD_WORKBOARD_UI_URL: a base do link "Abrir cartão", do ambiente até o snapshot.
import { describe, expect, it } from 'vitest';
import { loadConfig, parseWorkboardUiUrl } from '../config';
import { NameStore } from '../model/names';
import { Office } from '../model/office';

const office = (workboardUi?: string) =>
  new Office({ names: new NameStore(null), version: 't', startedAt: 1, accounts: () => [], sources: () => [], accountName: () => undefined, workboardUi });

describe('HABBLAUD_WORKBOARD_UI_URL', () => {
  it('aceita http e https, com ou sem subcaminho, e tira a barra do fim', () => {
    expect(parseWorkboardUiUrl({ HABBLAUD_WORKBOARD_UI_URL: 'http://127.0.0.1:18789/' })).toEqual({ url: 'http://127.0.0.1:18789' });
    expect(parseWorkboardUiUrl({ HABBLAUD_WORKBOARD_UI_URL: ' https://gw.example.com/control// ' })).toEqual({ url: 'https://gw.example.com/control' });
  });

  it('ausente ou vazia: sem link e sem aviso', () => {
    expect(parseWorkboardUiUrl({})).toEqual({});
    expect(parseWorkboardUiUrl({ HABBLAUD_WORKBOARD_UI_URL: '  ' })).toEqual({});
  });

  it('recusa outro esquema, endereço inválido, usuário, senha, parâmetros e âncora (com o motivo)', () => {
    for (const bad of ['ws://127.0.0.1:18789', 'javascript:alert(1)', 'file:///etc/passwd', 'não é url', 'https://u:p@gw.example.com', 'https://gw.example.com/?token=x', 'https://gw.example.com/#x']) {
      const r = parseWorkboardUiUrl({ HABBLAUD_WORKBOARD_UI_URL: bad });
      expect(r.url, bad).toBeUndefined();
      expect(r.warning, bad).toMatch(/HABBLAUD_WORKBOARD_UI_URL/);
    }
  });

  it('chega ao snapshot (meta.workboardUi) só quando configurada, também no modo portal', () => {
    const cfg = loadConfig({ HABBLAUD_WORKBOARD_UI_URL: 'https://gw.example.com/', HABBLAUD_PORTAL: '1' }, []);
    expect(cfg).toMatchObject({ portal: true, workboardUi: 'https://gw.example.com' });
    expect(office(cfg.workboardUi).commit().snapshot.meta.workboardUi).toBe('https://gw.example.com');
    expect(loadConfig({}, []).workboardUi).toBeUndefined();
    expect(office(loadConfig({}, []).workboardUi).commit().snapshot.meta).not.toHaveProperty('workboardUi');
  });
});
