/**
 * Routes and validates webview messages. Pure logic (no vscode imports) so it
 * can be unit tested with fake dependencies.
 */
import { MAX_SELECTION_LENGTH } from '../common/constants';
import { errorMessage } from '../common/errors';
import type {
  Logger,
  PreviewHostMessage,
  PreviewWebviewMessage,
  TranslationMode,
} from '../common/types';

const MODES: readonly TranslationMode[] = ['source', 'translated', 'bilingual'];

export interface PreviewRouterDeps {
  logger?: Logger;
  translateAll(): void | Promise<void>;
  retranslate(): void | Promise<void>;
  cancel(): void;
  setMode(mode: TranslationMode): void;
  /** Translates the selected text; rejects with a user-safe error. */
  translateSelection(text: string): Promise<string>;
  openLink(href: string): void | Promise<void>;
}

export class WebviewMessageRouter {
  constructor(private readonly deps: PreviewRouterDeps) {}

  /**
   * Handles one message. The reply callback is used for selection translation
   * results. Never throws: failures are reported through `reply` or logged.
   */
  async handle(message: unknown, reply: (msg: PreviewHostMessage) => void): Promise<void> {
    if (!message || typeof message !== 'object') {
      this.deps.logger?.warn('Ignoring malformed webview message');
      return;
    }
    const msg = message as PreviewWebviewMessage;
    try {
      switch (msg.type) {
        case 'ready':
          return;
        case 'translateAll':
          await this.deps.translateAll();
          return;
        case 'retranslate':
          await this.deps.retranslate();
          return;
        case 'cancel':
          this.deps.cancel();
          return;
        case 'setMode':
          if (MODES.includes(msg.mode)) {
            this.deps.setMode(msg.mode);
          } else {
            this.deps.logger?.warn(`Ignoring invalid mode: ${String(msg.mode)}`);
          }
          return;
        case 'translateSelection':
          await this.handleSelection(msg, reply);
          return;
        case 'openLink': {
          const href = typeof msg.href === 'string' ? msg.href : '';
          if (href.length > 0 && href.length <= 2048) {
            await this.deps.openLink(href);
          }
          return;
        }
        case 'reportError':
          this.deps.logger?.warn(`Webview reported error: ${String(msg.message).slice(0, 500)}`);
          return;
        default:
          this.deps.logger?.warn(`Unknown webview message type: ${String((msg as { type?: unknown }).type)}`);
      }
    } catch (err) {
      this.deps.logger?.error(`Webview message handler failed (${msg.type}): ${errorMessage(err)}`);
    }
  }

  private async handleSelection(
    msg: Extract<PreviewWebviewMessage, { type: 'translateSelection' }>,
    reply: (msg: PreviewHostMessage) => void,
  ): Promise<void> {
    const requestId = typeof msg.requestId === 'number' ? msg.requestId : -1;
    const text = typeof msg.text === 'string' ? msg.text : '';
    if (text.trim().length === 0) {
      reply({ type: 'selectionTranslationResult', requestId, ok: false, error: 'Empty selection.' });
      return;
    }
    if (text.length > MAX_SELECTION_LENGTH) {
      reply({
        type: 'selectionTranslationResult',
        requestId,
        ok: false,
        error: `Selection too long (maximum ${MAX_SELECTION_LENGTH} characters).`,
      });
      return;
    }
    try {
      const translated = await this.deps.translateSelection(text);
      reply({ type: 'selectionTranslationResult', requestId, ok: true, text: translated });
    } catch (err) {
      reply({ type: 'selectionTranslationResult', requestId, ok: false, error: errorMessage(err) });
    }
  }
}
