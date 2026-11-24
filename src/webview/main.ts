/**
 * Preview webview entry point for the Markdown AI Translator extension.
 *
 * This script runs inside the VS Code preview webview and is bundled by
 * esbuild as an IIFE (see esbuild.mjs). It is browser-only code: it never
 * imports the `vscode` module and communicates with the extension host
 * exclusively through the message protocol defined in src/common/types.ts.
 *
 * DOM access is deliberately defensive: every querySelector/getElementById
 * result is guarded so that a host template mismatch degrades gracefully
 * instead of throwing. Untrusted content (translated HTML from the host
 * renderer, model output for selection translations) is never assigned via
 * innerHTML except for the Mermaid-generated SVG, which is produced under
 * `securityLevel: 'strict'` and additionally constrained by the CSP nonce.
 */
import type {
  PreviewConfigMessage,
  PreviewHostMessage,
  PreviewInitMessage,
  PreviewSelectionResultMessage,
  PreviewStatusMessage,
  PreviewUpdateMessage,
  PreviewWebviewMessage,
  TranslationMode,
} from '../common/types';

/* ------------------------------------------------------------------ */
/* VS Code webview API                                                 */
/* ------------------------------------------------------------------ */

/**
 * Shape of the API injected into the webview by VS Code. Declared here
 * because the real object only exists at runtime inside the webview host.
 */
interface VscodeWebviewApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(v: unknown): void;
}
declare function acquireVsCodeApi(): VscodeWebviewApi;

/** Called exactly once; the handle is kept for the lifetime of the webview. */
const vscodeApi = acquireVsCodeApi();

/** Send a protocol message to the extension host. */
function post(msg: PreviewWebviewMessage): void {
  vscodeApi.postMessage(msg);
}

/* ------------------------------------------------------------------ */
/* i18n (small inline dictionary)                                      */
/* ------------------------------------------------------------------ */

const STRINGS_EN = {
  ready: 'Ready',
  extracting: 'Extracting segments…',
  translating: 'Translating…',
  rendering: 'Rendering…',
  done: 'Translation complete',
  failed: 'Translation failed',
  cancelled: 'Cancelled',
  translate: 'Translate',
  retranslate: 'Re-translate',
  cancel: 'Cancel',
  source: 'Source',
  translated: 'Translated',
  bilingual: 'Bilingual',
  copy: 'Copy',
  copied: 'Copied ✓',
  close: 'Close',
  apiKeyNotSet: 'API key not set',
  translateSelection: 'Translate',
  cardLabel: 'Translation',
  notTranslatedYet: 'Not translated yet',
} as const;

type StringKey = keyof typeof STRINGS_EN;

const STRINGS_ZH: Record<StringKey, string> = {
  ready: '就绪',
  extracting: '正在提取段落…',
  translating: '正在翻译…',
  rendering: '正在渲染…',
  done: '翻译完成',
  failed: '翻译失败',
  cancelled: '已取消',
  translate: '翻译',
  retranslate: '重新翻译',
  cancel: '取消',
  source: '原文',
  translated: '译文',
  bilingual: '双语',
  copy: '复制',
  copied: '已复制 ✓',
  close: '关闭',
  apiKeyNotSet: '未设置 API 密钥',
  translateSelection: '翻译',
  cardLabel: '翻译',
  notTranslatedYet: '尚未翻译',
};

/** VS Code UI language; English until the init message arrives. */
let uiLanguage = 'en';

