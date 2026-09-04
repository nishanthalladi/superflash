import type { Fact, NoteId } from './model';

type Handler = (fact: Fact) => void;

/**
 * In-process pub/sub keyed by the emitting Note id.
 * Small facts only. No DOM, no compute.
 */
export class Spine {
  private subs = new Map<NoteId, Set<Handler>>();
  private all = new Set<Handler>();

  /**
   * Hear every fact. For the Desk only — it is the shell, and it has to react to
   * facts from chrome it did not itself subscribe to. Types use `subscribe`.
   */
  subscribeAll(handler: Handler): () => void {
    this.all.add(handler);
    return () => this.all.delete(handler);
  }

  subscribe(from: NoteId, handler: Handler): () => void {
    let set = this.subs.get(from);
    if (!set) {
      set = new Set();
      this.subs.set(from, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subs.delete(from);
    };
  }

  emit(from: NoteId, name: string, data?: unknown): void {
    const fact: Fact = { from, name, data };
    for (const h of [...this.all]) h(fact);
    const set = this.subs.get(from);
    if (!set) return;
    for (const h of [...set]) h(fact);
  }

  subscriberCount(from: NoteId): number {
    return this.subs.get(from)?.size ?? 0;
  }
}
