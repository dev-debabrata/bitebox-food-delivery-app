import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { matchesField, passwordRules } from '../../../shared/forms/form-rules';

@Component({
  selector: 'bb-reset-password',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './reset-password.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPassword implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly token = input<string>();
  protected readonly resetToken = signal<string | null>(null);

  protected readonly model = signal({ password: '', confirmPassword: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      passwordRules(path.password);
      matchesField(path.confirmPassword, path.password);
    },
    { submission: { action: () => this.saveNewPassword() } },
  );
  protected readonly error = signal<string | null>(null);
  protected readonly shownError = shownError;

  ngOnInit(): void {
    this.resetToken.set(this.token() ?? null);
    if (this.token()) {
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }

  private async saveNewPassword(): Promise<TreeValidationResult> {
    const token = this.resetToken();
    if (!token) return undefined;
    this.error.set(null);
    try {
      await firstValueFrom(this.auth.resetPassword(token, this.model().password));
      void this.router.navigate(['/login'], { queryParams: { reason: 'reset' } });
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    return undefined;
  }
}
