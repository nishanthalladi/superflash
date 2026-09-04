import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

/**
 * The bridge: the repo, over HTTP, in dev only.
 *
 * This is the trust boundary for v2. Not the grants — a Type runs in the page and
 * the page has `fetch`, so anything on the desk can reach these routes. What
 * actually holds is enforced here: paths cannot leave the repo, git never sees a
 * shell, and a production build has no bridge at all (`apply: 'serve'`).
 */

/** Never listed, never read, never written. */
export const DENY = new Set(['.git', 'node_modules', 'dist', '.DS_Store', '.vite']);
/** Files we would only garble by treating them as text. */
export const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp[34]|mov|wasm)$/i;
export const MAX_BYTES = 512 * 1024;

/** git subcommands the bridge will run. `push` is deliberately absent. */
export const GIT_OK = new Set([
  'init',
  'status',
  'diff',
  'log',
  'add',
  'reset',
  'commit',
  'checkout',
  'branch',
  'stash',
  'rev-parse',
  'show',
]);

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refused';
  }
}

/**
 * Resolve a repo-relative path, or refuse. Symlinks are resolved first, so a link
 * pointing out of the repo is caught rather than followed.
 */
export async function resolveSafe(root: string, rel: string): Promise<string> {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || path.isAbsolute(rel)) {
    throw new Refused(`not a repo-relative path: ${rel}`);
  }
  const base = await fs.realpath(root);
  const full = path.resolve(base, rel);
  const real = await fs.realpath(full).catch(() => full);
  const inside = real === base || real.startsWith(base + path.sep);
  if (!inside) throw new Refused(`outside the repo: ${rel}`);
  for (const part of path.relative(base, real).split(path.sep)) {
    if (DENY.has(part)) throw new Refused(`denied: ${rel}`);
  }
  if (BINARY.test(real)) throw new Refused(`not text: ${rel}`);
  return real;
}

export interface Entry {
  path: string;
  size: number;
  mtime: number;
}

/** Every text file in the repo, small ones only, denylist applied. */
export async function list(root: string): Promise<Entry[]> {
  const base = await fs.realpath(root);
  const out: Entry[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (DENY.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || BINARY.test(entry.name)) continue;
      const stat = await fs.stat(full);
      if (stat.size > MAX_BYTES) continue;
      out.push({ path: path.relative(base, full), size: stat.size, mtime: Math.round(stat.mtimeMs) });
    }
  };

  await walk(base);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function read(root: string, rel: string): Promise<{ path: string; body: string; mtime: number }> {
  const full = await resolveSafe(root, rel);
  const stat = await fs.stat(full);
  if (stat.size > MAX_BYTES) throw new Refused(`too big: ${rel}`);
  const body = await fs.readFile(full, 'utf8');
  if (body.includes('\0')) throw new Refused(`not text: ${rel}`);
  return { path: rel, body, mtime: Math.round(stat.mtimeMs) };
}

export async function write(root: string, rel: string, body: string): Promise<{ path: string; mtime: number }> {
  if (typeof body !== 'string') throw new Refused('body must be a string');
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Refused(`too big: ${rel}`);
  const full = await resolveSafe(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
  const stat = await fs.stat(full);
  return { path: rel, mtime: Math.round(stat.mtimeMs) };
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git. An argv array, never a string, and never a shell — so a commit message
 * cannot become a command. Only allowlisted subcommands.
 */
export async function git(root: string, args: unknown): Promise<GitResult> {
  if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
    throw new Refused('git takes a non-empty array of strings');
  }
  const argv = args as string[];
  if (!GIT_OK.has(argv[0]!)) throw new Refused(`git ${argv[0]} is not allowed`);

  return new Promise((resolve) => {
    execFile(
      'git',
      argv,
      { cwd: root, maxBuffer: 8 * 1024 * 1024, shell: false, timeout: 20_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

// --- the plugin ------------------------------------------------------------

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => {
      text += String(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
  });

export function bridge(options: { root?: string } = {}): Plugin {
  const root = options.root ?? process.cwd();

  return {
    name: 'desk-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://desk');
        if (!url.pathname.startsWith('/_fs/') && url.pathname !== '/_git') return next();

        const send = (code: number, value: unknown): void => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(value));
        };

        try {
          if (url.pathname === '/_fs/list') return send(200, await list(root));
          if (url.pathname === '/_fs/read') return send(200, await read(root, url.searchParams.get('path') ?? ''));
          if (url.pathname === '/_fs/write') {
            const input = (await readBody(req)) as { path?: string; body?: string };
            return send(200, await write(root, input.path ?? '', input.body ?? ''));
          }
          if (url.pathname === '/_git') {
            const input = (await readBody(req)) as { args?: unknown };
            return send(200, await git(root, input.args));
          }
          return send(404, { error: 'no such route' });
        } catch (err) {
          const refused = err instanceof Refused;
          return send(refused ? 403 : 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}
