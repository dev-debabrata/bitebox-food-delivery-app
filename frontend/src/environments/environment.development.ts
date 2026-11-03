export const environment = {
  production: false,
  apiUrl: 'http://localhost:5000/api/v1',
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
