/**
 * Ambient declarations for markdown-it plugins that do not ship TypeScript types.
 */
declare module 'markdown-it-anchor' {
  import type MarkdownIt from 'markdown-it';
  const anchor: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default anchor;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const taskLists: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default taskLists;
}

declare module 'markdown-it-front-matter' {
  import type MarkdownIt from 'markdown-it';
  const frontMatter: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default frontMatter;
}

declare module 'markdown-it-katex' {
  import type MarkdownIt from 'markdown-it';
  const katexPlugin: (md: MarkdownIt, options?: Record<string, unknown>) => void;
  export default katexPlugin;
}
