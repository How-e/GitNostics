import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, type GitHubService } from '../../apps/server/src/app';
import { readConfig } from '../../apps/server/src/config';

// The browser suite cannot reach GitHub, inherit a developer credential, or mutate it.
// Only the explicitly selected demo fixtures contain repository data.
globalThis.fetch = async () => {
  throw new Error('Outbound network is disabled in the end-to-end API fixture.');
};
const github: GitHubService = {
  getConnectionStatus: () => ({
    mode: 'public',
    connected: false,
    identity: 'Isolated browser test',
    writesEnabled: false,
  }),
  discoverRepositories: async () => [],
  snapshot: async () => {
    throw new Error('GitHub reads are disabled in the browser test. Explore the demo workspace.');
  },
  execute: async () => {
    throw new Error('GitHub mutations are forbidden in browser tests.');
  },
  disconnect: () => undefined,
};
const localRoot = resolve('.local');
mkdirSync(localRoot, { recursive: true });
const dataDir = mkdtempSync(resolve(localRoot, 'e2e-'));
const config = readConfig({
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: '4311',
  DATA_DIR: dataDir,
  WRITE_ENABLED: 'false',
});
const { app } = await createApp({ config, github, background: false });
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void close();
  });
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  if (
    !resolve(dataDir).startsWith(`${localRoot}\\e2e-`) &&
    !resolve(dataDir).startsWith(`${localRoot}/e2e-`)
  )
    throw new Error('Unexpected browser test data directory.');
  rmSync(dataDir, { recursive: true, force: true });
}
await app.listen({ host: config.host, port: config.port });
