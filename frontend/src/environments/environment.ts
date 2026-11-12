export const environment = {
  production: false,
  baseUrl: 'http://localhost:5000/api/v1', // Node API
  // baseUrl: 'http://192.168.0.12:5000/api/v1', // from a phone on the same Wi-Fi (your PC's LAN IP)

  // Django API: only the paths in djangoRoutes go here, everything else stays on baseUrl.
  djangoUrl: 'http://localhost:8000/api/v1',
  // djangoUrl: 'http://192.168.0.12:8000/api/v1',
  djangoRoutes: ['/health'] as string[],
  // Live updates: 'node' (Socket.IO on baseUrl) or 'django' (WebSocket at djangoUrl's /ws/).
  // Switch together with /auth: the socket signs in with the same access token.
  realtime: 'node' as 'node' | 'django',

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
