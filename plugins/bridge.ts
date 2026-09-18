import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promises as dns } from 'node:dns';
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

// --- web -------------------------------------------------------------------

export const WEB_MAX = 2 * 1024 * 1024;
/** Loopback, link-local, RFC1918, and their IPv6 kin. Hostnames are resolved and checked too. */
const PRIVATE = /^(localhost$|127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;

const isPrivate = (addr: string): boolean => {
  let a = addr.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  // `[::ffff:127.0.0.1]` comes out of `new URL` as `::ffff:7f00:1`.
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (hex) a = [hex[1]!, hex[2]!].flatMap((h) => [parseInt(h, 16) >> 8, parseInt(h, 16) & 255]).join('.');
  return PRIVATE.test(a);
};

async function checkHost(host: string): Promise<void> {
  if (!host || isPrivate(host)) throw new Refused(`private host: ${host}`);
  const { address } = await dns.lookup(host).catch(() => ({ address: '' }));
  if (isPrivate(address)) throw new Refused(`private host: ${host}`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ENTITIES[e]!);

/** Readable text from HTML with a few regexes. ponytail: no Readability; good enough for a note. */
export function extract(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(head|script|style|noscript|svg|nav|footer|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|td|th)\s*>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title, text };
}

async function capped(body: ReadableStream<Uint8Array> | null): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (body) {
    for await (const c of body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(c);
      size += c.length;
      if (size > WEB_MAX) break;
    }
  }
  return Buffer.concat(chunks).subarray(0, WEB_MAX).toString('utf8');
}

/** Fetch a page for a `web` note. http(s) only, redirects checked hop by hop, 10s, 2MB. */
export async function fetchWeb(raw: unknown): Promise<{ title: string; text: string }> {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Refused(`not a url: ${String(raw)}`);
  }
  for (let hop = 0; ; hop += 1) {
    if (!/^https?:$/.test(url.protocol)) throw new Refused(`not http(s): ${url}`);
    await checkHost(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'superflash', accept: 'text/html,*/*' },
    });
    const to = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && to && hop < 5) {
      url = new URL(to, url);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return extract(await capped(res.body));
  }
}

// --- terminal ---------------------------------------------------------------

export interface TermEvent {
  id?: string;
  text?: string;
  /** Sent once, when the shell exits. */
  done?: number | null;
}

export interface Term {
  id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const terms = new Map<string, ChildProcess>();
let termSeq = 0;

/**
 * pty.fork + a copy loop, instead of `pty.spawn`: on macOS spawn never notices
 * the child has exited while our stdin pipe is still open. EOF on stdin, or the
 * shell exiting, ends it; when node kills python the master closes and the shell
 * gets SIGHUP from the kernel. fd 3 is the control pipe: `COLS ROWS\n` sets the
 * window size, and the kernel tells the shell (SIGWINCH).
 */
const PTY = [
  'import fcntl,os,pty,select,struct,sys,termios',
  'pid,fd=pty.fork()',
  'if pid==0: os.execvp(sys.argv[1],sys.argv[1:])',
  'while True:',
  '  r=select.select([fd,0,3],[],[],0.2)[0]',
  '  try:',
  '    if fd in r: os.write(1,os.read(fd,65536))',
  '    if 3 in r:',
  '      s=os.read(3,4096).split()',
  '      if len(s)>1: fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack(\'HHHH\',int(s[-1]),int(s[-2]),0,0))',
  '    if 0 in r:',
  '      d=os.read(0,65536)',
  '      if d: os.write(fd,d)',
  '      else: os.kill(pid,9)',
  '  except OSError: pass',
  '  p,st=os.waitpid(pid,os.WNOHANG)',
  '  if p: break',
  'try: os.write(1,os.read(fd,65536))',
  'except OSError: pass',
  'sys.exit(os.waitstatus_to_exitcode(st))',
].join('\n');

/**
 * A real shell in the repo, as a stream of output. Node has no pty and we take
 * no deps, so python3's stdlib `pty` wraps the shell — it is what `script` is,
 * minus `script`'s insistence on a tty of its own (macOS `script` refuses a
 * pipe). Bytes in go to the pty; bytes out come back through `emit`. Same trust
 * as `/_ask`: dev only, your machine.
 */
export async function termOpen(
  root: string,
  cwd: unknown,
  emit: (e: TermEvent) => void,
  shell: string[] = ['zsh', '-il'],
): Promise<Term> {
  const dir = cwd ? await resolveSafe(root, String(cwd)) : root;
  const id = `t${(termSeq += 1)}`;
  const child = spawn('python3', ['-c', PTY, ...shell], {
    cwd: dir,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  terms.set(id, child);
  emit({ id });
  const utf8 = new StringDecoder('utf8'); // a multi-byte char split across chunks stays whole
  child.stdout!.on('data', (c: Buffer) => emit({ text: utf8.write(c) }));
  child.stderr!.on('data', (c: Buffer) => emit({ text: c.toString() }));
  child.on('error', (err) => emit({ text: `! ${err.message}\n` }));
  child.on('close', (code) => {
    terms.delete(id);
    emit({ done: code });
  });
  return {
    id,
    write: (data) => void child.stdin!.write(data),
    resize: (cols, rows) => termResize(id, cols, rows),
    kill: () => void child.kill(),
  };
}

export function termResize(id: unknown, cols: unknown, rows: unknown): void {
  const child = terms.get(String(id));
  if (!child) throw new Refused(`no such terminal: ${String(id)}`);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Refused('cols and rows must be integers');
  (child.stdio[3] as NodeJS.WritableStream).write(`${cols as number} ${rows as number}\n`);
}

export function termWrite(id: unknown, data: unknown): void {
  const child = terms.get(String(id));
  if (!child) throw new Refused(`no such terminal: ${String(id)}`);
  if (typeof data !== 'string') throw new Refused('data must be a string');
  child.stdin!.write(data);
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
        if (!url.pathname.startsWith('/_fs/') && !url.pathname.startsWith('/_term') && !['/_git', '/_ask', '/_doc', '/_media', '/_web'].includes(url.pathname)) return next();

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
          if (url.pathname === '/_web') return send(200, await fetchWeb(url.searchParams.get('url') ?? ''));
          if (url.pathname === '/_ask') {
            const input = (await readBody(req)) as { prompt?: unknown; session?: unknown };
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache');
            await ask(root, input.prompt, input.session, (e) => res.write(`${JSON.stringify(e)}\n`));
            return res.end();
          }
          // --- terminal ---
          if (url.pathname === '/_term') {
            const input = (await readBody(req)) as { cwd?: unknown };
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson');
            res.setHeader('cache-control', 'no-cache');
            const term = await termOpen(root, input.cwd, (e) => {
              res.write(`${JSON.stringify(e)}\n`);
              if ('done' in e) res.end();
            });
            res.on('close', term.kill); // the box went away: so does the shell
            return;
          }
          const termRoute = /^\/_term\/(\w+)\/(in|resize)$/.exec(url.pathname);
          if (termRoute) {
            const input = (await readBody(req)) as { data?: unknown; cols?: unknown; rows?: unknown };
            if (termRoute[2] === 'in') termWrite(termRoute[1], input.data);
            else termResize(termRoute[1], input.cols, input.rows);
            return send(200, {});
          }
          // --- end terminal ---
          return send(404, { error: 'no such route' });
        } catch (err) {
          const refused = err instanceof Refused;
          return send(refused ? 403 : 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}
