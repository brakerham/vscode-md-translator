import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  CONFIG_KEYS,
  CONFIG_SECTION,
  DEFAULT_SYSTEM_PROMPT,
  EXTENSION_ID,
  SIDEBAR_VIEW_TYPE,
} from '../src/common/constants';

// Tests run with the project root as the working directory (npm scripts).
const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const props: Record<string, { default?: unknown }> = pkg.contributes?.configuration?.properties ?? {};

describe('package.json consistency', () => {
  it('declares every command in COMMANDS', () => {
    const declared = new Set(
      (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command),
    );
    for (const cmd of Object.values(COMMANDS)) {
      expect(declared.has(cmd)).toBe(true);
    }
  });

  it('declares every config key under the config section', () => {
    for (const key of Object.values(CONFIG_KEYS)) {
      expect(props[`${CONFIG_SECTION}.${key}`]).toBeTruthy();
    }
  });

  it('keeps the default system prompt identical to constants', () => {
    const configured = props[`${CONFIG_SECTION}.systemPrompt`]?.default;
    expect(configured).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('shows the translate button only for markdown files in the editor title bar', () => {
    const items = pkg.contributes?.menus?.['editor/title'] ?? [];
    expect(
      items.some(
        (i: { command: string; when?: string }) =>
          i.command === COMMANDS.translateDocument && i.when === 'resourceLangId == markdown',
      ),
    ).toBe(true);
  });

  it('has complete candidate Marketplace metadata', () => {
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    expect([pkg.publisher, pkg.name].join('.')).toBe(EXTENSION_ID);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.license).toBeTruthy();
    expect(pkg.engines?.vscode).toBeTruthy();
    const icon = readFileSync(join(root, pkg.icon));
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(icon.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(icon.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
    expect(pkg.repository?.url).toContain('github.com');
  });

  it('declares the sidebar as a webview and keeps its endpoint in user settings', () => {
    expect(pkg.contributes.views[CONFIG_SECTION]).toContainEqual(expect.objectContaining({
      id: SIDEBAR_VIEW_TYPE,
      type: 'webview',
    }));
    expect(props[CONFIG_SECTION + '.apiBaseUrl']).toMatchObject({ scope: 'machine' });
  });

  it('references an existing activity bar icon', () => {
    const icon = pkg.contributes?.viewsContainers?.activitybar?.[0]?.icon;
    expect(icon).toBeTruthy();
    expect(existsSync(join(root, icon))).toBe(true);
  });
});
