/**
 * Production configuration. Public values only: anything here ships to the
 * browser, so never put secrets in environment files.
 */
export const environment = {
  production: true,
  // Same-origin API behind a reverse proxy in production. Change if the API lives elsewhere.
  apiUrl: '/api/v1',
  /**
   * Map tiles. The public OpenStreetMap tile server is fine for development and
   * light use only (https://operations.osmfoundation.org/policies/tiles/); use a
   * tile provider or your own tile server for production traffic.
   */
  map: {
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
};
