import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { ButtonComponent, IconComponent } from 'nexprime';
import { Observable, finalize, firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { codeRules } from '../../../shared/forms/code-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';

/** Email and phone verification: a new email link, or an SMS code to confirm the number. */
@Component({
  selector: 'bb-account-verification',
  imports: [FormRoot, NP_FORM_FIELDS, ButtonComponent, IconComponent],
  templateUrl: './account-verification.html',
  styleUrl: './account-verification.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountVerification {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly user = this.auth.user;
  /** Number verification needs SMS; without it the button is off and a note says why. */
  protected readonly phoneCodes = this.auth.phoneCodes;
  protected readonly busy = signal<'email' | 'phone' | null>(null);
  protected readonly codeSent = signal(false);
  protected readonly shownError = shownError;

  protected readonly codeModel = signal({ code: '' });
  protected readonly codeForm = form(this.codeModel, (p) => codeRules(p.code), {
    submission: { action: () => this.verifyPhone() },
  });

  constructor() {
    this.auth.checkMethods();
  }

  protected resendLink(): void {
    this.run('email', this.auth.resendEmailVerification(), (message) =>
      this.notify.success(message),
    );
  }

  protected sendCode(): void {
    this.run('phone', this.auth.requestPhoneVerification(), (sent) => {
      this.codeSent.set(true);
      this.codeForm().reset({ code: '' });
      this.notify.success(sent.message);
    });
  }

  private async verifyPhone(): Promise<TreeValidationResult> {
    try {
      await firstValueFrom(this.auth.verifyPhone(this.codeModel().code));
      this.codeSent.set(false);
      this.notify.success('Phone number verified');
      return undefined;
    } catch (err) {
      const fields = fieldErrors(err);
      return fields.length
        ? serverErrors(this.codeForm, fields)
        : [{ kind: 'server', message: errorMessage(err), fieldTree: this.codeForm.code }];
    }
  }

  private run<T>(what: 'email' | 'phone', request: Observable<T>, done: (value: T) => void): void {
    this.busy.set(what);
    request.pipe(finalize(() => this.busy.set(null))).subscribe({
      next: done,
      error: (err: unknown) => this.notify.error(errorMessage(err)),
    });
  }
}
