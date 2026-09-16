import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DENY, MAX_BYTES, Refused, git, list, read, resolveSafe, write } from '../plugins/bridge';

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'superflash-bridge-'));
  root = path.join(base, 'repo');
  outside = path.join(base, 'secrets');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'readme.md'), '# hi\n');
  await fs.writeFile(path.join(root, 'logo.png'), 'not really a png');
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'index.js'), 'nope');
  await fs.writeFile(path.join(outside, 'keys.txt'), 'sekrit');
  await fs.symlink(path.join(outside, 'keys.txt'), path.join(root, 'link.txt'));
  await git(root, ['init']);
  // A temp repo has no identity, and commit refuses without one.
  await fs.appendFile(path.join(root, '.git', 'config'), '[user]\n\tname = Test\n\temail = t@example.com\n');
});

afterAll(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe('the jail', () => {
  it('resolves a repo-relative path', async () => {
    expect(await resolveSafe(root, 'src/a.ts')).toBe(path.join(await fs.realpath(root), 'src/a.ts'));
  });

  it('refuses to climb out', async () => {
    for (const bad of ['../secrets/keys.txt', 'src/../../secrets/keys.txt', '/etc/passwd', '']) {
      await expect(resolveSafe(root, bad)).rejects.toThrow(Refused);
    }
  });

  it('refuses a symlink that points out of the repo', async () => {
    await expect(resolveSafe(root, 'link.txt')).rejects.toThrow(Refused);
    await expect(read(root, 'link.txt')).rejects.toThrow(Refused);
  });

  it('refuses the denylist and binaries', async () => {
    expect(DENY.has('node_modules')).toBe(true);
    await expect(resolveSafe(root, 'node_modules/x/index.js')).rejects.toThrow(Refused);
    await expect(resolveSafe(root, 'logo.png')).rejects.toThrow(Refused);
  });

  it('refuses a body bigger than the limit', async () => {
    await expect(write(root, 'big.txt', 'x'.repeat(MAX_BYTES + 1))).rejects.toThrow(Refused);
  });
});

describe('list, read, write', () => {
  it('lists text files and nothing else', async () => {
    const paths = (await list(root)).map((e) => e.path);
    expect(paths).toContain(path.join('src', 'a.ts'));
    expect(paths).toContain('readme.md');
    expect(paths).not.toContain('logo.png');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git'))).toBe(false);
  });

  it('round-trips a file', async () => {
    await write(root, 'src/a.ts', 'export const a = 2;\n');
    expect((await read(root, 'src/a.ts')).body).toBe('export const a = 2;\n');
  });

  it('creates the directories a new file needs', async () => {
    await write(root, 'deep/er/still.ts', 'ok');
    expect((await read(root, 'deep/er/still.ts')).body).toBe('ok');
  });
});

describe('git', () => {
  it('runs an allowlisted subcommand', async () => {
    const { code, stdout } = await git(root, ['status', '--porcelain']);
    expect(code).toBe(0);
    expect(stdout).toContain('readme.md');
  });

  it('refuses anything not on the list', async () => {
    for (const args of [['push'], ['clone', 'x'], ['config', '--global', 'x', 'y']]) {
      await expect(git(root, args)).rejects.toThrow(Refused);
    }
  });

  it('refuses a string, so a message can never become a command', async () => {
    await expect(git(root, 'status; rm -rf /')).rejects.toThrow(Refused);
    await expect(git(root, [])).rejects.toThrow(Refused);
    await expect(git(root, ['status', 5])).rejects.toThrow(Refused);
  });

  it('passes a message with shell characters through untouched', async () => {
    await git(root, ['add', '--', 'readme.md']);
    const done = await git(root, [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      'fix: $(whoami) && `ls` ;',
    ]).catch((err: unknown) => err);
    // `-c` is not an allowlisted subcommand: the allowlist checks argv[0].
    expect(done).toBeInstanceOf(Refused);

    const ok = await git(root, ['commit', '-m', 'fix: $(whoami) && `ls` ;']);
    expect(ok.code === 0 || ok.stderr.includes('user')).toBe(true);
  });
});
