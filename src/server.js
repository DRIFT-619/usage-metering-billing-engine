'use strict';

const buildApp = require('./app');
const config = require('./config');
const { startScheduler } = require('./jobs/scheduler');

const app = buildApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  startScheduler();
});