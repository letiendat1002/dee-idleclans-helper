/**
 * The release note is machine-consumed: it must carry the changelog section of
 * the tagged version, stay under Discord's cap on whole lines, and ping the role
 * only when one is configured. Each case runs the real script against a local
 * webhook sink and a fixture changelog, so a format change in either direction
 * fails here instead of at tag time.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROLE_ID = '1574783884242067536';

interface Payload {
  content: string;
  allowed_mentions: { parse: unknown[]; roles: string[] };
}

interface Run {
  code: number | null;
  stdout: string;
  bodies: Payload[];
}

async function fixture(version: string, changelog: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dih-notify-'));
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await copyFile(new URL('./notify-release.sh', import.meta.url), join(dir, 'scripts/notify-release.sh'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

/**
 * Run the script once against a sink that answers 204 and records the payload.
 */
async function run(dir: string, env: Record<string, string> = {}): Promise<Run> {
  const bodies: Payload[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(body) as Payload);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  const child = spawn('bash', [join(dir, 'scripts/notify-release.sh')], {
    env: { ...process.env, DIH_UPDATES_WEBHOOK: url, DIH_RELEASE_ROLE_ID: '', ...env },
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return { code, stdout, bodies };
}

function section(version: string, lines: string[]): string {
  return [`## [${version}]`, '', '### Added', '', ...lines, ''].join('\n');
}

describe('notify-release.sh', () => {
  it('posts the tagged version, on whole lines, stopping at the next version', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `- line ${String(i).padStart(2, '0')} ${'x'.repeat(60)}`);
    const dir = await fixture(
      '9.9.9',
      ['# Changelog', '', section('9.9.9', many), '## [9.9.8]', '', '- next version', ''].join('\n')
    );

    const { code, bodies } = await run(dir, { GITHUB_REF_NAME: 'v9.9.9', DIH_RELEASE_ROLE_ID: ROLE_ID });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(1);
    const { content, allowed_mentions } = bodies[0]!;
    expect(content.startsWith(`<@&${ROLE_ID}> **v9.9.9**\n### Added\n- line 00 `)).toBe(true);
    expect(content.endsWith('\n...')).toBe(true);
    expect(content).not.toContain('next version');
    expect(content.length).toBeLessThan(1500);
    expect(allowed_mentions).toEqual({ parse: [], roles: [ROLE_ID] });
  }, 20000);

  it('sends the note without a ping when no role is configured', async () => {
    const dir = await fixture('9.9.9', section('9.9.9', ['- one thing']));

    const { code, bodies } = await run(dir, { GITHUB_REF_NAME: 'v9.9.9' });

    expect(code).toBe(0);
    expect(bodies[0]!.content.startsWith('**v9.9.9**\n')).toBe(true);
    expect(bodies[0]!.allowed_mentions).toEqual({ parse: [], roles: [] });
  }, 20000);

  it('stays silent and green when the webhook is not configured', async () => {
    const dir = await fixture('9.9.9', section('9.9.9', ['- one thing']));

    const { code, stdout, bodies } = await run(dir, { GITHUB_REF_NAME: 'v9.9.9', DIH_UPDATES_WEBHOOK: '' });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(0);
    expect(stdout).toContain('skipping the note for v9.9.9');
  }, 20000);

  it('skips a pre-release tag', async () => {
    const dir = await fixture('9.9.9', section('9.9.9', ['- one thing']));

    const { code, bodies } = await run(dir, { GITHUB_REF_NAME: 'v9.9.9-rc.1' });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(0);
  }, 20000);

  it('has a section for the version this checkout would release', async () => {
    const version = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }).version;
    const dir = await fixture(version, await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));

    const { code, bodies } = await run(dir, { GITHUB_REF_NAME: `v${version}` });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.content).toContain('### ');
    expect(bodies[0]!.content.length).toBeGreaterThan(40);
  }, 20000);
});
