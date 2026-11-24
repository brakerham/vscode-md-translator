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
  baseUrl: string;
  /** Returns the API key from SecretStorage; must never be sent to the webview. */
  getApiKey: () => Promise<string | undefined>;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Send response_format json_object and transparently retry without it on HTTP 400. */
  strictJson?: boolean;
  logger?: Logger;
}

/** Longest raw-response snippet allowed inside an invalid-response error. */
const MAX_INVALID_RESPONSE_EXCERPT = 300;
/** Longest raw-response snippet allowed inside an HTTP error message. */
const MAX_HTTP_EXCERPT = 200;
/** Longest message we ever echo from an unexpected error. */
const MAX_ERROR_MESSAGE = 300;

/** Collapses whitespace and truncates raw text to a log-safe snippet. */
function excerpt(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/** Builds a safe single-line message from an unknown thrown value. */
function safeErrorMessage(err: unknown, secret?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  let cleaned = message.replace(/\s+/g, ' ').trim();
  if (secret) {
    // Defensive scrub: the key must never surface in an error message.
    cleaned = cleaned.replaceAll(secret, '***');
  }
  return cleaned.length <= MAX_ERROR_MESSAGE ? cleaned : `${cleaned.slice(0, MAX_ERROR_MESSAGE)}…`;
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

/** Reads the response body text, tolerating a failed body read. */
async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id = 'openai-compatible';

  private readonly baseUrl: string;
  private readonly getApiKey: () => Promise<string | undefined>;
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

    const key = await this.getApiKey();
    if (!key) {
      throw new ProviderError('auth', 'API key is not set. Run the "Set API Key" command.');
    }

    const url = this.buildUrl();
    // Transparently drop response_format when the model rejects it (HTTP 400).
    let includeResponseFormat = this.strictJson;
    for (;;) {
      const response = await this.send(url, key, entries, ctx, opts, includeResponseFormat);

      if (response.status === 400 && includeResponseFormat) {
        this.logger?.debug('provider rejected response_format; retrying without it');
        includeResponseFormat = false;
        continue;
      }

      const text = await readResponseText(response);
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('auth', 'API key invalid or unauthorized. Check your API key.', response.status);
      }
      if (response.status === 429) {
        throw new ProviderError('rate-limited', 'Rate limited by the API provider.', response.status);
      }
      if (!response.ok) {
        const snippet = excerpt(text, MAX_HTTP_EXCERPT);
        this.logger?.warn(`HTTP ${response.status} from ${this.id}: ${snippet}`);
        throw new ProviderError(
          'http',
          `HTTP ${response.status} from the API provider.${snippet ? ` ${snippet}` : ''}`,
          response.status,
        );
      }

      return this.parseResults(entries, text);
    }
  }

  /** Trims trailing slashes and appends /chat/completions exactly once. */
  private buildUrl(): string {
    const base = this.baseUrl.trim().replace(/\/+$/, '');
    if (base.endsWith('/chat/completions')) {
      return base;
    }
    return `${base}/chat/completions`;
  }

  private async send(
    url: string,
    key: string,
    entries: ProviderBatchEntry[],
    ctx: ProviderContext,
    opts: ProviderRequestOptions,
    includeResponseFormat: boolean,
  ): Promise<Response> {
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
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: combined.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new ProviderError('aborted', 'Request aborted');
      }
      if (combined.didTimeout() || isTimeoutError(err)) {
        throw new ProviderError('timeout', `Request timed out after ${opts.timeoutMs} ms.`);
      }
      throw new ProviderError('network', `Network error: ${safeErrorMessage(err, key)}`);
    }
  }

  private parseResults(entries: ProviderBatchEntry[], rawText: string): ProviderBatchResult[] {
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      this.logInvalid(rawText);
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
        this.logInvalid(content);
        throw new ProviderError('invalid-response', 'The API returned content that is not valid JSON.');
      }
    } else if (content !== undefined) {
      // Some providers return the content already parsed as an object.
      candidate = asRecord(content);
      if (!candidate) {
        this.logInvalid(rawText);
        throw new ProviderError('invalid-response', 'The API returned unexpected translation content.');
      }
    } else {
      // Lenient fallback: a bare `{ "translations": { ... } }` body without choices.
      candidate = root;
    }

    // Prefer an explicit "translations" wrapper; otherwise use the object itself.
    const translations = candidate ? asRecord(candidate.translations) ?? candidate : undefined;
    if (!translations) {
      this.logInvalid(rawText);
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
      const snippet = excerpt(rawText, MAX_INVALID_RESPONSE_EXCERPT);
      this.logger?.warn(`invalid response from ${this.id}: ${snippet}`);
      throw new ProviderError(
        'invalid-response',
        `The API response is missing translations for ids: ${missing.join(', ')}.${snippet ? ` Response: ${snippet}` : ''}`,
      );
    }
    return results;
  }

  /** Logs only a truncated snippet of an invalid response (never the key). */
  private logInvalid(source: string): void {
    this.logger?.warn(`invalid response from ${this.id}: ${excerpt(source, MAX_INVALID_RESPONSE_EXCERPT)}`);
  }
}
