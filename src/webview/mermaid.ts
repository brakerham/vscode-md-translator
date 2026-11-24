/**
 * Mermaid bundle entry.
 *
 * This tiny module is bundled separately by esbuild (see esbuild.mjs) and is
 * loaded lazily by the preview webview (src/webview/main.ts) only when a
 * Mermaid code block actually needs to be rendered. It does nothing except
 * make the bundled library available as a global for main.ts.
 */
import mermaid from 'mermaid';

// `window` is an unavoidable browser global here; the double cast is the
// documented way to attach the library without using `any` and without
// extending the global Window interface.
(window as unknown as { mermaid?: unknown }).mermaid = mermaid;
