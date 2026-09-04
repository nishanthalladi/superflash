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
  };
  addEventListener('pagehide', flush);
  addEventListener('beforeunload', flush);
  // A Cell can reach these: `globalThis.desk.eject()`.
  Object.assign(globalThis, { desk: { ...booted, eject: () => ejectToDisk(booted.kernel) } });
});
