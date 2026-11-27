/**
 * Reads extension configuration from VS Code settings and manages the API
 * key via SecretStorage. The API key is never persisted to settings.json and
 * never sent to webviews.
 */
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { completionEndpoint } from '../translation/openaiProvider';
import { CONFIG_KEYS, CONFIG_SECTION, DEFAULTS, DEFAULT_SYSTEM_PROMPT, SECRET_API_KEY } from '../common/constants';
import type { TranslationMode } from '../common/types';
import type { TranslationCache, TranslateOptions } from '../translation/types';

export interface AppConfig {
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  systemPrompt: string;
  temperature: number;
  translationMode: TranslationMode;
  requestTimeout: number;
  maxConcurrency: number;
  maxTokensPerRequest: number;
  maxRetries: number;
  cacheEnabled: boolean;
  cacheTtlDays: number;
}

export interface TranslateOptionsExtra {
  cache?: TranslationCache;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const MODES: readonly TranslationMode[] = ['source', 'translated', 'bilingual'];

function normalizeMode(value: unknown): TranslationMode {
  return MODES.includes(value as TranslationMode) ? (value as TranslationMode) : (DEFAULTS.translationMode as TranslationMode);
}

export class ConfigProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<AppConfig>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly onDidChangeSecretsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSecrets = this.onDidChangeSecretsEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          this.onDidChangeEmitter.fire(this.read());
        }
      }),
        this.secrets.onDidChange(() => this.onDidChangeSecretsEmitter.fire()),
    );
  }

  /** Reads the current configuration (always live). */
  read(): AppConfig {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      apiBaseUrl: cfg.get<string>(CONFIG_KEYS.apiBaseUrl) || DEFAULTS.apiBaseUrl,
      model: cfg.get<string>(CONFIG_KEYS.model) || DEFAULTS.model,
      sourceLanguage: cfg.get<string>(CONFIG_KEYS.sourceLanguage) || DEFAULTS.sourceLanguage,
      targetLanguage: cfg.get<string>(CONFIG_KEYS.targetLanguage) || DEFAULTS.targetLanguage,
      systemPrompt: cfg.get<string>(CONFIG_KEYS.systemPrompt) ?? DEFAULT_SYSTEM_PROMPT,
      temperature: cfg.get<number>(CONFIG_KEYS.temperature) ?? DEFAULTS.temperature,
      translationMode: normalizeMode(cfg.get<string>(CONFIG_KEYS.translationMode)),
      requestTimeout: cfg.get<number>(CONFIG_KEYS.requestTimeout) ?? DEFAULTS.requestTimeout,
      maxConcurrency: cfg.get<number>(CONFIG_KEYS.maxConcurrency) ?? DEFAULTS.maxConcurrency,
      maxTokensPerRequest: cfg.get<number>(CONFIG_KEYS.maxTokensPerRequest) ?? DEFAULTS.maxTokensPerRequest,
      maxRetries: cfg.get<number>(CONFIG_KEYS.maxRetries) ?? DEFAULTS.maxRetries,
      cacheEnabled: cfg.get<boolean>(CONFIG_KEYS.cacheEnabled) ?? DEFAULTS.cacheEnabled,
      cacheTtlDays: cfg.get<number>(CONFIG_KEYS.cacheTtlDays) ?? DEFAULTS.cacheTtlDays,
    };
  }

  /** Maps an AppConfig to translation service options. */
  toTranslateOptions(config: AppConfig, extra: TranslateOptionsExtra = {}): TranslateOptions {
    return {
      apiBaseUrl: config.apiBaseUrl,
      systemPrompt: config.systemPrompt,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      model: config.model,
      temperature: config.temperature,
      timeoutMs: config.requestTimeout,
      maxConcurrency: config.maxConcurrency,
      maxTokensPerRequest: config.maxTokensPerRequest,
      retries: config.maxRetries,
      cache: config.cacheEnabled ? extra.cache : undefined,
      forceRefresh: extra.forceRefresh,
      signal: extra.signal,
      onProgress: extra.onProgress,
    };
  }

  private apiKeyName(endpoint: string): string {
    return `${SECRET_API_KEY}.${createHash('sha256').update(endpoint).digest('hex')}`;
  }

  async getApiKey(endpoint?: string): Promise<string | undefined> {
    return this.secrets.get(this.apiKeyName(endpoint ?? completionEndpoint(this.read().apiBaseUrl)));
  }

  async hasApiKey(): Promise<boolean> {
    try {
      return Boolean(await this.getApiKey());
    } catch {
      return false;
    }
  }

  async setApiKey(key: string, endpoint: string): Promise<void> {
    await this.secrets.store(this.apiKeyName(endpoint), key.trim());
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(this.apiKeyName(completionEndpoint(this.read().apiBaseUrl)));
    await this.secrets.delete(SECRET_API_KEY);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.onDidChangeEmitter.dispose();
    this.onDidChangeSecretsEmitter.dispose();
  }
}
