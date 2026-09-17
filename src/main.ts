import { stage0 } from './stage0';
import { ejectToDisk } from './eject';
import './style.css';

const flags = new URLSearchParams(location.search);
const app = document.querySelector<HTMLElement>('#app')!;

stage0(app, localStorage, { fresh: flags.has('fresh'), safe: flags.has('safe') }).then((booted) => {
  // Never lose the last few keystrokes — to the store or to disk.
  const flush = (): void => {
    booted.save.flush();
    void booted.files?.flush();
    void booted.doc?.flush();
  };
  addEventListener('pagehide', flush);
  addEventListener('beforeunload', flush);
  // A box can reach these: `globalThis.superflash.eject()`.
  Object.assign(globalThis, { superflash: { ...booted, eject: () => ejectToDisk(booted.kernel) } });
});
