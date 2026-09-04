import type { Grant } from './grants';
import { Denied } from './grants';
import type { NoteId } from './model';

export interface Machine {
  readonly grants: Grant[];
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  stop(): void;
}

/** What the kernel gives a Machine: grant-checked reads and nothing else. */
export interface MachineHost {
  read(note: NoteId): string;
  emit(name: string, data?: unknown): void;
  holds(grant: Grant): boolean;
}

/** Prepended to every Machine body. A Worker has no DOM; this makes it explicit. */
export const SANDBOX_PREAMBLE = `
self.document = undefined;
self.window = undefined;
self.XMLHttpRequest = undefined;
self.importScripts = undefined;
`;

type Spawner = (source: string) => WorkerLike;

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
}

const blobSpawner: Spawner = (source) => {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url, { type: 'module' });
  return worker as unknown as WorkerLike;
};

/**
 * Start a Machine. It runs the given source in a Worker: no window, no raw disk.
 * Its only way out is `{ read }` / `{ emit }` requests, which are checked
 * against the grants it was started with.
 */
export function startMachine(
  source: string,
  grants: Grant[],
  host: MachineHost,
  spawn: Spawner = blobSpawner,
): Machine {
  const held = new Set(grants.filter((g) => host.holds(g)));
  const worker = spawn(SANDBOX_PREAMBLE + source);
  const handlers = new Set<(m: unknown) => void>();

  worker.addEventListener('message', (e) => {
    const msg = e.data as Record<string, unknown> | null;
    if (msg && typeof msg === 'object' && typeof msg['req'] === 'string') {
      const id = msg['id'];
      if (msg['req'] === 'read') {
        const note = String(msg['note']);
        const grant = `read:${note}`;
        if (!held.has(grant)) {
          worker.postMessage({ id, error: new Denied(grant).message });
          return;
        }
        worker.postMessage({ id, body: host.read(note) });
        return;
      }
      if (msg['req'] === 'emit') {
        host.emit(String(msg['name']), msg['data']);
        return;
      }
    }
    for (const h of handlers) h(e.data);
  });

  return {
    grants: [...held],
    send: (message) => worker.postMessage(message),
    onMessage: (handler) => handlers.add(handler),
    stop: () => worker.terminate(),
  };
}
