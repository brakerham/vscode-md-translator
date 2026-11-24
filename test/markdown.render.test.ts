import { describe, expect, it } from 'vitest';
import { MarkdownPipeline } from '../src/markdown/pipeline';

const pipeline = new MarkdownPipeline();

const hrefs = (html: string): string[] =>
  [...html.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
const imgSrcs = (html: string): string[] =>
  [...html.matchAll(/<img[^>]*src="([^"]*)"/g)].map((m) => m[1]);
const codeContents = (html: string): string[] =>
  [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((m) => m[1]);
const countOccurrences = (html: string, needle: string): number =>
  html.split(needle).length - 1;
const countTag = (html: string, tagOpen: string): number =>
  (html.match(new RegExp(tagOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;

describe('markdown rendering', () => {
  it('applies translations to the trans render and keeps src untouched on the same document', () => {
    const doc = pipeline.parse('# Hello\n\nWorld');
    const { segments } = doc.extractSegments();
    expect(segments.map((s) => s.id)).toEqual(['s0', 's1']);

    doc.applyTranslations(new Map([['s1', '译文']]));

    const trans = doc.render({ version: 'trans' });
    const src = doc.render({ version: 'src' });
    expect(trans).toContain('译文');
    expect(trans).toContain('Hello');
    expect(src).toContain('World');
    expect(src).not.toContain('译文');
  });

  it('translates image alt text without touching the src', () => {
    const doc = pipeline.parse('![alt text](img.png)');
    const { segments } = doc.extractSegments();
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('image_alt');

    doc.applyTranslations(new Map([[segments[0].id, '替代文本']]));

    const src = doc.render({ version: 'src' });
    const trans = doc.render({ version: 'trans' });
    expect(src).toContain('alt="alt text"');
    expect(trans).toContain('alt="替代文本"');
    expect(trans).toContain('src="img.png"');
  });

  it('protects structure: URLs, code and table shape are identical in src and trans', () => {
    const md = [
      '# [Linked Heading](https://example.com/head)',
      '',
      'Paragraph with [a link](https://example.com/a), `inline_code()`, and https://example.com/auto.',
      '',
      '```python',
      'print("code content")',
      '```',
      '',
      '| Col | Value |',
      '| --- | --- |',
      '| [row link](https://example.com/row) | `cell code` |',
      '',
      '![An image](img.png)',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    const { segments } = doc.extractSegments();
    const translations = new Map<string, string>();
    segments.forEach((s, i) => translations.set(s.id, `译${i}`));
    doc.applyTranslations(translations);

    const src = doc.render({ version: 'src' });
    const trans = doc.render({ version: 'trans' });

    expect(trans).toContain('译0'); // translations were applied
    expect(hrefs(trans)).toEqual(hrefs(src));
    expect(imgSrcs(trans)).toEqual(imgSrcs(src));
    expect(codeContents(trans)).toEqual(codeContents(src));
    expect(countOccurrences(trans, 'data-mdt-block')).toBe(countOccurrences(src, 'data-mdt-block'));
    expect(countTag(trans, '<th')).toBe(countTag(src, '<th'));
    expect(countTag(trans, '<td')).toBe(countTag(src, '<td'));
  });

  it('reports translatedBlocks and renders exactly one pairing marker per block', () => {
    const md = [
      '# One',
      '',
      'Para two',
      '',
      '## Three',
      '',
      '- first item',
      '',
      '- second item',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    const { blockCount } = doc.extractSegments();
    expect(blockCount).toBe(5);
    expect(doc.translatedBlocks).toEqual([0, 1, 2, 3, 4]);

    const src = doc.render({ version: 'src' });
    const trans = doc.render({ version: 'trans' });
    for (let i = 0; i < blockCount; i += 1) {
      const marker = `data-mdt-block="${i}"`;
      expect(countOccurrences(src, marker)).toBe(1);
      expect(countOccurrences(trans, marker)).toBe(1);
    }
  });

  it('sanitizes dangerous raw HTML', () => {
    const md = [
      'Before.',
      '',
      '<script>alert(1)</script>',
      '',
      '<img src="x.png" onerror="alert(2)">',
      '',
      'After <a href="javascript:alert(3)">link</a>.',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    doc.extractSegments();
    const html = doc.render({ version: 'src' });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('src="x.png"');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(2)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('link');
  });

  it('rewrites relative image srcs but leaves absolute, protocol-relative and data srcs alone', () => {
    const md = [
      '![markdown image](img.png)',
      '',
      '<img src="raw.png">',
      '',
      '![absolute](https://example.com/pic.png)',
      '',
      '![data](data:image/png;base64,AAAA)',
      '',
    ].join('\n');

    const doc = pipeline.parse(md);
    doc.extractSegments();
    const html = doc.render({ version: 'src', resolveImageSrc: (src) => `resolved/${src}` });

    expect(html).toContain('resolved/img.png');
    expect(html).toContain('resolved/raw.png');
    expect(html).toContain('https://example.com/pic.png');
    expect(html).not.toContain('resolved/https');
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toContain('resolved/data');
  });

  it('renders GFM tables, task list checkboxes and ordered list start attributes', () => {
    const md = [
      '| Name | Age |',
      '| --- | --- |',
      '| Alice | 30 |',
      '',
      '- [x] done',
      '',
      '3. third',
      '4. fourth',
    ].join('\n');

    const doc = pipeline.parse(md);
    doc.extractSegments();
    const html = doc.render({ version: 'src' });

    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('<ol start="3">');
  });

  it('renders deterministically (no token mutation across renders)', () => {
    const doc = pipeline.parse('# A\n\nB with [link](https://example.com) and `code`.');
    doc.extractSegments();
    doc.applyTranslations(new Map([['s1', '译文']]));

    const src1 = doc.render({ version: 'src' });
    const src2 = doc.render({ version: 'src' });
    const trans1 = doc.render({ version: 'trans' });
    const trans2 = doc.render({ version: 'trans' });

    expect(src1).toEqual(src2);
    expect(trans1).toEqual(trans2);
    expect(trans2).toContain('译文');
  });
});
