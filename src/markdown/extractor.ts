/**
 * Token-tree extraction for the Markdown AI Translator.
 *
 * Walks the token tree produced by `md.parse` and collects every translatable
 * text run. The markdown-it (v13) tree layout this walker relies on:
 *
 * - Block open/close tokens (`paragraph_open`, `heading_open`, `th_open`,
 *   `td_open`, ...) are entries of the top-level Token[] array, interleaved
 *   with self-contained `inline` tokens that hold the block's text.
 * - Table cells are the exception: their `inline` tokens are attached as
 *   `children` of the `th_open` / `td_open` token instead of being top-level
 *   siblings.
 * - `inline.children` is flat: `link_open` ... `link_close` delimit link
 *   text, `image` tokens are self-contained, and everything else (code,
 *   math, raw HTML, soft breaks) is not translatable.
 */

import type Token from 'markdown-it/lib/token';
import type { SegmentKind } from '../common/types';
import type { ExtractResult, Segment } from './pipeline';

/** Block openers that carry the sequential `data-mdt-block` marker. */
const MARKED_BLOCK_TYPES = new Set(['paragraph_open', 'heading_open', 'th_open', 'td_open']);

/** Deletes previously applied translation state from every token in the tree. */
export function clearTranslationState(tokens: Token[]): void {
  const visit = (token: Token): void => {
    if (token.meta !== null && typeof token.meta === 'object') {
      delete token.meta.translation;
      delete token.meta.altTranslation;
    }
    if (token.children !== null) {
      for (const child of token.children) {
        visit(child);
      }
    }
  };
  for (const token of tokens) {
    visit(token);
  }
}

/**
 * Assigns a sequential 0-based `data-mdt-block` marker to EVERY paragraph,
 * heading and table cell opener (even those without translatable content) so
 * source and translated renders always carry identical marker sets.
 * Returns the number of marked blocks.
 */
export function assignBlockMarkers(tokens: Token[]): number {
  let index = 0;
  for (const token of tokens) {
    if (MARKED_BLOCK_TYPES.has(token.type)) {
      token.attrSet('data-mdt-block', String(index));
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
function walkInline(
  inline: Token,
  blockStack: Token[],
  emit: (text: string, kind: SegmentKind, token: Token, attr: 'alt' | undefined, blockIndex: number) => void,
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
  let linkDepth = 0;
  for (const token of children) {
    switch (token.type) {
      case 'link_open':
        linkDepth += 1;
        break;
      case 'link_close':
        if (linkDepth > 0) {
          linkDepth -= 1;
        }
        break;
      case 'text':
        if (token.content.trim().length > 0) {
          emit(token.content, linkDepth > 0 ? 'link_text' : kind, token, undefined, blockIndex);
        }
        break;
      case 'image': {
        // markdown-it 13 keeps the alt text in the token children (the alt
        // attribute is empty); token.content carries the concatenated text.
        const attrAlt = token.attrGet('alt') ?? '';
        const alt = attrAlt.trim().length > 0 ? attrAlt : (token.content ?? '');
        if (alt.trim().length > 0) {
          emit(alt, 'image_alt', token, 'alt', blockIndex);
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
 * Idempotent segment extraction: clears previous translation state, assigns
 * block markers and collects every translatable segment in document order.
 */
export function extractSegments(tokens: Token[]): ExtractResult {
  clearTranslationState(tokens);
  const blockCount = assignBlockMarkers(tokens);

  const segments: Segment[] = [];
  const translatedBlocks = new Set<number>();
  let counter = 0;
  const stack: Token[] = [];

  const emit = (
    text: string,
    kind: SegmentKind,
    token: Token,
    attr: 'alt' | undefined,
    blockIndex: number,
  ): void => {
    segments.push({ id: `s${counter}`, kind, text, blockIndex, token, attr });
    counter += 1;
    translatedBlocks.add(blockIndex);
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
