import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormRoot, TreeValidationResult, form, pattern } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ROLE_META, SelfRegisterRole } from '../../../shared/models/user.models';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { emailRules, matchesField, passwordRules, phoneRules, requiredText } from '../../../shared/forms/form-rules';
import { codeRules } from '../../../shared/forms/code-rules';
import { countdown } from '../../../shared/forms/countdown';
import { errorCode } from '../../../core/services/api-error';
import { PhoneInput } from '../../../shared/components/phone-input/phone-input';

const INTRO: Record<SelfRegisterRole, string> = {
  customer: 'Join BiteBox to order from great local restaurants.',
  restaurant: 'Create your partner account. You will add restaurant details and get approved next.',
  delivery: 'Create your rider account to start accepting deliveries near you.',
};

@Component({
  selector: 'bb-register',
  imports: [
    PhoneInput,
    FormRoot,
    NP_FORM_FIELDS,
    RouterLink,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
  ],
  templateUrl: './register.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Register {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);

  readonly role = input<SelfRegisterRole>('customer');
  readonly heading = input('Create your account');
  /** ?ref=CODE from a friend's invite link (customers only). */
  readonly ref = input<string>();

  protected readonly model = signal({ name: '', email: '', phone: '', password: '', confirmPassword: '', referralCode: '' });
  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 80 });
      emailRules(path.email);
      phoneRules(path.phone); // the account is confirmed with a code texted to it
      passwordRules(path.password);
      matchesField(path.confirmPassword, path.password);
      pattern(path.referralCode, /^\s*([A-Za-z0-9-]{4,40})?\s*$/, { message: 'Enter a valid referral code' });
    },
    { submission: { action: () => this.sendCode() } },
  );

  /** Step 2: the code texted to the number creates the account. */
  protected readonly step = signal<'details' | 'code'>('details');
  protected readonly notice = signal<string | null>(null);
  private readonly timer = countdown();
  protected readonly resendIn = this.timer.left;
  protected readonly codeModel = signal({ code: '' });
  protected readonly codeForm = form(this.codeModel, (p) => codeRules(p.code), {
    submission: { action: () => this.createAccount(this.codeModel().code) },
  });

  protected readonly error = signal<string | null>(null);
  protected readonly meta = computed(() => ROLE_META[this.role()]);
  protected readonly intro = computed(() => INTRO[this.role()]);
  protected readonly shownError = shownError;

  constructor() {
    // Prefill the code from an invite link.
    effect(() => {
      const ref = this.ref()?.trim().toUpperCase();
      if (ref && /^[A-Z0-9-]{4,40}$/.test(ref))
        untracked(() => this.model.update((m) => (m.referralCode ? m : { ...m, referralCode: ref })));
    });
  }

  /** Step 1: check the details, then text a code (or sign up at once while SMS is off). */
  private async sendCode(): Promise<TreeValidationResult> {
    this.error.set(null);
    const { email, phone } = this.model();
    try {
      const sent = await firstValueFrom(this.auth.requestSignupCode(email, phone.trim()));
      this.notice.set(`${sent.message}: ${phone.trim()}`);
      this.codeForm().reset({ code: '' });
      this.step.set('code');
      this.timer.start(sent.resendInSeconds);
      return undefined;
    } catch (err) {
      if (errorCode(err) === 'SMS_UNAVAILABLE') return this.createAccount();
      this.error.set(errorMessage(err, 'Unable to create your account. Please try again.'));
      return serverErrors(this.form, fieldErrors(err));
    }
  }

  protected async resend(): Promise<void> {
    this.step.set('details');
    await this.sendCode();
  }

  protected editDetails(): void {
    this.step.set('details');
    this.error.set(null);
  }

  private async createAccount(smsCode?: string): Promise<TreeValidationResult> {
    this.error.set(null);
    const { confirmPassword: _confirm, phone, referralCode, ...rest } = this.model();
    const code = this.role() === 'customer' ? referralCode.trim().toUpperCase() : '';
    try {
      const user = await firstValueFrom(
        this.auth.register({
          ...rest,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(code ? { referralCode: code } : {}),
          ...(smsCode ? { code: smsCode } : {}),
          role: this.role(),
        }),
      );
      this.notify.success(`Welcome to BiteBox, ${user.name.split(' ')[0]}!`);
      void this.router.navigateByUrl(ROLE_META[user.role].home);
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Unable to create your account. Please try again.'));
      // A wrong code stays on the code step; a problem with the details goes back to them.
      const fields = fieldErrors(err);
      const onCode = fields.some((f) => f.field === 'code');
      if (fields.length && !onCode) this.step.set('details');
      return serverErrors(onCode ? this.codeForm : this.form, fields);
    }
  }
}
