import { defineConfig } from 'vite';
import { bridge } from './plugins/bridge';

// The bridge is `apply: 'serve'`, so a production build has no repo routes.
export default defineConfig({
  plugins: [bridge()],
});
