import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { emailRules } from '../../../shared/forms/form-rules';

@Component({
  selector: 'bb-forgot-password',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './forgot-password.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ForgotPassword {
  private readonly auth = inject(AuthService);

  protected readonly model = signal({ email: '' });
  protected readonly form = form(this.model, (path) => emailRules(path.email), {
    submission: { action: () => this.sendLink() },
  });
  protected readonly sentMessage = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly shownError = shownError;

  private async sendLink(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      this.sentMessage.set(await firstValueFrom(this.auth.forgotPassword(this.model().email)));
    } catch (err) {
      this.error.set(errorMessage(err));
    }
    return undefined;
  }
}
