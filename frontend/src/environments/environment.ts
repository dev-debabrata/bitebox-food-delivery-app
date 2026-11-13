export const environment = {
  production: false,
  baseUrl: 'http://localhost:5000/api/v1',
  // baseUrl: 'http://192.168.0.12:5000/api/v1', // from a phone on the same Wi-Fi (your PC's LAN IP)

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
