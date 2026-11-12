import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../../environments/environment';

/**
 * During the Node → Django migration (docs/django-migration/), sends the API paths listed in
 * `environment.djangoRoutes` to `environment.djangoUrl` and leaves every other request on Node.
 *
 * Registered last, after the auth interceptor, so the token and cookie rules are decided on the
 * original URL and the request keeps them when it moves.
 */
export const apiRouterInterceptor: HttpInterceptorFn = (req, next) => {
  const { baseUrl, djangoUrl, djangoRoutes } = environment;
  if (!djangoRoutes.length || djangoUrl === baseUrl || !req.url.startsWith(baseUrl))
    return next(req);

  const path = req.url.slice(baseUrl.length);
  const migrated = djangoRoutes.some(
    (route) => path === route || path.startsWith(`${route}/`) || path.startsWith(`${route}?`),
  );
  return migrated ? next(req.clone({ url: djangoUrl + path })) : next(req);
};
