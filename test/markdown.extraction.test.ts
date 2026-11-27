import { describe, expect, it } from 'vitest';
import { MarkdownPipeline } from '../src/markdown/pipeline';

const pipeline = new MarkdownPipeline();

describe('markdown extraction', () => {
  it('extracts headings, paragraphs, list items, blockquotes and table cells with sequential ids', () => {
    const md = [
      '# Heading One',
      '',
      'First paragraph.',
      '',
      'Second paragraph with **bold** text.',
      '',
      '- Item A',
      '  - Nested B',
      '',
      '> Quoted paragraph',
      '',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| Cell 1 | Cell 2 |',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    const { segments, blockCount } = doc.extractSegments();

    expect(segments.map((s) => s.id)).toEqual([
      's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11',
    ]);
    expect(segments.map((s) => s.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'list_item',
      'list_item',
      'blockquote',
      'table_cell',
      'table_cell',
      'table_cell',
      'table_cell',
    ]);
    expect(segments.map((s) => s.blockIndex)).toEqual([0, 1, 2, 2, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(blockCount).toBe(10);
    expect(doc.blockCount).toBe(10);
    expect(doc.translatedBlocks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Block indexes follow document order.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].blockIndex).toBeGreaterThanOrEqual(segments[i - 1].blockIndex);
    }

    expect(segments.find((s) => s.text === 'Heading One')?.kind).toBe('heading');
    expect(segments.find((s) => s.text === 'Nested B')?.kind).toBe('list_item');
    expect(segments.find((s) => s.text === 'Quoted paragraph')?.kind).toBe('blockquote');
    expect(segments.find((s) => s.text === 'Cell 2')?.kind).toBe('table_cell');
    expect(segments.find((s) => s.text === 'Cell 2')?.blockIndex).toBe(9);
  });

  it('never segments code: fenced blocks, their info strings or inline code', () => {
    const md = [
      '# Title',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      'Use `code` here.',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    const { segments } = doc.extractSegments();

    expect(segments.map((s) => s.text)).toEqual(['Title', 'Use', 'here.']);
    const allText = segments.map((s) => s.text).join('|');
    expect(allText).not.toContain('print');
    expect(allText).not.toContain('python');
    expect(allText).not.toContain('mermaid');
    expect(allText).not.toContain('graph TD');
    expect(allText).not.toContain('code');

    // The fence info strings survive into the rendered HTML.
    const html = doc.render({ version: 'src' });
    expect(html).toContain('language-python');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('print');
  });

  it('segments link display text as link_text and image alt as image_alt, never the URLs', () => {
    const md = 'A [display text](https://example.com/x) and ![alt text](img.png).';
    const doc = pipeline.parse(md);
    const { segments } = doc.extractSegments();

    const linkText = segments.find((s) => s.text === 'display text');
    expect(linkText?.kind).toBe('link_text');
    expect(linkText?.attr).toBeUndefined();

    const imageAlt = segments.find((s) => s.text === 'alt text');
    expect(imageAlt?.kind).toBe('image_alt');
    expect(imageAlt?.attr).toBe('alt');

    const allText = segments.map((s) => s.text).join('|');
    expect(allText).not.toContain('example.com');
    expect(allText).not.toContain('img.png');
  });

  it('produces no segments from front matter', () => {
    const doc = pipeline.parse('---\ntitle: hello\n---\n\n# Real Heading');
    const { segments } = doc.extractSegments();

    expect(segments.map((s) => s.text)).toEqual(['Real Heading']);

    // Front matter alone: no segments, no heading HTML, escaped content.
    const fmDoc = pipeline.parse('---\ntitle: "hello <world>"\n---\n');
    expect(fmDoc.extractSegments().segments).toEqual([]);
    const html = fmDoc.render({ version: 'src' });
    expect(html).toContain('mdt-frontmatter');
    expect(html).toContain('&lt;world&gt;');
    expect(html).not.toContain('<h1');
  });

  it('produces no segments from math but still renders it (src and trans identical)', () => {
    const md = '$x^2$\n\n$$\ny^2\n$$';
    const doc = pipeline.parse(md);
    const { segments } = doc.extractSegments();

    expect(segments).toEqual([]);

    const src = doc.render({ version: 'src' });
    const trans = doc.render({ version: 'trans' });
    expect(src).toEqual(trans);
    expect(src).toContain('katex');
  });

  it('produces no segments from raw HTML blocks', () => {
    const md = '<div>Hello</div>\n\n<img src="x.png">';
    const doc = pipeline.parse(md);
    const { segments, blockCount } = doc.extractSegments();

    expect(segments).toEqual([]);
    expect(blockCount).toBe(0);
  });

  it('skips whitespace-only text runs', () => {
    const doc = pipeline.parse('**a**  **b**');
    const { segments } = doc.extractSegments();
    expect(segments.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('re-running extractSegments resets applied translations and is idempotent', () => {
    const doc = pipeline.parse('Hello world');
    const first = doc.extractSegments();
    expect(first.segments.map((s) => s.id)).toEqual(['s0']);

    doc.applyTranslations(new Map([['s0', '你好世界']]));
    expect(doc.render({ version: 'trans' })).toContain('你好世界');
    expect(doc.render({ version: 'trans' })).not.toContain('Hello world');

    // A fresh extraction clears the translation state on the tokens.
    const second = doc.extractSegments();
    expect(second.segments.map((s) => ({ ...s, token: undefined }))).toEqual(
      first.segments.map((s) => ({ ...s, token: undefined })),
    );
    expect(doc.render({ version: 'trans' })).toContain('Hello world');
    expect(doc.render({ version: 'trans' })).not.toContain('你好世界');
  });
});
