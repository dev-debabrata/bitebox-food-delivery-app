import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { errorMessage, resourceError } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { SupportService } from '../../../core/services/support.service';
import { requiredText } from '../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import {
  TICKET_STATUS_LABEL,
  TICKET_STATUS_TONE,
  TICKET_TYPE_LABEL,
} from '../../../shared/models/admin-roles.models';
import { supportBase } from '../support-base';

@Component({
  selector: 'bb-my-ticket',
  imports: [DatePipe, RouterLink, FormRoot, NP_FORM_FIELDS, MatButtonModule, IconComponent],
  templateUrl: './my-ticket.html',
  styleUrl: './my-ticket.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyTicket {
  private readonly api = inject(SupportService);
  private readonly notify = inject(NotificationService);
  protected readonly base = supportBase();
  protected readonly statusLabel = TICKET_STATUS_LABEL;
  protected readonly statusTone = TICKET_STATUS_TONE;
  protected readonly typeLabel = TICKET_TYPE_LABEL;

  /** Route parameter. */
  readonly id = input.required<string>();

  protected readonly ticket = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.api.get(params),
  });
  protected readonly error = resourceError(this.ticket, 'Could not load this ticket.');

  protected readonly reply = signal({ body: '' });
  protected readonly replyForm = form(
    this.reply,
    (path) => requiredText(path.body, 'Message', { min: 2, max: 2000 }),
    { submission: { action: () => this.send() } },
  );

  private async send(): Promise<TreeValidationResult> {
    try {
      this.ticket.set(await firstValueFrom(this.api.reply(this.id(), this.reply().body.trim())));
      this.reply.set({ body: '' });
      this.replyForm().reset();
      this.notify.success('Reply sent');
    } catch (err) {
      this.notify.error(errorMessage(err));
    }
    return undefined;
  }
}
