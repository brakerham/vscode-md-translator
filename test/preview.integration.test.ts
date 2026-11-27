import { describe, expect, it, vi } from 'vitest';
import type { TextDocument } from 'vscode';
import { MarkdownPipeline } from '../src/markdown/pipeline';
import { PreviewManager, type PreviewManagerDeps } from '../src/preview/manager';
import { MemoryTranslationCache } from '../src/translation/cache';
import { TranslationService } from '../src/translation/service';
import type { TranslateOptions, TranslationProvider } from '../src/translation/types';
import { sleep } from '../src/translation/utils';

const { panels } = vi.hoisted(() => {
  type Listener<T> = (value: T) => void;
  class Event<T> {
    private readonly listeners = new Set<Listener<T>>();
    readonly event = (listener: Listener<T>, _context?: unknown, disposables?: { dispose(): void }[]) => {
      this.listeners.add(listener);
      const disposable = { dispose: () => { this.listeners.delete(listener); } };
      disposables?.push(disposable);
      return disposable;
    };
    fire(value: T): void { for (const listener of this.listeners) listener(value); }
    dispose(): void { this.listeners.clear(); }
  }
  const createPanel = () => {
    const received = new Event<unknown>();
    const closed = new Event<void>();
    return {
      viewColumn: 2,
      visible: true,
      received,
      webview: {
        cspSource: 'https://fixtures.example',
        html: '',
        postMessage: vi.fn(async (_message: unknown) => true),
        onDidReceiveMessage: received.event,
        asWebviewUri: (uri: TestUri) => uri,
      },
      onDidDispose: closed.event,
      onDidChangeViewState: new Event<unknown>().event,
      reveal: vi.fn(),
      dispose: () => closed.fire(),
    };
  };
  class TestUri {
    readonly scheme = 'file';
    readonly authority = '';
    constructor(readonly path: string) {}
    toString(): string { return 'file://' + this.path; }
  }
  const panels: ReturnType<typeof createPanel>[] = [];
  vi.doMock('vscode', () => ({
    EventEmitter: Event,
    Uri: { joinPath: (uri: TestUri, ...parts: string[]) => new TestUri([uri.path, ...parts].join('/')) },
    ViewColumn: { Beside: 2 },
    window: {
      createWebviewPanel() {
        const panel = createPanel();
        panels.push(panel);
        return panel;
      },
    },
    env: { language: 'en' },
    workspace: {
      workspaceFolders: [],
      onDidChangeTextDocument: new Event<unknown>().event,
      onDidChangeConfiguration: new Event<unknown>().event,
    },
  }));
  return { panels };
});

const opts: TranslateOptions = {
  model: 'preview-fixture', systemPrompt: 'Fixture', sourceLanguage: 'en', targetLanguage: 'zh',
  temperature: 0, timeoutMs: 500, maxConcurrency: 1, maxTokensPerRequest: 1000, retries: 0,
};

function doc(name: string): TextDocument {
  return {
    uri: { path: '/' + name + '.md', toString: () => 'file:///' + name + '.md' },
    getText: () => '# ' + name,
  } as TextDocument;
}

describe('preview manager and panel lifecycle', () => {
  it('reuses a document panel, preserves a cold force refresh and cancels only its own run', async () => {
    const started: string[] = [];
    const translateBatch = vi.fn<TranslationProvider['translateBatch']>(async (entries, _ctx, { signal }) => {
      started.push(entries[0].text);
      if (entries[0].text === 'First') await sleep(1000, signal);
      return entries.map(({ id, text }) => ({ id, text: 'T:' + text }));
    });
    const service = new TranslationService({ id: 'preview-fixture', translateBatch });
    const cache = new MemoryTranslationCache();
    // Prime the exact cache key used by a heading. The first panel must bypass it.
    cache.set((await import('../src/translation/prompts')).cacheKeyFor('First', opts, 'heading'), 'cached-first');
    const manager = new PreviewManager({
      context: { extensionUri: { path: '/fixture' } },
      pipeline: new MarkdownPipeline(),
      service,
      cache,
      configProvider: {
        read: () => ({ translationMode: 'bilingual', targetLanguage: 'zh' }),
        hasApiKey: async () => true,
        onDidChangeSecrets: () => ({ dispose() {} }),
        toTranslateOptions: (_cfg: unknown, extra: Partial<TranslateOptions>) => ({ ...opts, ...extra }),
      },
      statusCenter: { publishDocumentStatus: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as PreviewManagerDeps);
    try {
      const firstDoc = doc('First');
      const first = await manager.retranslate(firstDoc);
      expect(await manager.show(firstDoc)).toBe(first);
      await manager.show(doc('Second'));
      expect(panels).toHaveLength(2);

      for (const panel of panels) panel.received.fire({ type: 'ready' });
      await vi.waitFor(() => expect(started).toEqual(['First', 'Second']));
      panels[0].received.fire({ type: 'cancel' });

      expect(panels[0].webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'status', state: 'cancelled' }));
      expect(panels[0].webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'updateHtml' }));
      expect(panels[1].webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'updateHtml', translatedHtml: expect.stringContaining('T:Second') }));

      panels[0].dispose();
      expect(await manager.show(firstDoc)).not.toBe(first);
      expect(panels).toHaveLength(3);
    } finally {
      manager.dispose();
    }
  });
});
