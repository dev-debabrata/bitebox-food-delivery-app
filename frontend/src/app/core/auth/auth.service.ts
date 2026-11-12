import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  Injectable,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import {
  Observable,
  catchError,
  finalize,
  map,
  of,
  shareReplay,
  tap,
  throwError,
  timer,
  retry,
} from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse } from '../../shared/models/api.models';
import {
  AuthSession,
  ChangePasswordRequest,
  LoginRequest,
  Permission,
  ROLE_META,
  RegisterRequest,
  Role,
  UpdateProfileRequest,
  User,
} from '../../shared/models/user.models';
import { errorCode } from '../services/api-error';

export interface SessionHint {
  name: string;
  role: Role;
  email?: string;
}
const HINT_KEY = 'bb.session-hint';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly baseUrl = `${environment.baseUrl}/auth`;

  private readonly _user = signal<User | null>(null);
  private readonly _accessToken = signal<string | null>(null);
  private readonly _initialised = signal(false);
  private refreshInFlight$: Observable<string> | null = null;

  private readonly _hint = signal<SessionHint | null>(null);

  readonly user = this._user.asReadonly();

  readonly displayUser = computed<SessionHint | null>(
    () => this._user() ?? (this._initialised() ? null : this._hint()),
  );
  readonly initialised = this._initialised.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);
  readonly role = computed(() => this._user()?.role ?? null);
  private readonly permissions = computed(() => new Set(this._user()?.permissions ?? []));

  /** Admin permission check for menus and guards (the API enforces the real rule). */
  can(permission: Permission): boolean {
    return this.permissions().has(permission);
  }

  constructor() {
    if (!this.isBrowser) return;
    afterNextRender(() => this._hint.set(readHint()), { injector: inject(Injector) });
  }

  get accessToken(): string | null {
    return this._accessToken();
  }

  restoreSession(): Observable<void> {
    if (!this.isBrowser) return of(undefined);
    return this.refresh().pipe(
      map(() => undefined),
      catchError(() => of(undefined)),
      finalize(() => this._initialised.set(true)),
    );
  }

  login(request: LoginRequest): Observable<User> {
    return this.http
      .post<ApiResponse<AuthSession>>(`${this.baseUrl}/login`, request)
      .pipe(map((res) => this.applySession(res.data)));
  }

  register(request: RegisterRequest): Observable<User> {
    return this.http
      .post<ApiResponse<AuthSession>>(`${this.baseUrl}/register`, request)
      .pipe(map((res) => this.applySession(res.data)));
  }

  refresh(): Observable<string> {
    if (!this.refreshInFlight$) {
      const attempt = () =>
        this.http
          .post<ApiResponse<AuthSession>>(`${this.baseUrl}/refresh`, {})
          .pipe(map((res) => (this.applySession(res.data), res.data.accessToken)));

      this.refreshInFlight$ = attempt().pipe(
        // A serverless API can answer the first request after a cold start with a 5xx,
        // or a concurrent race might occur; retry those before deciding the user is signed out.
        retry({
          count: 3,
          delay: (error: unknown, n) =>
            isTransient(error) ? timer(500 * n) : throwError(() => error),
        }),
        // Only a definite "no valid session" answer ends the session, not a network blip or race.
        catchError((error: unknown) => {
          if (!isTransient(error)) this.clearSession();
          return throwError(() => error);
        }),
        finalize(() => (this.refreshInFlight$ = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.refreshInFlight$;
  }

  logout(): Observable<void> {
    const role = this._user()?.role ?? 'customer';
    return this.http.post<ApiResponse<null>>(`${this.baseUrl}/logout`, {}).pipe(
      catchError(() => of(null)),
      map(() => undefined),
      tap(() => {
        this.clearSession();
        void this.router.navigateByUrl(ROLE_META[role].login);
      }),
    );
  }

  forgotPassword(email: string): Observable<string> {
    return this.http
      .post<ApiResponse<null>>(`${this.baseUrl}/forgot-password`, { email })
      .pipe(map((res) => res.message));
  }

  resetPassword(token: string, password: string): Observable<string> {
    return this.http
      .post<ApiResponse<null>>(`${this.baseUrl}/reset-password`, { token, password })
      .pipe(map((res) => res.message));
  }

  updateProfile(request: UpdateProfileRequest): Observable<User> {
    return this.http.patch<ApiResponse<{ user: User }>>(`${this.baseUrl}/me`, request).pipe(
      map((res) => res.data.user),
      tap((user) => {
        this._user.set(user);
        writeHint(user);
      }),
    );
  }

  changePassword(request: ChangePasswordRequest): Observable<string> {
    const role = this._user()?.role ?? 'customer';
    return this.http.post<ApiResponse<null>>(`${this.baseUrl}/change-password`, request).pipe(
      map((res) => res.message),
      tap(() => {
        this.clearSession();
        void this.router.navigateByUrl(ROLE_META[role].login);
      }),
    );
  }

  hasRole(...roles: Role[]): boolean {
    const role = this.role();
    return role !== null && roles.includes(role);
  }

  homeFor(role: Role): string {
    return ROLE_META[role].home;
  }

  clearSession(): void {
    this._user.set(null);
    this._accessToken.set(null);
    this._hint.set(null);
    if (this.isBrowser) localStorage.removeItem(HINT_KEY);
  }

  private applySession(session: AuthSession): User {
    this._accessToken.set(session.accessToken);
    this._user.set(session.user);
    if (this.isBrowser) writeHint(session.user);
    return session.user;
  }
}

/** Network failure, server cold-start, or concurrent refresh race. */
export const isTransient = (error: unknown) =>
  error instanceof HttpErrorResponse &&
  (error.status === 0 || error.status >= 500 || errorCode(error) === 'REFRESH_RACE');

function readHint(): SessionHint | null {
  try {
    const hint = JSON.parse(localStorage.getItem(HINT_KEY) ?? 'null') as SessionHint | null;
    return hint && typeof hint.name === 'string' && hint.role in ROLE_META
      ? { name: hint.name, role: hint.role }
      : null;
  } catch {
    return null;
  }
}

function writeHint({ name, role }: User): void {
  try {
    localStorage.setItem(HINT_KEY, JSON.stringify({ name, role } satisfies SessionHint));
  } catch {}
}
