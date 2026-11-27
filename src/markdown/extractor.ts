/**
 * Token-tree extraction for the Markdown AI Translator.
 *
 * Walks the markdown-it token tree. Blocks normally have flat open/close
 * tokens with a separate inline token. Inline children carry the text and
 * delimiters for links, images, code and other markup.
 */

import type { Token } from 'markdown-it';
import type { SegmentKind } from '../common/types';
import type { ExtractResult, Segment } from './pipeline';

/** Block openers that carry the sequential `data-mdt-block` marker. */
const MARKED_BLOCK_TYPES = new Set(['paragraph_open', 'heading_open', 'th_open', 'td_open']);

/**
 * Assigns a sequential 0-based `data-mdt-block` marker to EVERY paragraph,
 * heading and table cell opener (even those without translatable content) so
 * source and translated renders always carry identical marker sets.
 * Returns the number of marked blocks.
 */
export function assignBlockMarkers(tokens: Token[]): number {
  let index = 0;
  for (const token of tokens) {
    if (token.type === 'paragraph_close' && token.hidden) token.hidden = false;
    if (MARKED_BLOCK_TYPES.has(token.type)) {
      token.attrSet('data-mdt-block', String(index));
      // Tight list paragraphs are hidden by markdown-it; keep a marker for pairing.
      if (token.type === 'paragraph_open' && token.hidden) token.hidden = false;
      index += 1;
    }
  }
  return index;
}

/**
 * Derives the segment kind of an inline token from the stack of open block
 * tokens. Priority follows the spec: heading (top), table cell, list item,
 * blockquote, paragraph.
 */
function blockKind(stack: Token[]): SegmentKind {
  const top = stack[stack.length - 1];
  if (top !== undefined && top.type === 'heading_open') {
    return 'heading';
  }
  // Table cells only ever hold inline content, so an open cell is the top of
  // its own table region; scan from the top to stay inside the region.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const type = stack[i].type;
    if (type === 'th_open' || type === 'td_open') {
      return 'table_cell';
    }
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].type === 'list_item_open') {
      return 'list_item';
    }
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].type === 'blockquote_open') {
      return 'blockquote';
    }
  }
  return 'paragraph';
}

/** Index of the nearest enclosing marked block, read from the marker attribute. */
function nearestBlockIndex(stack: Token[]): number | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const token = stack[i];
    if (!MARKED_BLOCK_TYPES.has(token.type)) {
      continue;
    }
    const value = token.attrGet('data-mdt-block');
    if (value !== null) {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return null;
}

/** Collects the translatable segments from one `inline` token. */
// Recognize common standalone relative/absolute paths and drive paths in prose.
const PROTECTED_TEXT = /(?:https?:\/\/|www\.)[^\s<>]+|\b[A-Za-z]:[\\/][^\s<>]+|(?:^|(?<=[\s("'=]))(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[\w@.-]+[\\/])[\w@./\\-]+|\b[\w-]+\.(?:md|mdx|json|ya?ml|toml|ts|tsx|js|jsx|py|rs|html|css|txt|png|gif|svg)\b/gi;

type Emit = (text: string, kind: SegmentKind, token: Token, attr: 'alt' | undefined,
  blockIndex: number, start: number, end: number) => void;

function emitProse(text: string, emit: (start: number, end: number) => void): void {
  const slice = (start: number, end: number): void => {
    const prose = text.slice(start, end);
    if (!/\p{L}/u.test(prose)) return;
    emit(start + (prose.length - prose.trimStart().length), end - (prose.length - prose.trimEnd().length));
  };
  let offset = 0;
  for (const match of text.matchAll(PROTECTED_TEXT)) {
    slice(offset, match.index);
    offset = match.index + match[0].length;
  }
  slice(offset, text.length);
}

function walkInline(
  inline: Token,
  blockStack: Token[],
  emit: Emit,
): void {
  const children = inline.children;
  if (children === null) {
    return;
  }
  const blockIndex = nearestBlockIndex(blockStack);
  if (blockIndex === null) {
    // In practice every inline token lives inside a marked block; bail out
    // defensively rather than producing segments without a pairing marker.
    return;
  }
  const kind = blockKind(blockStack);
  // Links cannot nest in CommonMark, so a depth counter is the small inline
  // stack needed to detect link context.
  let link: 'plain' | 'label' | 'auto' = 'plain';
  for (const token of children) {
    switch (token.type) {
      case 'link_open':
        link = token.markup === 'linkify' || token.markup === 'autolink' ? 'auto' : 'label';
        break;
      case 'link_close':
        link = 'plain';
        break;
      case 'text':
        if (link !== 'auto') {
          emitProse(token.content, (start, end) => {
            emit(token.content.slice(start, end), link === 'label' ? 'link_text' : kind, token, undefined, blockIndex, start, end);
          });
        }
        break;
      case 'image': {
        // markdown-it 13 keeps the alt text in the token children (the alt
        // attribute is empty); token.content carries the concatenated text.
        const attrAlt = String(token.attrGet('alt') ?? '');
        const alt = attrAlt.trim().length > 0 ? attrAlt : (token.content ?? '');
        if (!token.children?.some((child) => child.type === 'code_inline' || child.type.startsWith('math_'))) {
          emitProse(alt, (start, end) => emit(alt.slice(start, end), 'image_alt', token, 'alt', blockIndex, start, end));
        }
        break;
      }
      // Everything else (code_inline, math_inline, html_inline, softbreak,
      // hardbreak, emphasis markers, the task-list checkbox input, ...) is
      // intentionally not translatable.
      default:
        break;
    }
  }
}

/**
 * Assigns block markers and collects translatable segments in document order.
 */
export function extractSegments(tokens: Token[]): ExtractResult {
  const blockCount = assignBlockMarkers(tokens);

  const segments: Segment[] = [];
  let counter = 0;
  const stack: Token[] = [];

  const emit = (
    text: string,
    kind: SegmentKind,
    token: Token,
    attr: 'alt' | undefined,
    blockIndex: number,
    start: number,
    end: number,
  ): void => {
    segments.push({ id: `s${counter}`, kind, text, blockIndex, token, attr, start, end });
    counter += 1;
  };

  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push(token);
      // Table cells store their inline content in children rather than as
      // top-level siblings, so process it while the cell opener is on top.
      if (token.children !== null) {
        for (const child of token.children) {
          if (child.type === 'inline') {
            walkInline(child, stack, emit);
          }
        }
      }
    } else if (token.nesting === -1) {
      stack.pop();
    } else if (token.type === 'inline') {
      walkInline(token, stack, emit);
    }
  }

  return { segments, blockCount };
}
