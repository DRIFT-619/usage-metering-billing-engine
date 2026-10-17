'use strict';

// Runs automatically before start / dev / migrate:up / seed (npm "pre" hooks).
// On a fresh clone there is no .env (it is git-ignored on purpose), so without
// this the app would try Postgres on the wrong port and crash. Copying the
// placeholder file gets a stranger from `git clone` to a booting app.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, '.env.example'), envPath);
  console.log('[setup] .env not found — created it from .env.example (DB settings match docker-compose; Stripe values are placeholders).');
}