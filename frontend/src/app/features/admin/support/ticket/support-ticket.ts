import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormRoot, TreeValidationResult, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import { IconComponent, SelectOption, ToggleComponent } from 'nexprime';
import { Observable, firstValueFrom } from 'rxjs';
import { errorMessage, resourceError } from '../../../../core/services/api-error';
import { NotificationService } from '../../../../core/services/notification.service';
import { SupportDeskService } from '../../../../core/services/support.service';
import { confirmed } from '../../../../shared/components/confirm-dialog/confirm-dialog';
import { shownError } from '../../../../shared/forms/form-errors';
import { requiredText } from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import {
  REQUESTER_LABEL,
  TICKET_PRIORITY_LABEL,
  TICKET_PRIORITY_TONE,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_TONE,
  TICKET_TYPE_LABEL,
  TicketDetail,
  TicketPriority,
  TicketStatus,
  TicketUpdate,
} from '../../../../shared/models/admin-roles.models';
import { ORDER_STATUS_LABEL } from '../../../../shared/models/checkout.models';
import { InrPipe } from '../../../../shared/pipes/money.pipes';

const HISTORY_LABEL: Record<string, string> = {
  created: 'Ticket opened',
  status: 'Status',
  priority: 'Priority',
  assigned: 'Assigned',
  escalated: 'Escalated to finance',
};

@Component({
  selector: 'bb-support-ticket',
  imports: [
    DatePipe,
    RouterLink,
    FormRoot,
    NP_FORM_FIELDS,
    ToggleComponent,
    MatButtonModule,
    IconComponent,
    InrPipe,
  ],
  templateUrl: './support-ticket.html',
  styleUrl: './support-ticket.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportTicketPage {
  private readonly api = inject(SupportDeskService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  /** Route parameter. */
  readonly id = input.required<string>();

  protected readonly statusLabel = TICKET_STATUS_LABEL;
  protected readonly statusTone = TICKET_STATUS_TONE;
  protected readonly priorityLabel = TICKET_PRIORITY_LABEL;
  protected readonly priorityTone = TICKET_PRIORITY_TONE;
  protected readonly typeLabel = TICKET_TYPE_LABEL;
  protected readonly requesterLabel = REQUESTER_LABEL;
  protected readonly orderStatus = ORDER_STATUS_LABEL;
  protected readonly historyLabel = (a: string) => HISTORY_LABEL[a] ?? a;
  /** A history value is a status, a priority, an admin's name or "finance". */
  protected readonly historyValue = (to: string) =>
    TICKET_STATUS_LABEL[to as TicketStatus] ?? TICKET_PRIORITY_LABEL[to as TicketPriority] ?? to;
  protected readonly shownError = shownError;

  protected readonly ticket = rxResource({
    params: () => this.id(),
    stream: ({ params }) => this.api.get(params),
  });
  protected readonly error = resourceError(this.ticket, 'Could not load this ticket.');
  private readonly staffList = rxResource({ stream: () => this.api.staff() });
  protected readonly busy = signal(false);

  protected readonly statusOptions: SelectOption[] = (
    Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]
  ).map((s) => ({ value: s, label: TICKET_STATUS_LABEL[s] }));
  protected readonly priorityOptions: SelectOption[] = (
    Object.keys(TICKET_PRIORITY_LABEL) as TicketPriority[]
  ).map((p) => ({ value: p, label: TICKET_PRIORITY_LABEL[p] }));
  protected readonly assigneeOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'Nobody' },
    ...(this.staffList.hasValue() ? this.staffList.value() : []).map((s) => ({
      value: s.id,
      label: s.name,
    })),
  ]);

  /** Status, priority and assignee, reset to the ticket's values whenever it reloads. */
  protected readonly meta = linkedSignal(() => {
    const t = this.ticket.hasValue() ? this.ticket.value() : null;
    return {
      status: (t?.status ?? 'open') as string,
      priority: (t?.priority ?? 'medium') as string,
      assigneeId: t?.assignee?.id ?? '',
    };
  });
  protected readonly metaForm = form(this.meta);
  protected readonly metaChanged = computed(() => {
    const t = this.ticket.hasValue() ? this.ticket.value() : null;
    const m = this.meta();
    return (
      !!t &&
      (m.status !== t.status || m.priority !== t.priority || m.assigneeId !== (t.assignee?.id ?? ''))
    );
  });

  protected readonly reply = signal({ body: '', internal: false });
  protected readonly replyForm = form(
    this.reply,
    (path) => requiredText(path.body, 'Message', { min: 2, max: 2000 }),
    { submission: { action: () => this.send() } },
  );

  protected saveMeta(): void {
    if (!this.ticket.hasValue()) return;
    const t = this.ticket.value();
    const m = this.meta();
    const change: TicketUpdate = {};
    if (m.status !== t.status) change.status = m.status as TicketStatus;
    if (m.priority !== t.priority) change.priority = m.priority as TicketPriority;
    if (m.assigneeId !== (t.assignee?.id ?? '')) change.assigneeId = m.assigneeId || null;
    this.run(this.api.update(t.id, change), 'Ticket updated');
  }

  protected escalate(): void {
    confirmed(this.dialog, {
      title: 'Escalate to finance?',
      message:
        'The finance team gets a notification with this ticket number and your note. Refunds and payment fixes are done by finance.',
      confirmLabel: 'Escalate',
      reasonLabel: 'What should finance check?',
    }).subscribe((note) =>
      this.run(this.api.escalate(this.id(), String(note)), 'Sent to the finance team'),
    );
  }

  private async send(): Promise<TreeValidationResult> {
    const { body, internal } = this.reply();
    try {
      this.ticket.set(await firstValueFrom(this.api.message(this.id(), body.trim(), internal)));
      this.reply.set({ body: '', internal: false });
      this.replyForm().reset();
      this.notify.success(internal ? 'Note added' : 'Reply sent');
    } catch (err) {
      this.notify.error(errorMessage(err));
    }
    return undefined;
  }

  private run(action: Observable<TicketDetail>, done: string): void {
    this.busy.set(true);
    action.subscribe({
      next: (t) => {
        this.busy.set(false);
        this.ticket.set(t);
        this.notify.success(done);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
