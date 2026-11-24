/**
 * User-facing errors. These carry messages that are safe to show in
 * notifications; never include API keys or raw request bodies here.
 */
export class UserError extends Error {
  constructor(
    message: string,
    public readonly actions: ReadonlyArray<{ title: string; command: string }> = [],
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** Formats an unknown thrown value into a safe single-line message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
