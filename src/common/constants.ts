/** Extension-wide constants. Keep in sync with package.json contributions. */

export const EXTENSION_ID = 'brakerham.markdown-ai-translator';

export const CONFIG_SECTION = 'markdownAiTranslator';

/** SecretStorage key for the API key. The key itself is never persisted to settings.json. */
export const SECRET_API_KEY = 'markdownAiTranslator.apiKey';

export const PREVIEW_VIEW_TYPE = 'markdownAiTranslator.preview';
export const SIDEBAR_VIEW_TYPE = 'markdownAiTranslator.sidebarView';

export const COMMANDS = {
  translateDocument: 'markdownAiTranslator.translateDocument',
  retranslateDocument: 'markdownAiTranslator.retranslateDocument',
  translateSelection: 'markdownAiTranslator.translateSelection',
  setApiKey: 'markdownAiTranslator.setApiKey',
  clearApiKey: 'markdownAiTranslator.clearApiKey',
  openSettings: 'markdownAiTranslator.openSettings',
} as const;

export const CONFIG_KEYS = {
  apiBaseUrl: 'apiBaseUrl',
  model: 'model',
  sourceLanguage: 'sourceLanguage',
  targetLanguage: 'targetLanguage',
  systemPrompt: 'systemPrompt',
  temperature: 'temperature',
  translationMode: 'translationMode',
  requestTimeout: 'requestTimeout',
  maxConcurrency: 'maxConcurrency',
  maxTokensPerRequest: 'maxTokensPerRequest',
  maxRetries: 'maxRetries',
  cacheEnabled: 'cacheEnabled',
  cacheTtlDays: 'cacheTtlDays',
} as const;

export const DEFAULTS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  sourceLanguage: 'auto',
  targetLanguage: '简体中文',
  temperature: 0.3,
  translationMode: 'translated',
  requestTimeout: 60000,
  maxConcurrency: 3,
  maxTokensPerRequest: 4000,
  maxRetries: 2,
  cacheEnabled: true,
  cacheTtlDays: 30,
} as const;

/**
 * Default system prompt. MUST stay identical to the `markdownAiTranslator.systemPrompt`
 * default declared in package.json (there is a unit test enforcing this).
 */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are a professional technical documentation translator.',
  'Translate the given technical documentation text from {sourceLanguage} to {targetLanguage}.',
  '',
  'Requirements:',
  '1. Translate accurately and faithfully; never omit any information present in the source text.',
  '2. Never add explanations, comments, or content that is not in the source text.',
  '3. Preserve the technical semantics of the original text.',
  '4. Preserve technical terms, API names, function names, variable names, project names, and product names as-is.',
  '5. Preserve all Markdown inline markup exactly, including inline code spans, emphasis, and links.',
  '6. Never translate or alter inline code, URLs, file paths, HTML tags, math formulas, or code blocks.',
  '7. For important technical terms, you may keep the original English term in parentheses at first occurrence.',
  '8. Keep the tone professional and consistent with technical documentation conventions.',
].join('\n');

/** Maximum length accepted for a selection translation request. */
export const MAX_SELECTION_LENGTH = 8000;
