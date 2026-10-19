import { createApp } from './app';
import { readConfig } from './config';

const config = readConfig();
process.env.NODE_ENV ??= config.environment;
const { app } = await createApp({ config, logger: true });
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  });
await app.listen({ host: config.host, port: config.port });
