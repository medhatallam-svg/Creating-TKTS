'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const { sweep } = require('./db');
const { seed } = require('./seed');
const log = require('./log');
const auth = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));

/** Minimal cookie parsing - the only cookie this app sets is its session id. */
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      req.cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(auth.attachSession);

app.get('/healthz', (req, res) => res.json({ ok: true, at: new Date().toISOString() }));

app.use('/api/auth', auth.router);
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(config.ROOT, 'public'), { extensions: ['html'], maxAge: '5m' }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  return res.sendFile(path.join(config.ROOT, 'public', 'index.html'));
});

// Last-resort handler: never leak a stack trace to a browser.
app.use((error, req, res, _next) => {
  log.error('server.unhandled', { message: error.message, stack: error.stack });
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

function start() {
  const problems = config.validate();
  if (problems.length) {
    console.error('\nThe server cannot start until these are fixed:\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nSee .env.example and README.md.\n');
    process.exit(1);
  }
  for (const warning of config.warnings()) log.warn('config', { warning });

  seed();
  sweep();
  setInterval(sweep, 10 * 60 * 1000).unref();

  app.listen(config.PORT, () => {
    log.info('server.started', { port: config.PORT, baseUrl: config.APP_BASE_URL, env: config.NODE_ENV });
    console.log(`Azeer ticketing system listening on ${config.APP_BASE_URL}`);
  });
}

if (require.main === module) start();

module.exports = { app, start };
