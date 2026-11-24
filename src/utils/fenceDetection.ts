/**
 * Detects whether a line of a Markdown document sits inside a fenced code
 * block (``` or ~~~). Heuristic used to warn before translating code.
 */
export function isInsideFencedCodeBlock(text: string, line: number): boolean {
  const lines = text.split(/\r?\n/);
  const limit = Math.min(line, lines.length - 1);
  let inside = false;
  let fenceChar = '';
  for (let i = 0; i <= limit; i++) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (!match) continue;
    const marker = match[1][0];
    if (!inside) {
      inside = true;
      fenceChar = marker;
    } else if (marker === fenceChar) {
      // Closing fence: the rest of the line must be empty or backticks only.
      const rest = lines[i].slice(match[0].length).trim();
      if (!rest || /^`*$/.test(rest)) {
        inside = false;
        fenceChar = '';
      }
    }
  }
  return inside;
}
