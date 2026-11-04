import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
import { SERVER_API_ORIGIN } from './core/interceptors/server-api.interceptor';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    ...(process.env['API_INTERNAL_URL']
      ? [
          {
            provide: SERVER_API_ORIGIN,
            useValue: process.env['API_INTERNAL_URL'].replace(/\/$/, ''),
          },
        ]
      : []),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
