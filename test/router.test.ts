import { describe, expect, it, vi } from 'vitest';
import type { Logger, TranslationMode } from '../src/common/types';
import { WebviewMessageRouter } from '../src/preview/router';

function makeDeps(overrides: Partial<Parameters<WebviewMessageRouter['handle']>[1] extends never ? never : {
  logger: Logger;
  translateAll(): void | Promise<void>;
  retranslate(): void | Promise<void>;
  cancel(): void;
  setMode(mode: TranslationMode): void;
  translateSelection(text: string): Promise<string>;
  openLink(href: string): void | Promise<void>;
}> = {}) {
  const calls: string[] = [];
  const deps = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger,
    translateAll: vi.fn(async () => {
      calls.push('translateAll');
    }),
    retranslate: vi.fn(async () => {
      calls.push('retranslate');
    }),
    cancel: vi.fn(() => {
      calls.push('cancel');
    }),
    setMode: vi.fn((m: TranslationMode) => {
      calls.push(`setMode:${m}`);
    }),
    translateSelection: vi.fn(async (text: string) => `[zh] ${text}`),
    openLink: vi.fn(async (href: string) => {
      calls.push(`open:${href}`);
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe('WebviewMessageRouter', () => {
  it('routes translateAll / retranslate / cancel', async () => {
    const { deps, calls } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'translateAll' }, reply);
    await router.handle({ type: 'retranslate' }, reply);
    await router.handle({ type: 'cancel' }, reply);
    expect(calls).toEqual(['translateAll', 'retranslate', 'cancel']);
  });

  it('validates setMode values', async () => {
    const { deps, calls } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'setMode', mode: 'bilingual' }, reply);
    await router.handle({ type: 'setMode', mode: 'nonsense' as TranslationMode }, reply);
    expect(calls).toEqual(['setMode:bilingual']);
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('replies with the translation on success', async () => {
    const { deps } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'translateSelection', requestId: 7, text: 'hello world' }, reply);
    expect(reply).toHaveBeenCalledWith({
      type: 'selectionTranslationResult',
      requestId: 7,
      ok: true,
      text: '[zh] hello world',
    });
  });

  it('replies with an error when the provider fails', async () => {
    const { deps } = makeDeps({
      translateSelection: vi.fn(async () => {
        throw new Error('provider exploded');
      }),
    });
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'translateSelection', requestId: 1, text: 'x' }, reply);
    expect(reply).toHaveBeenCalledWith({
      type: 'selectionTranslationResult',
      requestId: 1,
      ok: false,
      error: 'provider exploded',
    });
  });

  it('rejects empty and oversized selections without calling the provider', async () => {
    const { deps } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'translateSelection', requestId: 2, text: '   ' }, reply);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ requestId: 2, ok: false }));
    await router.handle(
      { type: 'translateSelection', requestId: 3, text: 'x'.repeat(9000) },
      reply,
    );
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ requestId: 3, ok: false }));
    expect(deps.translateSelection).not.toHaveBeenCalled();
  });

  it('validates openLink hrefs', async () => {
    const { deps, calls } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await router.handle({ type: 'openLink', href: 'https://example.com/a' }, reply);
    await router.handle({ type: 'openLink', href: '' }, reply);
    await router.handle({ type: 'openLink', href: 'x'.repeat(3000) }, reply);
    expect(calls).toEqual(['open:https://example.com/a']);
  });

  it('ignores malformed and unknown messages without throwing', async () => {
    const { deps } = makeDeps();
    const router = new WebviewMessageRouter(deps);
    const reply = vi.fn();
    await expect(router.handle(null, reply)).resolves.toBeUndefined();
    await expect(router.handle('nope', reply)).resolves.toBeUndefined();
    await expect(router.handle({ type: 'mystery' }, reply)).resolves.toBeUndefined();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
