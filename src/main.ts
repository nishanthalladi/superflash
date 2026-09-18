import { stage0 } from './stage0';
import { ejectToDisk } from './eject';
import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const flags = new URLSearchParams(location.search);
// The one runtime library, handed to Types (hot-loaded from data URLs, so they
// cannot import a bare specifier themselves). Set before boot: Types mount during it.
const superflash: Record<string, unknown> = { libs: { xterm: { Terminal, FitAddon } } };
Object.assign(globalThis, { superflash });
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
  Object.assign(superflash, booted, { eject: () => ejectToDisk(booted.kernel) });
});
