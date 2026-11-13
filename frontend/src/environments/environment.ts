// Which API the web app talks to: 'django' (backend-django on :8000, PostgreSQL) or 'node'
// (backend/ on :5000, MongoDB). Accounts live in each API's own database, so the whole app
// switches together (sign-in, data and live updates).
const backend = 'node' as 'node' | 'django';
const api = {
  node: 'http://localhost:5000/api/v1',
  django: 'http://localhost:8000/api/v1',
  // From a phone on the same Wi-Fi, use your PC's LAN IP instead, e.g.
  // node: 'http://192.168.0.12:5000/api/v1', django: 'http://192.168.0.12:8000/api/v1',
};

export const environment = {
  production: false,
  baseUrl: api[backend],

  // With backend 'node' only: these paths go to Django instead (step-by-step migration).
  djangoUrl: api.django,
  djangoRoutes: ['/health'] as string[],
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
