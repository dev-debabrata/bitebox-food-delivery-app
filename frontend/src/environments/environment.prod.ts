// Which API the production web app talks to: 'django' (backend-django on :8000 / PostgreSQL)
// or 'node' (backend/ on :5000 / MongoDB). Accounts live in each API's own database,
// so the whole app switches together (sign-in, data and live updates).
const backend = 'node' as 'node' | 'django';

// In production behind a reverse proxy (nginx in Docker, or Vercel rewrites), '/api/v1' stays
// on the same origin. If running standalone or on separate cloud hosts (e.g. Render, Railway,
// Vercel), set the full public API URL here.
const api = {
  node: '/api/v1',
  django: '/api/v1',
  // Examples when backend runs on a separate host/port without an nginx reverse proxy:
  // node: 'http://localhost:5000/api/v1',
  // django: 'http://localhost:8000/api/v1',
  // node: 'https://api.yourdomain.com/api/v1',
  // django: 'https://django-api.yourdomain.com/api/v1',
};

export const environment = {
  production: true,
  baseUrl: api[backend],

  // With backend 'node' only: these paths go to Django instead (step-by-step migration).
  djangoUrl: api.django,
  djangoRoutes: [] as string[],
  // Live updates: Socket.IO on Node, or the WebSocket at djangoUrl's /ws/ on Django.
  realtime: backend,

  map: {
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },

  // Footer links; empty ones are hidden. No secrets in this file (it ships to the browser).
  links: {
    social: { facebook: '', instagram: '', youtube: '', linkedin: '', x: '' },
    apps: { googlePlay: '', appStore: '' },
  },
};
