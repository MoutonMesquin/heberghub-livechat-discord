// Routes HTTP : santé, disponibilité du support, widget et page de démo.

import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';

const WIDGET = fileURLToPath(new URL('../widget/live-chat.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../public/demo.html', import.meta.url));

export function createHttpApp({ config, discord }) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Le widget est chargé par d'autres sites : il doit pouvoir être lu cross-origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // CORS limité aux origines autorisées, pour les routes de lecture seules.
  const cors = (req, res, next) => {
    const origin = req.get('origin');
    res.vary('Origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  app.get('/readyz', (_req, res) => {
    const ready = discord.isReady();
    res.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'starting' });
  });

  app.options('/api/status', cors);
  app.get('/api/status', cors, (_req, res) => {
    const available = config.alwaysAvailable ? discord.isReady() : discord.isReady() && discord.isAvailable();
    res.set('Cache-Control', 'public, max-age=30').json({ available });
  });

  app.get('/widget.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/javascript').sendFile(WIDGET);
  });

  if (config.demoPage) {
    app.get(['/', '/demo', '/demo/autre-page'], (_req, res) => res.sendFile(DEMO));
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal_error' }));

  return app;
}
