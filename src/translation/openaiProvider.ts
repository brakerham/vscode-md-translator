/**
 * OpenAI-compatible chat completions provider. Talks to any endpoint that
 * follows the OpenAI /v1/chat/completions contract (OpenAI, DeepSeek, ...).
 */
import type { Logger } from '../common/types';
import { buildUserPrompt, substituteLanguages } from './prompts';
import {
  ProviderError,
  type ProviderBatchEntry,
  type ProviderBatchResult,
  type ProviderContext,
  type ProviderRequestOptions,
  type TranslationProvider,
} from './types';
import { combineAbortSignals } from './utils';

export interface OpenAICompatibleProviderOptions {
  /** Base URL, e.g. "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Returns the API key from SecretStorage; must never be sent to the webview. */
  getApiKey: (endpoint: string) => Promise<string | undefined>;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Send response_format json_object and transparently retry without it on HTTP 400. */
  strictJson?: boolean;
  logger?: Logger;
}

/** Allows HTTPS providers and plain HTTP only for local model servers. */
export function completionEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new ProviderError('config', 'Enter a valid API base URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new ProviderError('config', 'Use an HTTPS API URL or a local loopback HTTP URL, without credentials, query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) {
    url.pathname += '/chat/completions';
  }
  return url.toString();
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Narrows an unknown parsed JSON value to a plain object, if possible. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extracts the assistant content from a chat-completion JSON body. */
function extractContent(json: unknown): unknown {
  const root = asRecord(json);
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const first = asRecord(choices[0]);
  const message = first ? asRecord(first.message) : undefined;
  return message?.content;
}

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id = 'openai-compatible';

  private readonly baseUrl?: string;
  private readonly getApiKey: (endpoint: string) => Promise<string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly strictJson: boolean;
  private readonly logger?: Logger;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.getApiKey = options.getApiKey;
    this.strictJson = options.strictJson ?? true;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async translateBatch(
    entries: ProviderBatchEntry[],
    ctx: ProviderContext,
    opts: ProviderRequestOptions,
  ): Promise<ProviderBatchResult[]> {
    if (entries.length === 0) {
      return [];
    }

    if (opts.signal?.aborted) throw new ProviderError('aborted', 'Request aborted');
    const url = completionEndpoint(ctx.apiBaseUrl ?? this.baseUrl ?? '');
    const key = await this.getApiKey(url);
    if (!key) {
      throw new ProviderError('auth', 'API key is not set. Run the "Set API Key" command.');
    }

    // Transparently drop response_format when the model rejects it (HTTP 400).
    let includeResponseFormat = this.strictJson;
    for (;;) {
      const { status, ok, text } = await this.send(url, key, entries, ctx, opts, includeResponseFormat);

      if (status === 400 && includeResponseFormat) {
        this.logger?.debug('provider rejected response_format; retrying without it');
        includeResponseFormat = false;
        continue;
      }

      if (status === 401 || status === 403) {
        throw new ProviderError('auth', 'API key invalid or unauthorized. Check your API key.', status);
      }
      if (status === 429) {
        throw new ProviderError('rate-limited', 'Rate limited by the API provider.', status);
      }
      if (!ok) {
        throw new ProviderError('http', `HTTP ${status} from the API provider.`, status);
      }

      return this.parseResults(entries, text);
    }
  }

  private async send(
    url: string,
    key: string,
    entries: ProviderBatchEntry[],
    ctx: ProviderContext,
    opts: ProviderRequestOptions,
    includeResponseFormat: boolean,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const body: Record<string, unknown> = {
      model: ctx.model,
      temperature: ctx.temperature,
      stream: false,
      messages: [
        {
          role: 'system',
          content: substituteLanguages(ctx.systemPrompt, ctx.sourceLanguage, ctx.targetLanguage),
        },
        { role: 'user', content: buildUserPrompt(entries, ctx) },
      ],
    };
    if (includeResponseFormat) {
      body.response_format = { type: 'json_object' };
    }

    const combined = combineAbortSignals(opts.signal, opts.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: combined.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, ok: false, text: '' };
      }
      const text = await response.text();
      combined.signal.throwIfAborted();
      return { status: response.status, ok: true, text };

    } catch (err) {
      if (opts.signal?.aborted) {
        throw new ProviderError('aborted', 'Request aborted');
      }
      if (combined.didTimeout() || isTimeoutError(err)) {
        throw new ProviderError('timeout', `Request timed out after ${opts.timeoutMs} ms.`);
      }
      throw new ProviderError('network', 'Could not complete the request to the API provider.');
    } finally {
      combined.dispose();
    }
  }

  private parseResults(entries: ProviderBatchEntry[], rawText: string): ProviderBatchResult[] {
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new ProviderError('invalid-response', 'The API returned a response that is not valid JSON.');
    }

    const root = asRecord(json);
    const content = extractContent(json);
    let candidate: Record<string, unknown> | undefined;
    if (typeof content === 'string') {
      // The content may itself be a string of JSON.
      try {
        candidate = asRecord(JSON.parse(content));
      } catch {
        candidate = undefined;
      }
      if (!candidate) {
        throw new ProviderError('invalid-response', 'The API returned content that is not valid JSON.');
      }
    } else if (content !== undefined) {
      // Some providers return the content already parsed as an object.
      candidate = asRecord(content);
      if (!candidate) {
        throw new ProviderError('invalid-response', 'The API returned unexpected translation content.');
      }
    } else {
      // Lenient fallback: a bare `{ "translations": { ... } }` body without choices.
      candidate = root;
    }

    // Prefer an explicit "translations" wrapper; otherwise use the object itself.
    const translations = candidate ? asRecord(candidate.translations) ?? candidate : undefined;
    if (!translations) {
      throw new ProviderError('invalid-response', 'The API response did not contain any translation content.');
    }

    const missing: string[] = [];
    const results: ProviderBatchResult[] = [];
    for (const entry of entries) {
      const value = translations[entry.id];
      if (typeof value !== 'string' || value.trim().length === 0) {
        missing.push(entry.id);
        continue;
      }
      results.push({ id: entry.id, text: value });
    }
    if (missing.length > 0) {
      throw new ProviderError(
        'invalid-response',
        `The API response is missing translations for ids: ${missing.join(', ')}.`,
      );
    }
    return results;
  }

}
