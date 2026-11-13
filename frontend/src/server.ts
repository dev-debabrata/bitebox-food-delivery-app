import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import compression from 'compression';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const browserDistFolder = join(import.meta.dirname, '../browser');

/**
 * PWA files that must always be revalidated: the service worker and its manifest decide which
 * version of the app every visitor runs, so a year-long cache would pin people to an old build.
 */
const ALWAYS_REVALIDATE = /(?:^|[\/])(?:ngsw-worker\.js|ngsw\.json|safety-worker\.js|worker-basic\.min\.js|manifest\.webmanifest)$/;

/**
 * Content-Security-Policy. Pages rendered here get a fresh nonce: index.html carries the
 * placeholder CSP_NONCE on its inline script and on <app-root ngCspNonce>, which Angular applies
 * to the scripts it adds. 'strict-dynamic' lets those scripts load the app's chunks, Leaflet and
 * Razorpay's checkout.js. Other responses get the parts that need no nonce.
 */
const NONCE_PLACEHOLDER = /CSP_NONCE/g;
const csp = (nonce?: string) =>
  [
    ...(nonce ? [`script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

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
  res.setHeader('Content-Security-Policy', csp());
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
    .then(async (response) => {
      if (!response) return next();
      if (!response.headers.get('content-type')?.includes('text/html'))
        return writeResponseToNodeResponse(response, res);
      const nonce = randomBytes(16).toString('base64');
      const html = (await response.text()).replace(NONCE_PLACEHOLDER, nonce);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      res.setHeader('Content-Security-Policy', csp(nonce));
      return writeResponseToNodeResponse(new Response(html, { status: response.status, headers }), res);
    })
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
