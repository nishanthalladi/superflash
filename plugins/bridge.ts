import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';

/**
 * The bridge: the repo, over HTTP, in dev only.
 *
 * This is the trust boundary for v2. Not the grants — a Type runs in the page and
 * the page has `fetch`, so anything on the canvas can reach these routes. What
 * actually holds is enforced here: paths cannot leave the repo, git never sees a
 * shell, and a production build has no bridge at all (`apply: 'serve'`).
 */

/** Never listed, never read, never written. */
export const DENY = new Set(['.git', 'node_modules', 'dist', '.DS_Store', '.vite', '.superflash']);
/** Where the live document lives on disk, so an agent in the repo can read and write it. */
export const DOC_PATH = '.superflash/doc.json';
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

export interface AskEvent {
  /** A piece of the reply as it is written. */
  text?: string;
  /** Sent once, at the end. */
  done?: { session: string; cost: number };
  error?: string;
}

/**
 * Ask Claude Code, in the repo, with the tools it already has. One turn; pass the
 * `session` back to continue the same conversation. Events arrive as they happen,
 * one JSON object per line. The door the app works through — nothing here that a
 * terminal could not do, which is the point.
 *
 * ponytail: `--dangerously-skip-permissions`, because there is no one at a
 * terminal to answer a prompt. Same trust as the rest of the bridge: dev only,
 * same origin, your machine. `--strict-mcp-config` keeps the boot bare: the
 * repo's inherited MCP servers cost ~70k tokens a turn and nothing here needs
 * them yet. Add `--mcp-config` from the note when a chat wants one.
 */
export function ask(root: string, prompt: unknown, session: unknown, emit: (e: AskEvent) => void): Promise<void> {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Refused('prompt must be a non-empty string');
  if (session !== undefined && !/^[\w-]+$/.test(String(session))) throw new Refused('bad session id');
  const argv = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
  ];
  if (session) argv.push('--resume', String(session));
  return new Promise((resolve) => {
    // stdin closed: `claude -p` waits ~4s for an open pipe to end before it starts.
    const child = spawn('claude', argv, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let sid = String(session ?? '');
    let cost = 0;
    let failed = '';
    let spoke = false;
    const line = (raw: string): void => {
      if (!raw.trim()) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof ev['session_id'] === 'string') sid = ev['session_id'];
      if (ev['type'] === 'stream_event') {
        const inner = (ev['event'] as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } }) ?? {};
        // A model that works in between (tool calls) writes several text blocks;
        // without a break they run into one paragraph.
        if (inner.type === 'content_block_start' && inner.content_block?.type === 'text' && spoke) emit({ text: '\n\n' });
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
          spoke = true;
          emit({ text: inner.delta.text });
        }
      }
      if (ev['type'] === 'result') {
        cost = typeof ev['total_cost_usd'] === 'number' ? ev['total_cost_usd'] : 0;
        if (ev['is_error']) failed = String(ev['result'] ?? 'claude failed');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const p of parts) line(p);
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      emit({ error: err.message });
      resolve();
    });
    child.on('close', (code) => {
      line(buf);
      if (failed || code) emit({ error: failed || stderr.trim() || `claude exited ${code}` });
      else emit({ done: { session: sid, cost } });
      resolve();
    });
  });
}

/** The document on disk. `null` when there is none yet. */
export async function readDocFile(root: string): Promise<{ body: string; mtime: number } | null> {
  const full = path.join(root, DOC_PATH);
  try {
    const [body, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
    return { body, mtime: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

export async function writeDocFile(root: string, body: unknown): Promise<{ mtime: number }> {
  if (typeof body !== 'string') throw new Refused('body must be a string');
  JSON.parse(body); // refuse to write a document that will not read back
  const full = path.join(root, DOC_PATH);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, 'utf8');
  return { mtime: Math.round((await fs.stat(full)).mtimeMs) };
}

// --- media -----------------------------------------------------------------

export const MEDIA_MAX = 20 * 1024 * 1024;
const MEDIA_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * Bytes into `media/<name>`, and nowhere else. The only route that writes binary;
 * `list` skips it (BINARY), and Vite serves the result at `/media/<name>` in dev.
 */
export async function media(root: string, name: unknown, type: unknown, base64: unknown): Promise<{ path: string }> {
  const ext = MEDIA_TYPES[String(type)];
  if (!ext) throw new Refused(`not an image: ${String(type)}`);
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || !name.endsWith(`.${ext}`)) throw new Refused(`bad media name: ${String(name)}`);
  if (typeof base64 !== 'string') throw new Refused('base64 must be a string');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MEDIA_MAX) throw new Refused(`too big: ${name}`);
  const base = await fs.realpath(root);
  const full = path.join(base, 'media', name);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, bytes);
  return { path: `media/${name}` };
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
    name: 'superflash-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://superflash');
        if (!url.pathname.startsWith('/_fs/') && !['/_git', '/_ask', '/_doc', '/_media'].includes(url.pathname)) return next();

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
          if (url.pathname === '/_media') {
            const input = (await readBody(req)) as { name?: unknown; type?: unknown; base64?: unknown };
            return send(200, await media(root, input.name, input.type, input.base64));
          }
          if (url.pathname === '/_doc' && req.method === 'GET') return send(200, (await readDocFile(root)) ?? { body: null, mtime: 0 });
          if (url.pathname === '/_doc') {
            const input = (await readBody(req)) as { body?: unknown };
            return send(200, await writeDocFile(root, input.body));
          }
          if (url.pathname === '/_ask') {
            const input = (await readBody(req)) as { prompt?: unknown; session?: unknown };
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache');
            await ask(root, input.prompt, input.session, (e) => res.write(`${JSON.stringify(e)}\n`));
            return res.end();
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
