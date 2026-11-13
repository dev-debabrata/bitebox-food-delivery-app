import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { PhoneInput } from '../../../../shared/components/phone-input/phone-input';
import { codeRules } from '../../../../shared/forms/code-rules';
import { countdown } from '../../../../shared/forms/countdown';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import { phoneRules } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { User } from '../../../../shared/models/user.models';

/**
 * Sign in with a mobile number: the API texts a 6-digit code (5 minutes, 5 tries), which signs
 * the person in. A new code can be asked for once the countdown ends.
 */
@Component({
  selector: 'bb-phone-login',
  imports: [
    FormRoot,
    NP_FORM_FIELDS,
    PhoneInput,
    MatButtonModule,
    MatProgressSpinnerModule,
    IconComponent,
  ],
  templateUrl: './phone-login.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneLogin {
  private readonly auth = inject(AuthService);
  readonly signedIn = output<User>();

  protected readonly step = signal<'phone' | 'code'>('phone');
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly sending = signal(false);
  private readonly timer = countdown();
  protected readonly resendIn = this.timer.left;
  protected readonly shownError = shownError;

  protected readonly phoneModel = signal({ phone: '' });
  protected readonly phoneForm = form(this.phoneModel, (p) => phoneRules(p.phone), {
    submission: { action: () => this.send() },
  });

  protected readonly codeModel = signal({ code: '' });
  protected readonly codeForm = form(this.codeModel, (p) => codeRules(p.code), {
    submission: { action: () => this.verify() },
  });

  private async send(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      const sent = await firstValueFrom(this.auth.requestLoginCode(this.phoneModel().phone));
      this.notice.set(sent.message);
      this.step.set('code');
      this.codeForm().reset({ code: '' });
      this.timer.start(sent.resendInSeconds);
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not send the code. Please try again.'));
      return serverErrors(this.phoneForm, fieldErrors(err));
    }
  }

  protected async resend(): Promise<void> {
    this.sending.set(true);
    await this.send();
    this.sending.set(false);
  }

  private async verify(): Promise<TreeValidationResult> {
    this.error.set(null);
    try {
      const user = await firstValueFrom(
        this.auth.loginWithCode(this.phoneModel().phone, this.codeModel().code),
      );
      this.signedIn.emit(user);
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not sign in. Please try again.'));
      return serverErrors(this.codeForm, fieldErrors(err));
    }
  }

  protected changeNumber(): void {
    this.step.set('phone');
    this.error.set(null);
    this.notice.set(null);
  }
}
