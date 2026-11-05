export const environment = {
  production: true,
  apiUrl: '/api/v1',

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
