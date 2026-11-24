import { describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from '../src/translation/openaiProvider';
import { type ProviderBatchEntry, type ProviderContext } from '../src/translation/types';

const ctx: ProviderContext = {
  systemPrompt: 'Translate from {sourceLanguage} to {targetLanguage}.',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  model: 'gpt-4o-mini',
  temperature: 0.3,
};

function entries(): ProviderBatchEntry[] {
  return [
    { id: 's1', kind: 'paragraph', text: 'Hello world' },
    { id: 's2', kind: 'paragraph', text: 'Second segment' },
  ];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function providerWith(
  fetchImpl: typeof fetch,
  overrides: Partial<OpenAICompatibleProviderOptions> = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://api.openai.com/v1',
    getApiKey: async () => 'test-key',
    fetchImpl,
    ...overrides,
  });
}

function requestInit(call: [RequestInfo | URL, (RequestInit | undefined)?]): RequestInit {
  return call[1] ?? {};
}

describe('OpenAICompatibleProvider.translateBatch', () => {
  it('returns [] immediately for empty entries without any network call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ translations: {} }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch([], ctx, { timeoutMs: 5000 })).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts a correct request and returns ordered results', async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ translations: { s1: 'T1', s2: 'T2' } }),
    );
    const provider = providerWith(fetchImpl);
    const results = await provider.translateBatch(entries(), ctx, { timeoutMs: 5000 });

    expect(results).toEqual([
      { id: 's1', text: 'T1' },
      { id: 's2', text: 'T2' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse((init?.body ?? '') as string) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('from en to zh');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('"s1"');
  });

  it('does not double-append /chat/completions and trims trailing slashes', async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ translations: { s1: 'T1', s2: 'T2' } }),
    );
    const exact = providerWith(fetchImpl, { baseUrl: 'https://api.example.com/v1/chat/completions' });
    await exact.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');

    const slashed = providerWith(fetchImpl, { baseUrl: 'https://api.example.com/v1/' });
    await slashed.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('tolerates content that is already a parsed object with a translations wrapper', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: { translations: { s1: 'T1', s2: 'T2' } } } }] }),
    );
    const provider = providerWith(fetchImpl);
    const results = await provider.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    expect(results.map((r) => r.text)).toEqual(['T1', 'T2']);
  });

  it('tolerates a direct object response without a translations wrapper', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: { s1: 'T1', s2: 'T2' } } }] }));
    const provider = providerWith(fetchImpl);
    const results = await provider.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    expect(results.map((r) => r.text)).toEqual(['T1', 'T2']);
  });

  it('retries once without response_format when strictJson gets a 400', async () => {
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      if (inits.length === 1) {
        return new Response('model does not support json_object', { status: 400 });
      }
      return jsonResponse({ translations: { s1: 'T1', s2: 'T2' } });
    });
    const provider = providerWith(fetchImpl);
    const results = await provider.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    expect(results.map((r) => r.text)).toEqual(['T1', 'T2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse((inits[0].body ?? '') as string) as Record<string, unknown>;
    const second = JSON.parse((inits[1].body ?? '') as string) as Record<string, unknown>;
    expect(first.response_format).toEqual({ type: 'json_object' });
    expect('response_format' in second).toBe(false);
  });

  it('fails with http after a second consecutive 400 (no infinite retry)', async () => {
    const fetchImpl = vi.fn(async () => new Response('still unsupported', { status: 400 }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'http',
      statusCode: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never sends response_format when strictJson is false', async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ translations: { s1: 'T1', s2: 'T2' } }),
    );
    const provider = providerWith(fetchImpl, { strictJson: false });
    await provider.translateBatch(entries(), ctx, { timeoutMs: 5000 });
    const init = requestInit(fetchImpl.mock.calls[0]);
    const body = JSON.parse((init.body ?? '') as string) as Record<string, unknown>;
    expect('response_format' in body).toBe(false);
  });

  it.each<[number, string]>([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limited'],
    [500, 'http'],
    [502, 'http'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const fetchImpl = vi.fn(async () => new Response('error body', { status }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind,
      statusCode: status,
    });
  });

  it('rejects a body that is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{{{not json', { status: 200 }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects content that is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'not valid json' } }] }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects a response that is missing one id and mentions it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ translations: { s1: 'T1' } }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'invalid-response',
      message: expect.stringContaining('s2'),
    });
  });

  it('rejects empty or non-string translation values', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ translations: { s1: '', s2: 42 } }));
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'invalid-response',
      message: expect.stringContaining('s1'),
    });
  });

  it('throws auth without calling fetch when no API key is set', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ translations: {} }));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      getApiKey: async () => undefined,
      fetchImpl,
    });
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a pre-aborted external signal to aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return jsonResponse({ translations: { s1: 'T1', s2: 'T2' } });
    });
    const provider = providerWith(fetchImpl);
    await expect(
      provider.translateBatch(entries(), ctx, { timeoutMs: 5000, signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('maps an internal timeout to timeout even when fetch reports AbortError', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return jsonResponse({ translations: { s1: 'T1', s2: 'T2' } });
    });
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 30 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('maps a TimeoutError rejection to timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('maps other fetch failures to network', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = providerWith(fetchImpl);
    await expect(provider.translateBatch(entries(), ctx, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('never leaks the API key into error messages', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused for https://user:test-key@api.example.com');
    });
    const provider = providerWith(fetchImpl);
    const error = await provider
      .translateBatch(entries(), ctx, { timeoutMs: 5000 })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('test-key');
  });
});
