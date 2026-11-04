import { HttpParams } from '@angular/common/http';

export function toParams(query: object): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params = params.set(key, String(value));
  }
  return params;
}
