export const environment = {
  production: true,
  baseUrl: 'https://bitebox-backend-opal.vercel.app/api/v1',

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
