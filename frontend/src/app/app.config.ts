import {
  ApplicationConfig,
  PLATFORM_ID,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  RedirectCommand,
  Router,
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withNavigationErrorHandler,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { apiRouterInterceptor } from './core/interceptors/api-router.interceptor';
import { serverApiInterceptor } from './core/interceptors/server-api.interceptor';
import { pageLoaderInterceptor } from './core/services/page-loader';
import { AuthService } from './core/auth/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
      // Offline and the page's code was never saved on this device: explain, don't break.
      withNavigationErrorHandler((error) => {
        if (!isPlatformBrowser(inject(PLATFORM_ID)) || navigator.onLine) return;
        const router = inject(Router);
        return new RedirectCommand(
          router.createUrlTree(['/offline'], { queryParams: { from: error.url } }),
          {
            skipLocationChange: true,
          },
        );
      }),
    ),
    provideClientHydration(withEventReplay()),
    provideHttpClient(
      withFetch(),
      withInterceptors([
        pageLoaderInterceptor,
        serverApiInterceptor,
        authInterceptor,
        apiRouterInterceptor,
      ]),
    ),
    // PWA: app-shell caching, update checks and push (production builds only; see ngsw-config.json).
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    provideAppInitializer(() => {
      inject(AuthService).restoreSession().subscribe();
    }),
  ],
};
