export const environment = {
  production: true,
  baseUrl: '/api/v1', // same origin; nginx sends each path to Node or Django
  djangoUrl: '/api/v1',
  djangoRoutes: [] as string[],
  // Live updates: 'node' until the switch-over, then 'django' (nginx sends /ws/ to Django).
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
