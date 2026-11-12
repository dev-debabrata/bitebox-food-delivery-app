import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import compression from 'compression';
import express from 'express';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

/**
 * PWA files that must always be revalidated: the service worker and its manifest decide which
 * version of the app every visitor runs, so a year-long cache would pin people to an old build.
 */
const ALWAYS_REVALIDATE = /(?:^|[\/])(?:ngsw-worker\.js|ngsw\.json|safety-worker\.js|worker-basic\.min\.js|manifest\.webmanifest)$/;

const app = express();
const angularApp = new AngularNodeAppEngine();

app.disable('x-powered-by');
if (process.env['TRUST_PROXY'])
  app.set('trust proxy', Number(process.env['TRUST_PROXY']) || process.env['TRUST_PROXY']);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  next();
});
app.use(compression());

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
    setHeaders: (res, path) => {
      if (path.endsWith('.html') || ALWAYS_REVALIDATE.test(path))
        res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
