import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { NewsletterService } from '../../../../core/services/newsletter.service';
import { serverErrors, shownError } from '../../../forms/form-errors';
import { emailRules } from '../../../forms/form-rules';
import { NP_FORM_FIELDS } from '../../../forms/np-form-fields';

/** Footer newsletter sign-up. Messages come from the API's answer, never assumed. */
@Component({
  selector: 'bb-newsletter-signup',
  imports: [FormRoot, NP_FORM_FIELDS, MatButtonModule, IconComponent],
  templateUrl: './newsletter-signup.html',
  styleUrl: './newsletter-signup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewsletterSignup {
  private readonly api = inject(NewsletterService);
  protected readonly shownError = shownError;
  protected readonly result = signal<{ ok: boolean; text: string } | null>(null);

  protected readonly model = signal({ email: '' });
  protected readonly form = form(this.model, (p) => emailRules(p.email), {
    submission: { action: () => this.subscribe() },
  });

  private async subscribe(): Promise<TreeValidationResult> {
    this.result.set(null);
    try {
      const { alreadySubscribed } = await firstValueFrom(
        this.api.subscribe(this.model().email.trim()),
      );
      this.result.set({
        ok: true,
        text: alreadySubscribed
          ? 'You’re already on our list. Watch your inbox for offers.'
          : 'You’re subscribed! Look out for offers in your inbox.',
      });
      this.form().reset({ email: '' });
      return undefined;
    } catch (err) {
      const details = fieldErrors(err);
      if (!details.length)
        this.result.set({
          ok: false,
          text: errorMessage(err, 'Could not subscribe. Please try again.'),
        });
      return serverErrors(this.form, details);
    }
  }
}