function t(key: StringKey): string {
  return uiLanguage.toLowerCase().startsWith('zh') ? STRINGS_ZH[key] : STRINGS_EN[key];
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

let currentMode: TranslationMode = 'translated';
/** True once a non-null translatedHtml arrived or a `done` status was seen. */
let hasTranslation = false;
let hasApiKey = false;
let targetLanguage = '';
let mermaidScriptUri = '';
let translatedBlocks = new Set<number>();
/** Pristine copy of the latest translated HTML, used to repair the translated root. */
let translatedHtmlSnapshot: string | null = null;
let lastStatus: PreviewStatusMessage = { type: 'status', state: 'idle', done: 0, total: 0 };
/** Last non-empty selection text, kept for browsers that collapse the selection on button mousedown. */
let lastSelectionText = '';
let requestCounter = 0;
const pendingRequests = new Set<number>();
let copyResetTimer: number | undefined;
let selectionDebounceTimer: number | undefined;
let themeDebounceTimer: number | undefined;
let mermaidSeq = 0;
let mermaidUsed = false;
let mermaidLoadPromise: Promise<MermaidApi | null> | null = null;
/** Incremented whenever a render pass is superseded (theme change, DOM reset). */
let mermaidRenderGeneration = 0;
/** Elements inserted into the source root by bilingual mode (clones and table-cell wrappers). */
const inserts: HTMLElement[] = [];

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

interface PreviewElements {
  toolbar: HTMLElement;
  status: HTMLElement;
  btnTranslate: HTMLButtonElement;
  btnRetranslate: HTMLButtonElement;
  btnCancel: HTMLButtonElement;
  srcRoot: HTMLElement;
  transRoot: HTMLElement;
  selBtn: HTMLButtonElement;
  selBtnLabel: HTMLElement;
  card: HTMLElement;
  cardLabel: HTMLElement;
  cardBody: HTMLElement;
  cardCopy: HTMLButtonElement;
  cardClose: HTMLButtonElement;
}

/** Assigned in bootstrap() before any handler can run. */
let els: PreviewElements;
let segmentButtons: HTMLButtonElement[] = [];

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function collectElements(): PreviewElements | null {
  const toolbar = byId('mdt-toolbar');
  const status = byId('mdt-status');
  const btnTranslate = byId<HTMLButtonElement>('mdt-btn-translate');
  const btnRetranslate = byId<HTMLButtonElement>('mdt-btn-retranslate');
  const btnCancel = byId<HTMLButtonElement>('mdt-btn-cancel');
  const srcRoot = byId('mdt-src-root');
  const transRoot = byId('mdt-trans-root');
  const selBtn = byId<HTMLButtonElement>('mdt-sel-btn');
  const selBtnLabel = byId('mdt-sel-btn-label');
  const card = byId('mdt-card');
  const cardLabel = byId('mdt-card-label');
  const cardBody = byId('mdt-card-body');
  const cardCopy = byId<HTMLButtonElement>('mdt-card-copy');
  const cardClose = byId<HTMLButtonElement>('mdt-card-close');
  if (
    toolbar === null ||
    status === null ||
    btnTranslate === null ||
    btnRetranslate === null ||
    btnCancel === null ||
    srcRoot === null ||
    transRoot === null ||
    selBtn === null ||
    selBtnLabel === null ||
    card === null ||
    cardLabel === null ||
    cardBody === null ||
    cardCopy === null ||
    cardClose === null
  ) {
    return null;
  }
  return {
    toolbar,
    status,
    btnTranslate,
    btnRetranslate,
    btnCancel,
    srcRoot,
    transRoot,
    selBtn,
    selBtnLabel,
    card,
    cardLabel,
    cardBody,
    cardCopy,
    cardClose,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

/** Rebuild the status text and the translate/retranslate/cancel buttons. */
function updateToolbar(msg: PreviewStatusMessage): void {
  lastStatus = msg;
  const { status, btnTranslate, btnRetranslate, btnCancel } = els;
  let text: string;
  switch (msg.state) {
    case 'idle':
      text = t('ready');
      break;
    case 'extracting':
      text = t('extracting');
      break;
    case 'translating':
      text = `${t('translating')} ${msg.done}/${msg.total}`;
      break;
    case 'rendering':
      text = t('rendering');
      break;
    case 'done':
      text = t('done');
      break;
    case 'error':
      text = msg.message ? `${t('failed')}: ${msg.message}` : t('failed');
      break;
    case 'cancelled':
      text = t('cancelled');
      break;
  }
  if (!hasApiKey) {
    text += ` · ${t('apiKeyNotSet')}`;
    status.classList.add('mdt-warn');
  } else {
    status.classList.remove('mdt-warn');
  }
  status.textContent = '';
  const busy =
    msg.state === 'extracting' || msg.state === 'translating' || msg.state === 'rendering';
  if (busy) {
    const spinner = document.createElement('i');
    spinner.className = 'codicon codicon-loading mdt-spin';
    status.appendChild(spinner);
  }
  status.appendChild(document.createTextNode(text));
  if (busy) {
    btnTranslate.hidden = true;
    btnRetranslate.hidden = true;
    btnCancel.hidden = false;
  } else if (msg.state === 'done') {
    btnTranslate.hidden = true;
    btnRetranslate.hidden = false;
    btnCancel.hidden = true;
  } else {
    btnTranslate.hidden = false;
    btnRetranslate.hidden = !hasTranslation;
    btnCancel.hidden = true;
  }
}

/** Fill a button with a codicon and an i18n label (text is from our own dictionary). */
function setButtonContent(btn: HTMLElement, codicon: string, label: string): void {
  btn.textContent = '';
  const icon = document.createElement('i');
  icon.className = `codicon ${codicon}`;
  btn.appendChild(icon);
  btn.appendChild(document.createTextNode(label));
}

/** Apply i18n labels, titles and codicons to all static UI chrome. */
function initLabels(): void {
  const { btnTranslate, btnRetranslate, btnCancel, cardLabel, cardCopy, cardClose, selBtnLabel } = els;
  setButtonContent(btnTranslate, 'codicon-globe', t('translate'));
  setButtonContent(btnRetranslate, 'codicon-refresh', t('retranslate'));
  setButtonContent(btnCancel, 'codicon-stop-circle', t('cancel'));
  btnTranslate.title = t('translate');
  btnRetranslate.title = t('retranslate');
  btnCancel.title = t('cancel');
  cardCopy.title = t('copy');
  cardClose.title = t('close');
  cardLabel.textContent = t('cardLabel');
  selBtnLabel.textContent = t('translateSelection');
  const icons: Record<TranslationMode, string> = {
    source: 'codicon-file-code',
    translated: 'codicon-globe',
    bilingual: 'codicon-split-horizontal',
  };
  const labels: Record<TranslationMode, StringKey> = {
    source: 'source',
    translated: 'translated',
    bilingual: 'bilingual',
  };
  for (const btn of segmentButtons) {
    const mode = btn.dataset.mode;
    if (mode !== 'source' && mode !== 'translated' && mode !== 'bilingual') continue;
    setButtonContent(btn, icons[mode], t(labels[mode]));
  }
}

/* ------------------------------------------------------------------ */
/* Mode switching (source / translated / bilingual)                    */
/* ------------------------------------------------------------------ */

function applyMode(mode: TranslationMode): void {
  currentMode = mode;
  removeInserts();
  const { srcRoot, transRoot } = els;
  switch (mode) {
    case 'source':
      srcRoot.hidden = false;
      transRoot.hidden = true;
      break;
    case 'translated':
      if (hasTranslation) {
        srcRoot.hidden = true;
        transRoot.hidden = false;
      } else {
        // No translation yet: fall back to the source (the status explains).
        srcRoot.hidden = false;
        transRoot.hidden = true;
      }
      break;
    case 'bilingual':
      srcRoot.hidden = false;
      transRoot.hidden = true;
      buildBilingual();
      break;
  }
  for (const btn of segmentButtons) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
}

function setMode(mode: TranslationMode): void {
  applyMode(mode);
  post({ type: 'setMode', mode });
}

/**
 * Remove everything bilingual mode inserted into the source root. Table-cell
 * wrappers had their children MOVED out of the translated root, so the
 * children are moved back first; if any pairing lookup fails the whole
 * translated root is restored from the pristine snapshot. Clones are simply
 * removed.
 */
function removeInserts(): void {
  if (inserts.length === 0) return;
  const { transRoot } = els;
  let restored = false;
  for (const el of inserts) {
    if (!el.isConnected) continue;
    if (!restored && el.classList.contains('mdt-trans-cell')) {
      const cell = el.parentElement;
      const indexAttr = cell === null ? null : cell.getAttribute('data-mdt-block');
      const transEl =
        indexAttr === null
          ? null
          : transRoot.querySelector<HTMLElement>(`[data-mdt-block="${indexAttr}"]`);
      if (transEl !== null) {
        // Put the moved children back into their original translated cell.
        while (el.firstChild !== null) transEl.appendChild(el.firstChild);
        el.remove();
        continue;
      }
      // Pairing lookup failed: repair the translated root from the snapshot so
      // no translated content is ever lost, then drop the remaining inserts.
      if (translatedHtmlSnapshot !== null) transRoot.innerHTML = translatedHtmlSnapshot;
      restored = true;
    }
    el.remove();
  }
  inserts.length = 0;
}

/**
 * Pair translated blocks into the source root. Only top-level blocks carry
 * `data-mdt-block` markers, so there are no nested pairing conflicts.
 */
function buildBilingual(): void {
  const { srcRoot, transRoot } = els;
  const indexes = Array.from(translatedBlocks).sort((a, b) => a - b);
  for (const index of indexes) {
    const srcEl = srcRoot.querySelector<HTMLElement>(`[data-mdt-block="${index}"]`);
    const transEl = transRoot.querySelector<HTMLElement>(`[data-mdt-block="${index}"]`);
    if (srcEl === null || transEl === null) continue;
    const tag = srcEl.tagName;
    if (tag === 'TD' || tag === 'TH') {
      // Keep the table's column structure intact: nest the translated cell
      // content inside a wrapper appended to the source cell.
      const wrapper = document.createElement('div');
      wrapper.className = 'mdt-trans-cell';
      while (transEl.firstChild !== null) wrapper.appendChild(transEl.firstChild);
      srcEl.appendChild(wrapper);
      inserts.push(wrapper);
    } else {
      const clone = transEl.cloneNode(true) as HTMLElement;
      clone.classList.add('mdt-trans');
      srcEl.insertAdjacentElement('afterend', clone);
      inserts.push(clone);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Selection translation (划词翻译)                                    */
/* ------------------------------------------------------------------ */

function scheduleSelectionCheck(): void {
  if (selectionDebounceTimer !== undefined) window.clearTimeout(selectionDebounceTimer);
  selectionDebounceTimer = window.setTimeout(() => {
    selectionDebounceTimer = undefined;
    checkSelection();
  }, 50);
}

function checkSelection(): void {
  const { selBtn, selBtnLabel, toolbar } = els;
  const hideButton = (): void => {
    selBtn.hidden = true;
  };
  const sel = window.getSelection();
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0 || sel.toString().trim() === '') {
    hideButton();
    return;
  }
  const anchor = sel.anchorNode;
  const anchorEl = anchor instanceof Element ? anchor : anchor === null ? null : anchor.parentElement;
  if (
    anchorEl === null ||
    anchorEl.closest('pre, code') !== null ||
    anchorEl.closest('#mdt-card, #mdt-sel-btn') !== null
  ) {
    hideButton();
    return;
  }
  if (anchorEl.closest('#mdt-src-root, #mdt-trans-root') === null) {
    hideButton();
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selBtn.hidden = false; // Unhide first so the button has measurable dimensions.
  const btnWidth = selBtn.offsetWidth;
  const btnHeight = selBtn.offsetHeight;
  const toolbarBottom = toolbar.getBoundingClientRect().bottom;
  let top = rect.top - btnHeight - 8;
  if (top < toolbarBottom) top = rect.bottom + 8;
  const left = clamp(rect.left + rect.width / 2 - btnWidth / 2, 8, window.innerWidth - btnWidth - 8);
  selBtn.style.top = `${top}px`;
  selBtn.style.left = `${left}px`;
  selBtnLabel.textContent = t('translateSelection');
  lastSelectionText = sel.toString().trim();
}

function onSelectButtonClick(): void {
  const { selBtn } = els;
  const sel = window.getSelection();
  let text = sel === null ? '' : sel.toString().trim();
  if (text === '') text = lastSelectionText;
  if (text === '') return;
  lastSelectionText = '';
  const rect = selBtn.getBoundingClientRect();
  selBtn.hidden = true;
  requestCounter += 1;
  const requestId = requestCounter;
  pendingRequests.add(requestId);
  showCardLoading(rect.left, rect.top);
  post({ type: 'translateSelection', requestId, text });
}

/** Show the floating card in its loading state, anchored at the given viewport position. */
function showCardLoading(left: number, top: number): void {
  const { card, cardLabel, cardBody, toolbar } = els;
  card.hidden = false;
  cardLabel.textContent = targetLanguage === '' ? t('cardLabel') : `${t('cardLabel')} · ${targetLanguage}`;
  cardBody.classList.remove('mdt-error');
  cardBody.textContent = '';
  const spinner = document.createElement('i');
  spinner.className = 'codicon codicon-loading mdt-spin';
  cardBody.appendChild(spinner);
  cardBody.appendChild(document.createTextNode(` ${t('translating')}`));
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const toolbarBottom = toolbar.getBoundingClientRect().bottom;
  card.style.left = `${clamp(left, 8, window.innerWidth - cardWidth - 8)}px`;
  card.style.top = `${clamp(top, toolbarBottom + 8, window.innerHeight - cardHeight - 8)}px`;
}

function hideCard(): void {
  els.card.hidden = true;
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path (async Clipboard API rejected).
  }
  // Fallback for older WebView versions without the async Clipboard API.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('execCommand("copy") failed');
}

function onCopyClick(): void {
  const { cardCopy, cardBody } = els;
  void copyText(cardBody.textContent ?? '')
    .then(() => {
      cardCopy.title = t('copied');
      if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer);
      copyResetTimer = window.setTimeout(() => {
        cardCopy.title = t('copy');
        copyResetTimer = undefined;
      }, 1200);
    })
    .catch(() => {
      // Nothing to do; the user can select and copy manually.
    });
}

/* ------------------------------------------------------------------ */
/* Link handling                                                       */
/* ------------------------------------------------------------------ */

function handleDocumentClick(ev: MouseEvent): void {
  const target = ev.target;
  if (!(target instanceof Element)) return;
  // Never intercept clicks inside the floating card or the toolbar.
  if (target.closest('#mdt-card') !== null || target.closest('#mdt-toolbar') !== null) return;
  const anchor = target.closest('a[href]');
  if (anchor === null) return;
  ev.preventDefault();
  const href = anchor.getAttribute('href');
  if (href === null || href === '') return;
  if (href.startsWith('#')) {
    scrollToAnchor(href.slice(1));
    return;
  }
  // The host decides how to open external vs. local links.
  post({ type: 'openLink', href });
}

function scrollToAnchor(id: string): void {
  if (id === '') return;
  const { srcRoot, transRoot } = els;
  let target: Element | null = null;
  // Prefer the currently visible root so the smooth scroll actually lands.
  if (!srcRoot.hidden) target = srcRoot.querySelector(`#${CSS.escape(id)}`);
  if (target === null && !transRoot.hidden) target = transRoot.querySelector(`#${CSS.escape(id)}`);
  if (target === null) target = document.getElementById(id);
  if (target !== null) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------------ */
/* Mermaid                                                             */
/* ------------------------------------------------------------------ */

/** Minimal view of the mermaid API used by the preview (loaded lazily). */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

function ensureMermaid(): Promise<MermaidApi | null> {
  if (mermaidLoadPromise === null) mermaidLoadPromise = loadMermaid();
  return mermaidLoadPromise;
}

async function loadMermaid(): Promise<MermaidApi | null> {
  // The mermaid bundle assigns itself to window.mermaid (see mermaid.ts).
  const win = window as unknown as { mermaid?: MermaidApi };
  if (win.mermaid !== undefined) return win.mermaid;
  if (mermaidScriptUri === '') return null;
  const nonceMeta = document.getElementById('mdt-nonce');
  const nonce = nonceMeta === null ? '' : nonceMeta.getAttribute('content') ?? '';
  try {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = mermaidScriptUri;
      if (nonce !== '') script.setAttribute('nonce', nonce);
      script.addEventListener('load', () => resolve());
      script.addEventListener('error', () => reject(new Error('Failed to load the mermaid bundle')));
      document.head.appendChild(script);
    });
    return win.mermaid ?? null;
  } catch (err) {
    console.warn('[mdt] Mermaid bundle unavailable:', err);
    return null;
  }
}

/** Render every `pre > code.language-mermaid` block in both roots. */
async function renderMermaidBlocks(): Promise<void> {
  const { srcRoot, transRoot } = els;
  const generation = ++mermaidRenderGeneration;
  const blocks: Array<{ pre: HTMLPreElement; text: string }> = [];
  for (const root of [srcRoot, transRoot]) {
    const codes = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
    for (const code of Array.from(codes)) {
      const pre = code.parentElement;
      if (!(pre instanceof HTMLPreElement)) continue;
      const text = code.textContent ?? '';
      if (pre.dataset.mermaidRendered === text) continue;
      blocks.push({ pre, text });
    }
  }
  if (blocks.length === 0) return;
  const mermaid = await ensureMermaid();
  if (mermaid === null || generation !== mermaidRenderGeneration) return;
  mermaidUsed = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: document.body.classList.contains('vscode-dark') ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'var(--vscode-editor-font-family)',
  });
  for (const { pre, text } of blocks) {
    if (generation !== mermaidRenderGeneration || !pre.isConnected) return;
    try {
      // Reserve a fresh, unique render id before awaiting so that concurrent
      // render passes can never reuse the same temporary element id.
      mermaidSeq += 1;
      const { svg } = await mermaid.render(`mdt-m${mermaidSeq}`, text);
      if (generation !== mermaidRenderGeneration || !pre.isConnected) return;
      // The SVG was generated by mermaid under securityLevel 'strict', which
      // prevents scripts from being injected; the CSP `script-src` nonce
      // additionally blocks any script inside the inserted markup.
      pre.style.display = 'none';
      const rendered = document.createElement('div');
      rendered.className = 'mermaid-rendered';
      rendered.innerHTML = svg;
      pre.insertAdjacentElement('afterend', rendered);
      pre.dataset.mermaidRendered = text;
      pre.classList.remove('mdt-mermaid-failed');
    } catch (err) {
      pre.classList.add('mdt-mermaid-failed');
      console.warn('[mdt] Mermaid rendering failed:', err);
    }
  }
}

/** Undo all rendered diagrams (theme change) so they can be re-rendered. */
function resetMermaid(): void {
  mermaidRenderGeneration += 1;
  const { srcRoot, transRoot } = els;
  for (const root of [srcRoot, transRoot]) {
    const pres = root.querySelectorAll<HTMLElement>('pre[data-mermaid-rendered]');
    for (const pre of Array.from(pres)) {
      pre.style.display = '';
      const rendered = pre.nextElementSibling;
      if (rendered !== null && rendered.classList.contains('mermaid-rendered')) rendered.remove();
      delete pre.dataset.mermaidRendered;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Host message handling                                               */
/* ------------------------------------------------------------------ */

function handleInit(msg: PreviewInitMessage): void {
  const { srcRoot, transRoot } = els;
  uiLanguage = msg.vscodeLanguage;
  hasApiKey = msg.hasApiKey;
  targetLanguage = msg.targetLanguage;
  mermaidScriptUri = msg.mermaidScriptUri;
  document.title = msg.documentTitle;
  inserts.length = 0;
  srcRoot.innerHTML = msg.sourceHtml;
  translatedHtmlSnapshot = msg.translatedHtml;
  translatedBlocks = new Set(msg.translatedBlocks);
  hasTranslation = msg.translatedHtml !== null;
  if (translatedHtmlSnapshot !== null) transRoot.innerHTML = translatedHtmlSnapshot;
  initLabels();
  applyMode(msg.mode);
  void renderMermaidBlocks();
  lastStatus = { type: 'status', state: 'idle', done: 0, total: 0 };
  updateToolbar(lastStatus);
}

function handleUpdateHtml(msg: PreviewUpdateMessage): void {
  const { srcRoot, transRoot } = els;
  // Any bilingual inserts are destroyed together with the old source content;
  // the fresh translatedHtml restores the translated root to a pristine state.
  inserts.length = 0;
  translatedHtmlSnapshot = msg.translatedHtml;
  translatedBlocks = new Set(msg.translatedBlocks);
  hasTranslation = true;
  srcRoot.innerHTML = msg.sourceHtml;
  transRoot.innerHTML = msg.translatedHtml;
  applyMode(currentMode);
  void renderMermaidBlocks();
}

function handleStatus(msg: PreviewStatusMessage): void {
  const gainedTranslation = msg.state === 'done' && !hasTranslation;
  if (msg.state === 'done') hasTranslation = true;
  updateToolbar(msg);
  // Re-evaluate root visibility now that a translation exists.
  if (gainedTranslation) applyMode(currentMode);
}

function handleConfig(msg: PreviewConfigMessage): void {
  hasApiKey = msg.hasApiKey;
  updateToolbar(lastStatus);
  applyMode(msg.mode);
}

function handleSelectionResult(msg: PreviewSelectionResultMessage): void {
  if (!pendingRequests.delete(msg.requestId)) return;
  const { cardBody } = els;
  cardBody.textContent = '';
  if (msg.ok) {
    // Untrusted model output: rendered as plain text only, never as HTML.
    cardBody.textContent = msg.text ?? '';
    cardBody.classList.remove('mdt-error');
  } else {
    cardBody.textContent = msg.error ?? t('failed');
    cardBody.classList.add('mdt-error');
  }
}

function handleHostMessage(event: MessageEvent): void {
  const msg = event.data as PreviewHostMessage | null;
  if (msg === null || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'init':
      handleInit(msg);
      break;
    case 'updateHtml':
      handleUpdateHtml(msg);
      break;
    case 'status':
      handleStatus(msg);
      break;
    case 'config':
      handleConfig(msg);
      break;
    case 'selectionTranslationResult':
      handleSelectionResult(msg);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Error reporting                                                     */
/* ------------------------------------------------------------------ */

function reportError(err: unknown): void {
  post({ type: 'reportError', message: String(err).slice(0, 500) });
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

function wireStaticUi(): void {
  const { btnTranslate, btnRetranslate, btnCancel, selBtn, cardCopy, cardClose } = els;
  btnTranslate.addEventListener('click', () => post({ type: 'translateAll' }));
  btnRetranslate.addEventListener('click', () => post({ type: 'retranslate' }));
  btnCancel.addEventListener('click', () => post({ type: 'cancel' }));
  segmentButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#mdt-seg .mdt-seg-btn'));
  for (const btn of segmentButtons) {
    const mode = btn.dataset.mode;
    if (mode !== 'source' && mode !== 'translated' && mode !== 'bilingual') continue;
    btn.addEventListener('click', () => setMode(mode));
  }
  // Keep the selection alive across the button's mousedown so the click
  // handler can still read the selected text.
  selBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
  selBtn.addEventListener('click', onSelectButtonClick);
  cardCopy.addEventListener('click', onCopyClick);
  cardClose.addEventListener('click', hideCard);
}

const themeObserver = new MutationObserver(() => {
  if (themeDebounceTimer !== undefined) window.clearTimeout(themeDebounceTimer);
  themeDebounceTimer = window.setTimeout(() => {
    themeDebounceTimer = undefined;
    if (!mermaidUsed) return;
    resetMermaid();
    void renderMermaidBlocks();
  }, 200);
});

function wireGlobalListeners(): void {
  window.addEventListener('message', handleHostMessage);
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('mousedown', (ev) => {
    const target = ev.target;
    if (target instanceof Element && (target.closest('#mdt-card') !== null || target.closest('#mdt-sel-btn') !== null)) {
      return;
    }
    hideCard();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      hideCard();
      els.selBtn.hidden = true;
    }
  });
  document.addEventListener('selectionchange', scheduleSelectionCheck);
  document.addEventListener('mouseup', scheduleSelectionCheck);
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function bootstrap(): void {
  const collected = collectElements();
  if (collected === null) {
    post({ type: 'reportError', message: 'Preview template mismatch: required elements are missing.' });
    return;
  }
  els = collected;
  wireStaticUi();
  wireGlobalListeners();
  initLabels();
  lastStatus = { type: 'status', state: 'idle', done: 0, total: 0 };
  updateToolbar(lastStatus);
  post({ type: 'ready' });
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
