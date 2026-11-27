/**
 * Prompt construction, token estimation and cache key computation.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_SYSTEM_PROMPT } from '../common/constants';
import type { ProviderBatchEntry, ProviderContext } from './types';

export { DEFAULT_SYSTEM_PROMPT };

/** Replaces {sourceLanguage} / {targetLanguage} placeholders in the system prompt. */
export function substituteLanguages(
  systemPrompt: string,
  sourceLanguage: string,
  targetLanguage: string,
): string {
  const source =
    sourceLanguage && sourceLanguage.trim().toLowerCase() !== 'auto'
      ? sourceLanguage
      : 'the source language (auto-detect)';
  const target = targetLanguage && targetLanguage.trim() ? targetLanguage : 'the target language';
  return systemPrompt
    .replaceAll('{sourceLanguage}', source)
    .replaceAll('{targetLanguage}', target);
}

/** Builds the user message carrying the structured segment batch. */
export function buildUserPrompt(entries: ProviderBatchEntry[], ctx: ProviderContext): string {
  const source =
    ctx.sourceLanguage && ctx.sourceLanguage.trim().toLowerCase() !== 'auto'
      ? ctx.sourceLanguage
      : 'the detected source language';
  const lines = [
    `Translate each segment from "${source}" to "${ctx.targetLanguage}".`,
    '',
    'The segments are given as JSON objects with an "id" and a "text" field.',
    'Return ONLY a single JSON object of the form:',
    '{"translations": {"<id>": "<translated text>"}}',
    '',
    'Rules:',
    '- Translate only the "text" values; every "id" must be returned unchanged and every "id" must be present in the response.',
    '- The text may contain Markdown inline markup; keep inline code spans, emphasis and links intact.',
    '- Never translate or alter: inline code, URLs, file paths, HTML tags, math formulas.',
    '- Translate naturally and concisely; do not add explanations.',
    '',
    'Segments:',
    JSON.stringify(entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text }))),
  ];
  return lines.join('\n');
}

/**
 * Rough token estimate: CJK characters count as ~1 token, other characters
 * ~4 per token. Used only for chunk sizing, not billing.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    }
  }
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + other / 4);
}

/** Cache key covering the text, model, languages and system prompt. */
export function cacheKeyFor(
  text: string,
  ctx: ProviderContext,
  kind: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'markdown-translation-v2', ctx.apiBaseUrl, ctx.model, ctx.sourceLanguage,
      ctx.targetLanguage, ctx.systemPrompt, ctx.temperature, kind, text,
    ]), 'utf8')
    .digest('hex');
}
