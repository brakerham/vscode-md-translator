/**
 * Markdown pipeline for the Markdown AI Translator: markdown-it setup,
 * segment extraction, translation application and sanitized rendering.
 *
 * One markdown-it instance is created per MarkdownPipeline and reused for
 * every parse; tokens are fresh per parse and the registered renderer rules
 * are stateless, so sharing the instance is safe. Tokens are shared between
 * the source and translated renders of a document (translations are written
 * back onto the tokens), so the token structure can never diverge.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import frontMatter from 'markdown-it-front-matter';
import katexPlugin from 'markdown-it-katex';
import type { Logger, SegmentKind } from '../common/types';
import { extractSegments } from './extractor';
import { sanitizeRenderedHtml } from './sanitize';

/**
 * One translatable text run. Translation results are applied by writing the
 * translation back onto the referenced token (meta.translation for text
 * tokens, meta.altTranslation for image alt text).
 */
export interface Segment {
  /** Stable unique id within one extraction run, e.g. "s1", "s2", ... */
  id: string;
  kind: SegmentKind;
  text: string;
  /** Zero-based index of the containing block (paragraph / heading / table cell). */
  blockIndex: number;
  /** Token the translation is attached to. */
  token: Token;
  /** When set, the translation targets this attribute of the token (image alt). */
  attr?: 'alt';
}

export interface ExtractResult {
  segments: Segment[];
  /** Number of translatable block containers in the document. */
  blockCount: number;
}

export interface RenderOptions {
  /** Which version of the text to render. */
  version: 'src' | 'trans';
  /**
   * Rewrites image sources (Markdown images and raw HTML <img> tags).
   * Called for every image src; return the resolved src or the original value.
   */
  resolveImageSrc?: (src: string) => string;
}

/** Environment handed to the renderer rules; selects src vs translated text. */
interface RenderEnv {
  renderVersion: 'src' | 'trans';
}

export class MarkdownDocument {
  private readonly md: MarkdownIt;
  private readonly tokens: Token[];
  private readonly logger?: Logger;

  /** Segments of the last extractSegments() run. */
  private segments: Segment[] = [];
  /** Block indexes that received at least one segment (last extraction run). */
  private translatedBlockIndexes: number[] = [];
  /** Number of marked blocks (last extraction run). */
  private markedBlockCount = 0;

  constructor(md: MarkdownIt, tokens: Token[], logger?: Logger) {
    this.md = md;
    this.tokens = tokens;
    this.logger = logger;
  }

  /**
   * Walks the token tree and collects translatable segments. Idempotent:
   * every call clears previously applied translation state first, so a fresh
   * extraction starts clean.
   */
  extractSegments(): ExtractResult {
    const result = extractSegments(this.tokens);
    this.segments = result.segments;
    this.markedBlockCount = result.blockCount;
    this.translatedBlockIndexes = Array.from(new Set(result.segments.map((s) => s.blockIndex))).sort(
      (a, b) => a - b,
    );
    return result;
  }

  /**
   * Applies translated text back onto the tokens. Empty translations are
   * ignored (the renderer then falls back to the source text) and unknown
   * ids are skipped. Tokens are shared between renders, so the structure of
   * the source and translated renders can never diverge.
   */
  applyTranslations(translations: ReadonlyMap<string, string>): void {
    for (const segment of this.segments) {
      const value = translations.get(segment.id);
      if (value === undefined || value.length === 0) {
        continue;
      }
      const meta = (segment.token.meta ??= {});
      if (segment.attr === 'alt') {
        meta.altTranslation = value;
      } else {
        meta.translation = value;
      }
    }
  }

  /** Renders sanitized HTML (source or translated version). */
  render(options: RenderOptions): string {
    const env: RenderEnv = { renderVersion: options.version };
    const html = this.md.renderer.render(this.tokens, this.md.options, env);
    return sanitizeRenderedHtml(html, options.resolveImageSrc, this.logger);
  }

  /** Block indexes that contain at least one translatable segment. */
  get translatedBlocks(): number[] {
    return [...this.translatedBlockIndexes];
  }

  /** Number of marked block containers (requires an extraction run first). */
  get blockCount(): number {
    return this.markedBlockCount;
  }
}

export class MarkdownPipeline {
  private readonly md: MarkdownIt;
  private readonly logger?: Logger;

  constructor(options?: { logger?: Logger }) {
    this.logger = options?.logger;
    this.md = this.createMarkdownIt();
  }

  /** Parses markdown text into a reusable document object. */
  parse(text: string): MarkdownDocument {
    const tokens = this.md.parse(text, {});
    return new MarkdownDocument(this.md, tokens, this.logger);
  }

  /** Builds the single shared markdown-it instance with all plugins and rules. */
  private createMarkdownIt(): MarkdownIt {
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: false,
      breaks: false,
    });
    md.use(anchor, { permalink: false, tabIndex: false });
    md.use(taskLists);
    // markdown-it-front-matter requires a callback option (it receives the
    // parsed YAML); pass a no-op so the plugin never crashes.
    md.use(frontMatter, () => undefined);
    md.use(katexPlugin, { throwOnError: false });
    this.registerRendererRules(md);
    return md;
  }

  /** Registers the custom renderer rules used by MarkdownDocument.render. */
  private registerRendererRules(md: MarkdownIt): void {
    const escapeHtml = md.utils.escapeHtml;

    // Text: swap in the translation when rendering the translated version.
    md.renderer.rules.text = (tokens, idx, _options, env) => {
      const token = tokens[idx];
      const content =
        env.renderVersion === 'trans' &&
        typeof token.meta?.translation === 'string' &&
        token.meta.translation.length > 0
          ? token.meta.translation
          : token.content;
      return escapeHtml(content);
    };

    // Image: hand-rolled <img> so the alt attribute can be swapped without
    // mutating the token (the default rule writes the rendered alt back into
    // the token's attributes, which would leak into later renders).
    // markdown-it 13 keeps the alt text in the token children (attrs alt is
    // empty); token.content carries the concatenated alt text.
    md.renderer.rules.image = (tokens, idx, _options, env) => {
      const token = tokens[idx];
      const attrAlt = token.attrGet('alt') ?? '';
      const fallbackAlt = token.content ?? '';
      const sourceAlt = attrAlt.trim().length > 0 ? attrAlt : fallbackAlt;
      const alt =
        env.renderVersion === 'trans' && typeof token.meta?.altTranslation === 'string'
          ? token.meta.altTranslation
          : sourceAlt;
      const src = token.attrGet('src') ?? '';
      const title = token.attrGet('title');
      const titlePart = title === null ? '' : ` title="${escapeHtml(title)}"`;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${titlePart}>`;
    };

    // Front matter: render the raw YAML escaped inside a marked <div>; it is
    // never translatable. markdown-it-front-matter stores the YAML directly
    // on token.meta and requires a callback option to be passed to use().
    md.renderer.rules.front_matter = (tokens, idx) => {
      const token = tokens[idx];
      const content = typeof token.meta === 'string' && token.meta.length > 0 ? token.meta : token.content;
      return `<div class="mdt-frontmatter">${escapeHtml(content)}</div>`;
    };
  }
}
