/**
 * Ambient declarations for markdown-it plugins that do not ship TypeScript types.
 */
declare module 'markdown-it-anchor' {
  import type MarkdownIt from 'markdown-it';
  const anchor: (md: ReturnType<typeof MarkdownIt>, options?: Record<string, unknown>) => void;
  export default anchor;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';
  const taskLists: (md: ReturnType<typeof MarkdownIt>, options?: Record<string, unknown>) => void;
  export default taskLists;
}

declare module 'markdown-it-front-matter' {
  import type MarkdownIt from 'markdown-it';
  const frontMatter: (md: ReturnType<typeof MarkdownIt>, options?: Record<string, unknown>) => void;
  export default frontMatter;
}

declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it';
  const texmath: (md: ReturnType<typeof MarkdownIt>, options?: Record<string, unknown>) => void;
  export default texmath;
}
