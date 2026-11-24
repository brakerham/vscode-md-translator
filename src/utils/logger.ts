/**
 * OutputChannel-backed logger. Never logs API keys: keys only flow through
 * the provider's Authorization header, and this logger additionally masks
 * common secret shapes as defense in depth.
 */
import * as vscode from 'vscode';
import type { Logger } from '../common/types';

function maskSecrets(value: string): string {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, 'sk-***')
    .replace(/(Bearer\s+)[^\s"',]+/gi, '$1***')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class VsCodeLogger implements Logger {
  private readonly output: vscode.OutputChannel;

  constructor(name = 'Markdown AI Translator') {
    this.output = vscode.window.createOutputChannel(name);
  }

  private write(level: string, msg: string, args: unknown[]): void {
    const extra = args.length > 0 ? ' ' + args.map(stringify).join(' ') : '';
    this.output.appendLine(maskSecrets(`[${new Date().toISOString()}] [${level}] ${msg}${extra}`));
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write('DEBUG', msg, args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.write('INFO', msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.write('WARN', msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.write('ERROR', msg, args);
  }

  dispose(): void {
    this.output.dispose();
  }
}
