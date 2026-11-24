import { describe, expect, it } from 'vitest';
import { isInsideFencedCodeBlock } from '../src/utils/fenceDetection';

const DOC = [
  '# Title',
  '',
  'Outside text.',
  '',
  '```python',
  'print("inside")',
  '```',
  '',
  'After fence.',
  '',
  '~~~js',
  'const a = 1;',
  '~~~',
].join('\n');

describe('isInsideFencedCodeBlock', () => {
  it('returns false outside fences', () => {
    expect(isInsideFencedCodeBlock(DOC, 0)).toBe(false);
    expect(isInsideFencedCodeBlock(DOC, 2)).toBe(false);
    expect(isInsideFencedCodeBlock(DOC, 8)).toBe(false);
  });

  it('returns true inside a backtick fence', () => {
    expect(isInsideFencedCodeBlock(DOC, 5)).toBe(true);
  });

  it('returns true inside a tilde fence', () => {
    expect(isInsideFencedCodeBlock(DOC, 11)).toBe(true);
  });

  it('returns false on and after the closing fence', () => {
    expect(isInsideFencedCodeBlock(DOC, 6)).toBe(false);
    expect(isInsideFencedCodeBlock(DOC, 12)).toBe(false);
  });

  it('handles fences with long markers', () => {
    const text = ['````md', 'x', '````'].join('\n');
    expect(isInsideFencedCodeBlock(text, 1)).toBe(true);
    expect(isInsideFencedCodeBlock(text, 2)).toBe(false);
  });
});
