import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rules in `docs/UI-DESIGN.md` that a sentence cannot enforce.
 *
 * A Unicode emoji or a stray hex colour is invisible in review and reaches
 * every reader at a different size and weight, so the conventions are checked
 * here instead. Tests are skipped: they hold fixtures, not surfaces.
 */
function sources(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Every `path:line` where `pattern` matches, for the files that are not exempt. */
function offenders(pattern: RegExp, exempt: string[]): string[] {
  return sources().flatMap((path) => {
    if (exempt.includes(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line, index) => (pattern.test(line) ? `${path}:${index + 1}` : ''))
      .filter(Boolean);
  });
}

/** Every quoted span on a line, so a copy rule ignores comments and identifiers. */
const QUOTED = /(['"`])((?:\\.|[^\\])*?)\1/g;

/** Every `path:line` whose quoted text matches `pattern`. */
function quotedOffenders(pattern: RegExp, exempt: string[] = []): string[] {
  return sources().flatMap((path) => {
    if (exempt.includes(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        [...line.matchAll(QUOTED)].some((span) => pattern.test(span[2])) ? [`${path}:${index + 1}`] : []
      );
  });
}

describe('Copy conventions', () => {
  it('builds every amount through formatMoney', () => {
    expect(offenders(/\}g`/, ['src/ui/theme.ts'])).toEqual([]);
  });

  it('names the author line only through brandAuthor', () => {
    const ownAuthor = sources().flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          line.includes('setAuthor(') && !line.includes('brandAuthor') ? [`${path}:${index + 1}`] : []
        )
    );

    expect(ownAuthor).toEqual([]);
  });

  it('ships no promise word in a user-facing string', () => {
    expect(quotedOffenders(/\b(profit|guarantee|risk[- ]free|earn)\b/i)).toEqual([]);
  });

  it('shows price direction, never the raw ask/bid vocabulary', () => {
    expect(quotedOffenders(/\b(ask|bid)\s*:|\b(ask|bid)\s+price/i)).toEqual([]);
  });
});

describe('UI conventions', () => {
  it('ships no Unicode emoji outside the terminal log of the migration runner', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

    expect(offenders(emoji, ['src/db/migrate.ts'])).toEqual([]);
  });

  it('keeps every hex colour in the theme, so one state has one colour', () => {
    expect(offenders(/#[0-9a-fA-F]{6}\b/, ['src/ui/theme.ts'])).toEqual([]);
  });

  it('ships no icon token that no surface draws', () => {
    const theme = readFileSync('src/ui/theme.ts', 'utf8');
    const start = theme.indexOf('export const ICONS');
    const tokens = [...theme.slice(start, theme.indexOf('as const', start)).matchAll(/^ {2}([a-z]+):/gm)].map(
      ([, token]) => token
    );
    const drawn = new Set(
      sources()
        .filter((path) => path !== 'src/ui/theme.ts')
        .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/ICONS\.([a-z]+)/g)].map(([, token]) => token))
    );

    expect(tokens.filter((token) => !drawn.has(token))).toEqual([]);
  });

  it('never puts an icon token in a title, an author line or a footer', () => {
    const call = /set(Title|Author|Footer)\(/;
    const next = /^\s*(\.set[A-Z]|\))/;
    const offendersWithIcon = sources().flatMap((path) => {
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines.flatMap((line, index) => {
        if (!call.test(line)) return [];
        const argument = [line];
        for (let at = index + 1; at < lines.length && !next.test(lines[at]); at += 1) {
          argument.push(lines[at]);
        }
        return argument.some((text) => text.includes('ICONS.')) ? [`${path}:${index + 1}`] : [];
      });
    });

    expect(offendersWithIcon).toEqual([]);
  });
});
