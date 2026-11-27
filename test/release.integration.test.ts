import { describe, expect, it, vi } from 'vitest';
import { MarkdownPipeline } from '../src/markdown/pipeline';
import { MemoryTranslationCache } from '../src/translation/cache';
import { OpenAICompatibleProvider } from '../src/translation/openaiProvider';
import { TranslationService } from '../src/translation/service';
import { ProviderError, type TranslateOptions, type TranslationProvider } from '../src/translation/types';

const settings: TranslateOptions = {
  apiBaseUrl: 'https://api.example.com/v1',
  model: 'fixture-model',
  systemPrompt: 'Translate from {sourceLanguage} to {targetLanguage}.',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  temperature: 0.3,
  timeoutMs: 500,
  maxConcurrency: 2,
  maxTokensPerRequest: 1000,
  retries: 0,
};

describe('release integration', () => {
  it('round-trips Markdown through Chat Completions and reuses cache after an edit', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const segments = JSON.parse(body.messages[1].content.split('Segments:\n')[1]) as { id: string; text: string }[];
      seen.push(...segments.map(({ text }) => text));
      const content = JSON.stringify({ translations: Object.fromEntries(segments.map(({ id, text }) => [id, 'T:' + text])) });
      return Response.json({ choices: [{ message: { content } }] });
    });
    const service = new TranslationService(new OpenAICompatibleProvider({ getApiKey: async () => 'fixture-only', fetchImpl }));
    const cache = new MemoryTranslationCache();
    const pipeline = new MarkdownPipeline();
    const markdown = [
      '---', 'title: settings', '---', '', '# Guide', '', '- Open ./src/main.ts before editing.',
      '- Use [the guide](https://example.com/guide) and <https://example.com/readme>.',
      '', '| Name | Value |', '| --- | --- |', '| Mode | $x^2$ |', '',
      '~~~mermaid', 'graph TD; A-->B;', '~~~', '', 'Final paragraph.',
    ].join('\n');
    const roundTrip = async (source: string) => {
      const doc = pipeline.parse(source);
      const { segments } = doc.extractSegments();
      doc.applyTranslations(await service.translateSegments(segments, { ...settings, cache }));
      const src = doc.render({ version: 'src' });
      const translated = doc.render({ version: 'trans' });
      for (const index of doc.translatedBlocks) {
        expect(src).toContain('data-mdt-block="' + index + '"');
        expect(translated).toContain('data-mdt-block="' + index + '"');
      }
      return { src, translated };
    };

    const { src, translated } = await roundTrip(markdown);
    expect(src).not.toContain('T:Guide');
    expect(translated).toContain('T:Open ./src/main.ts T:before editing.');
    expect(translated).toContain('href="https://example.com/guide">T:the guide</a>');
    expect(translated).toContain('>https://example.com/readme</a>');
    expect(translated).toContain('language-mermaid');
    expect(translated).toContain('class="katex"');
    expect(seen.join(' ')).not.toMatch(/src\/main|example\.com|graph TD|x\^2|title: settings/);
    seen.length = 0;
    await roundTrip(markdown.replace('Final paragraph.', 'Edited paragraph.'));
    expect(seen).toEqual(['Edited paragraph.']);
  });

  it('separates endpoint, model, prompt, languages, temperature, segment kind and text', async () => {
    const translateBatch = vi.fn<TranslationProvider['translateBatch']>(async (entries) => entries);
    const service = new TranslationService({ id: 'fixture', translateBatch });
    const cache = new MemoryTranslationCache();
    const first = { id: 's0', kind: 'paragraph', text: 'Same sentence' };
    const opts = { ...settings, cache };
    await service.translateSegments([first], opts);
    await service.translateSegments([{ ...first, id: 'renumbered' }], opts);
    expect(translateBatch).toHaveBeenCalledTimes(1);
    for (const change of [
      { apiBaseUrl: 'https://other.example.com/v1' },
      { model: 'another-model' },
      { systemPrompt: 'A changed prompt' },
      { sourceLanguage: 'fr' },
      { targetLanguage: 'ja' },
      { temperature: 0.6 },
    ]) await service.translateSegments([first], { ...opts, ...change });
    await service.translateSegments([{ ...first, kind: 'heading' }], opts);
    await service.translateSegments([{ ...first, text: 'Edited sentence' }], opts);
    expect(translateBatch).toHaveBeenCalledTimes(9);
  });

  it('aborts sibling chunks on failure while another document run completes, with no partial cache write', async () => {
    const cache = new MemoryTranslationCache();
    const cacheSet = vi.spyOn(cache, 'set');
    const sibling = vi.fn();
    const translateBatch = vi.fn<TranslationProvider['translateBatch']>((entries, _ctx, { signal }) => {
      if (entries[0].id === 'err') return Promise.reject(new ProviderError('auth', 'Fixture error'));
      if (entries[0].id !== 'sibling') return Promise.resolve(entries);
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
        sibling();
        reject(new ProviderError('aborted', 'Cancelled fixture'));
      }, { once: true }));
    });
    const service = new TranslationService({ id: 'fixture', translateBatch });
    const segment = (id: string) => ({ id, kind: 'paragraph', text: id.repeat(2200) });
    const failed = service.translateSegments(['err', 'sibling', 'queued'].map(segment), { ...settings, cache });
    const independent = service.translateText('independent document', settings);
    await expect(failed).rejects.toMatchObject({ kind: 'auth' });
    await expect(independent).resolves.toBe('independent document');
    expect(sibling).toHaveBeenCalledOnce();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(translateBatch.mock.calls.flatMap(([entries]) => entries.map(({ id }) => id))).not.toContain('queued');
  });

  it('stops retry backoff and refuses cancelled cache-only runs', async () => {
    const controller = new AbortController();
    const translateBatch = vi.fn<TranslationProvider['translateBatch']>(async () => {
      setTimeout(() => controller.abort(), 10);
      throw new ProviderError('rate-limited', 'Fixture error');
    });
    const service = new TranslationService({ id: 'fixture', translateBatch });
    await expect(service.translateText('retry', { ...settings, retries: 3, signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect(translateBatch).toHaveBeenCalledOnce();
    await expect(service.translateText(' ', { ...settings, cache: new MemoryTranslationCache(), signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'aborted' });
  });
});
