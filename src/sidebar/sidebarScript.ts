/**
 * Sidebar webview script (bundled as dist/media/sidebar.js).
 */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(v: unknown): void;
};

const api = acquireVsCodeApi();

interface SidebarState {
  hasApiKey: boolean;
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  documentStatus: {
    docTitle: string;
    state: string;
    done: number;
    total: number;
    message?: string;
  } | null;
  lastSelection: { source: string; translation: string } | null;
}

type SidebarHostMessage =
  | ({ type: 'init'; vscodeLanguage: string } & SidebarState)
  | ({ type: 'config' } & Omit<SidebarState, 'documentStatus' | 'lastSelection'>)
  | { type: 'documentStatus'; status: SidebarState['documentStatus'] }
  | { type: 'selectionResult'; result: SidebarState['lastSelection'] };

const $ = (id: string): HTMLElement | null => document.getElementById(id);

let lang = 'en';

const STRINGS: Record<string, Record<string, string>> = {
  en: {
    api: 'API',
    document: 'Document',
    selection: 'Selection',
    keySet: 'API key: configured',
    keyMissing: 'API key: not configured',
    setKey: 'Set API Key',
    clearKey: 'Clear Key',
    settings: 'Settings',
    noDocument: 'No active translation.',
    translate: 'Translate Document',
    retranslate: 'Re-translate',
    selHint: 'Select text in a translation preview (or a Markdown editor) to translate it.',
    copy: 'Copy Translation',
    copied: 'Copied ✓',
    translating: 'Translating…',
    extracting: 'Extracting segments…',
    rendering: 'Rendering…',
    done: 'Translation complete',
    error: 'Translation failed',
    cancelled: 'Cancelled',
    idle: 'Idle',
  },
  'zh-cn': {
    api: 'API',
    document: '文档',
    selection: '划词翻译',
    keySet: 'API Key：已配置',
    keyMissing: 'API Key：未配置',
    setKey: '设置 API Key',
    clearKey: '清除 Key',
    settings: '设置',
    noDocument: '暂无进行中的翻译。',
    translate: '翻译当前文档',
    retranslate: '重新翻译',
    selHint: '在翻译预览（或 Markdown 编辑器）中选中文本即可翻译。',
    copy: '复制译文',
    copied: '已复制 ✓',
    translating: '翻译中…',
    extracting: '提取文本中…',
    rendering: '渲染中…',
    done: '翻译完成',
    error: '翻译失败',
    cancelled: '已取消',
    idle: '空闲',
  },
};

function t(key: string): string {
  return (STRINGS[lang] ?? STRINGS.en)[key] ?? key;
}

function applyStrings(): void {
  const set = (id: string, key: string): void => {
    const el = $(id);
    if (el) el.textContent = t(key);
  };
  set('mdt-api-title', 'api');
  set('mdt-doc-title', 'document');
  set('mdt-sel-title', 'selection');
  set('mdt-cmd-setkey', 'setKey');
  set('mdt-cmd-clearkey', 'clearKey');
  set('mdt-cmd-settings', 'settings');
  set('mdt-cmd-translate', 'translate');
  set('mdt-cmd-retranslate', 'retranslate');
  set('mdt-copy-sel', 'copy');
  const empty = $('mdt-sel-empty');
  if (empty) empty.textContent = t('selHint');
}

interface ApiInfo {
  hasApiKey: boolean;
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
}

function renderApi(state: ApiInfo): void {
  const status = $('mdt-api-status');
  if (!status) return;
  status.textContent = state.hasApiKey ? t('keySet') : t('keyMissing');
  status.className = `mdt-row ${state.hasApiKey ? 'mdt-ok' : 'mdt-bad'}`;
  const detail = $('mdt-api-detail');
  if (detail) {
    detail.textContent = state.model
      ? `${state.model} · ${state.apiBaseUrl}`
      : `${state.apiBaseUrl} · ${state.sourceLanguage} → ${state.targetLanguage}`;
  }
}

function renderDocument(status: SidebarState['documentStatus'] | null): void {
  const name = $('mdt-doc-name');
  const st = $('mdt-doc-status');
  if (!name || !st) return;
  if (!status) {
    name.textContent = t('noDocument');
    st.textContent = '';
    return;
  }
  name.textContent = status.docTitle;
  const stateText = t(status.state) ?? status.state;
  st.textContent =
    status.state === 'translating' && status.total > 0
      ? `${stateText} ${status.done}/${status.total}`
      : status.message
        ? `${stateText}: ${status.message}`
        : stateText;
}

function renderSelection(sel: SidebarState['lastSelection'] | null): void {
  const empty = $('mdt-sel-empty');
  const body = $('mdt-sel-body');
  const copyBtn = $('mdt-copy-sel');
  if (!empty || !body || !copyBtn) return;
  if (!sel) {
    empty.hidden = false;
    body.hidden = true;
    copyBtn.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  copyBtn.hidden = false;
  const src = $('mdt-sel-source');
  const trans = $('mdt-sel-trans');
  if (src) src.textContent = sel.source;
  if (trans) trans.textContent = sel.translation;
}

async function copySelection(): Promise<void> {
  const trans = $('mdt-sel-trans');
  const text = trans?.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const btn = $('mdt-copy-sel');
  if (btn) {
    btn.textContent = t('copied');
    setTimeout(() => {
      btn.textContent = t('copy');
    }, 1500);
  }
}

function bindCommands(): void {
  const map: Record<string, string> = {
    'mdt-cmd-setkey': 'markdownAiTranslator.setApiKey',
    'mdt-cmd-clearkey': 'markdownAiTranslator.clearApiKey',
    'mdt-cmd-settings': 'markdownAiTranslator.openSettings',
    'mdt-cmd-translate': 'markdownAiTranslator.translateDocument',
    'mdt-cmd-retranslate': 'markdownAiTranslator.retranslateDocument',
  };
  for (const [id, command] of Object.entries(map)) {
    const el = $(id);
    if (el) {
      el.addEventListener('click', () => api.postMessage({ type: 'command', command }));
    }
  }
  $('mdt-copy-sel')?.addEventListener('click', () => {
    void copySelection();
  });
}

window.addEventListener('message', (event: MessageEvent<SidebarHostMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;
  switch (msg.type) {
    case 'init': {
      lang = String(msg.vscodeLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
      applyStrings();
      renderApi(msg);
      renderDocument(msg.documentStatus);
      renderSelection(msg.lastSelection);
      break;
    }
    case 'config':
      renderApi(msg);
      break;
    case 'documentStatus':
      renderDocument(msg.status);
      break;
    case 'selectionResult':
      renderSelection(msg.result);
      break;
  }
});

window.addEventListener('error', (e) => {
  api.postMessage({ type: 'reportError', message: String(e.message).slice(0, 500) });
});

applyStrings();
bindCommands();
api.postMessage({ type: 'ready' });
