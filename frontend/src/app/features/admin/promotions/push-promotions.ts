import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, pattern } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AdminPushService } from '../../../core/services/admin/admin-push.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { confirmed } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { requiredText } from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { BbDialog } from '../../../shared/dialog/bb-dialog';

/** A page on this site, e.g. /restaurants (matches the API rule). */
const SITE_PATH = /^$|^\/(?!\/)\S{0,199}$/;
const EMPTY = { title: '', body: '', link: '/restaurants' };

/**
 * Push an offer to every customer who turned on "Offers and promotions". Sent only to people
 * who opted in, recorded in the audit log, and rate limited by the API.
 */
@Component({
  selector: 'bb-push-promotions',
  imports: [FormRoot, NP_FORM_FIELDS, MatButtonModule, IconComponent, PageHeader],
  templateUrl: './push-promotions.html',
  styleUrl: './push-promotions.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PushPromotionsPage {
  private readonly api = inject(AdminPushService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);
  protected readonly lastResult = signal<number | null>(null);

  protected readonly model = signal(EMPTY);
  protected readonly form = form(
    this.model,
    (p) => {
      requiredText(p.title, 'Title', { min: 3, max: 60 });
      requiredText(p.body, 'Message', { min: 3, max: 160 });
      pattern(p.link, SITE_PATH, { message: 'Use a BiteBox page such as /restaurants' });
    },
    { submission: { action: () => this.send() } },
  );

  private async send(): Promise<TreeValidationResult> {
    const v = this.model();
    const input = { title: v.title.trim(), body: v.body.trim(), ...(v.link.trim() && { link: v.link.trim() }) };
    const ok = await firstValueFrom(
      confirmed(this.dialog, {
        title: 'Send this promotion?',
        message: `"${input.title}" goes to every customer who turned on offers and promotions. It cannot be recalled.`,
        confirmLabel: 'Send now',
      }),
      { defaultValue: null },
    );
    if (!ok) return undefined;

    this.error.set(null);
    try {
      const { recipients } = await firstValueFrom(this.api.sendPromotion(input));
      this.lastResult.set(recipients);
      this.notify.success(
        recipients ? `Sending to ${recipients} customer${recipients === 1 ? '' : 's'}.` : 'Nobody has opted in yet.',
      );
      this.model.set(EMPTY);
      this.form().reset();
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
