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
const ALWAYS_REVALIDATE =
  /(?:^|[\/])(?:ngsw-worker\.js|ngsw\.json|safety-worker\.js|worker-basic\.min\.js|manifest\.webmanifest)$/;
const NONCE_PLACEHOLDER = /CSP_NONCE/g;

/** In dev (ng serve on :4200), relax CSP to permit Vite's client, HMR WebSockets, and eval. */
const isDev = (host?: string) =>
  process.env['NODE_ENV'] !== 'production' ||
  Boolean(host && (host.includes(':4200') || host.includes('localhost')));

const csp = (nonce?: string, dev = false) =>
  [
    dev
      ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https: ${nonce ? `'nonce-${nonce}'` : ''}`.trim()
      : nonce
        ? `script-src 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`
        : '',
    dev ? "connect-src 'self' http: https: ws: wss:" : '',
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ]
    .filter(Boolean)
    .join('; ');

const app = express();
const angularApp = new AngularNodeAppEngine();

app.disable('x-powered-by');
if (process.env['TRUST_PROXY'])
  app.set('trust proxy', Number(process.env['TRUST_PROXY']) || process.env['TRUST_PROXY']);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', csp(undefined, isDev(req.headers.host)));
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
  const dev = isDev(req.headers.host);
  angularApp
    .handle(req)
    .then(async (response) => {
      if (!response) return next();
      if (!response.headers.get('content-type')?.includes('text/html'))
        return writeResponseToNodeResponse(response, res);
      const nonce = randomBytes(16).toString('base64');
      const text = await response.text();
      const html = (
        dev
          ? text.replace(
              /<script(?![^>]*nonce=)([^>]*@vite\/client[^>]*)>/gi,
              `<script nonce="${nonce}" $1>`,
            )
          : text
      ).replace(NONCE_PLACEHOLDER, nonce);
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      res.setHeader('Content-Security-Policy', csp(nonce, dev));
      return writeResponseToNodeResponse(
        new Response(html, { status: response.status, headers }),
        res,
      );
    })
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) throw error;
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
