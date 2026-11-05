/**
 * Development talks to the API directly on port 5000, on the host the page was opened from
 * (localhost, or the machine's LAN IP from a phone). Server-side rendering uses localhost.
 */
const apiOrigin =
  typeof window === 'undefined'
    ? 'http://localhost:5000'
    : `${window.location.protocol}//${window.location.hostname}:5000`;

export const environment = {
  production: false,
  apiUrl: `${apiOrigin}/api/v1`,

  map: {
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },

  /**
   * Public links shown in the site footer. Leave a value empty until the official URL exists:
   * empty links are not shown. Never put secrets here (this file is bundled into the browser).
   */
  links: {
    social: { facebook: '', instagram: '', youtube: '', linkedin: '', x: '' },
    apps: { googlePlay: '', appStore: '' },
  },
};
