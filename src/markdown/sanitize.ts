/**
 * Sanitization of rendered HTML for the Markdown AI Translator.
 *
 * The allowlists are deliberately permissive enough to keep the output of the
 * markdown-it plugins in use (anchor heading ids, task-list checkboxes, KaTeX
 * spans with class/style/aria-hidden) while still removing scripts, event
 * handler attributes and dangerous URL schemes.
 */
import sanitizeHtml from 'sanitize-html';
import type { Logger } from '../common/types';

/** Image srcs matching these schemes are considered already resolved and are left untouched. */
const ABSOLUTE_SRC_RE = /^(https?:|data:|file:|#|\/\/|mailto:)/i;

const ALLOWED_TAGS = [
  'a',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'del',
  's',
  'sup',
  'sub',
  'kbd',
  'mark',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
  'input',
  'span',
  'div',
  'section',
  'details',
  'summary',
  'figure',
  'figcaption',
  'small',
  'b',
  'i',
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  h1: ['id', 'data-mdt-block'],
  h2: ['id', 'data-mdt-block'],
  h3: ['id', 'data-mdt-block'],
  h4: ['id', 'data-mdt-block'],
  h5: ['id', 'data-mdt-block'],
  h6: ['id', 'data-mdt-block'],
  p: ['data-mdt-block', 'align'],
  th: ['data-mdt-block', 'align'],
  td: ['data-mdt-block', 'align'],
  code: ['class'],
  span: ['class', 'style', 'aria-hidden'],
  div: ['class', 'style'],
  section: ['class', 'style'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start'],
  details: ['open'],
};

/**
 * Sanitizes rendered HTML and rewrites relative image srcs (both Markdown
 * images and raw HTML <img> tags). Deterministic: the transformation only
 * touches the per-call attribute maps produced by the sanitizer's parser and
 * never mutates the markdown-it token tree.
 */
export function sanitizeRenderedHtml(
  html: string,
  resolveImageSrc: ((src: string) => string) | undefined,
  logger: Logger | undefined,
): string {
  const options: sanitizeHtml.IOptions = {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: ALLOWED_ATTRIBUTES,
    disallowedTagsMode: 'discard',
    // sanitize-html strips data: URIs by default; base64-embedded images are
    // legitimate document content and must survive sanitization.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowProtocolRelative: false,
    allowedStyles: {
      span: {
        'height': [/^-?[\d.]+em$/],
        'width': [/^-?[\d.]+em$/],
        'min-width': [/^-?[\d.]+em$/],
        'top': [/^-?[\d.]+em$/],
        'vertical-align': [/^-?[\d.]+em$/],
        'margin-left': [/^-?[\d.]+em$/],
        'margin-right': [/^-?[\d.]+em$/],
        'border-bottom-width': [/^[\d.]+em$/],
        'color': [/^#[a-f\d]{3,8}$/i, /^[a-z]+$/i],
      },
    },
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src;
        if (src && /^data:/i.test(src) && !/^data:image\/(?:png|gif|jpe?g|webp|avif);base64,[\da-z+/=]+$/i.test(src)) {
          delete attribs.src;
          return { tagName, attribs };
        }
        if (src !== undefined && !ABSOLUTE_SRC_RE.test(src) && resolveImageSrc !== undefined) {
          try {
            const resolved = resolveImageSrc(src);
            // Fall back to the original src when the resolver returns nothing usable.
            if (resolved !== undefined && resolved !== null && resolved !== '') {
              attribs.src = resolved;
            }
          } catch (error) {
            // A failing resolver must never break rendering; keep the original src.
            logger?.warn(`resolveImageSrc failed for "${src}": ${String(error)}`);
          }
        }
        return { tagName, attribs };
      },
    },
  };
  return sanitizeHtml(html, options);
}
