import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, required } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { emailRules } from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { ROLE_META, Role } from '../../../shared/models/user.models';
import { safeReturnUrl } from '../../../core/services/safe-url';

export { safeReturnUrl };

const PANELS: Partial<Record<Role, string>> = {
  admin: '/admin',
  restaurant: '/restaurant',
  delivery: '/delivery',
};

export function landingFor(role: Role, returnUrl: string | undefined): string {
  const url = safeReturnUrl(returnUrl);
  const inPanel = (path: string, prefix: string) =>
    path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
  if (url) {
    const panel = PANELS[role];
    const allowed = panel
      ? inPanel(url, panel)
      : !Object.values(PANELS).some((p) => inPanel(url, p!));
    if (allowed) return url;
  }
  return ROLE_META[role].home;
}

@Component({
  selector: 'bb-login',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly heading = input('Sign in');
  readonly returnUrl = input<string>();
  readonly reason = input<string>();

  protected readonly model = signal({ email: '', password: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      emailRules(path.email);
      required(path.password, { message: 'Password is required' });
    },
    { submission: { action: () => this.signIn() } },
  );

  protected readonly error = signal<string | null>(null);
  protected readonly shownError = shownError;

  private async signIn(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      const user = await firstValueFrom(this.auth.login(this.model()));
      void this.router.navigateByUrl(landingFor(user.role, this.returnUrl()));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Unable to sign in. Please try again.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
