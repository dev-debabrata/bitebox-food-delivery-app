import { TableLabels } from '../../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatPaginatorModule } from '@angular/material/paginator';
import { Router } from '@angular/router';
import { IconComponent, SelectOption } from 'nexprime';
import { SupportDeskService } from '../../../../core/services/support.service';
import { EmptyState } from '../../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { pagedList } from '../../../../shared/list/paged-list';
import {
  REQUESTER_LABEL,
  TICKET_PRIORITY_LABEL,
  TICKET_PRIORITY_TONE,
  TICKET_STATUS_LABEL,
  TICKET_STATUS_TONE,
  TICKET_TYPE_LABEL,
  TicketPriority,
  TicketQuery,
  TicketStatus,
} from '../../../../shared/models/admin-roles.models';

type View = 'all' | 'customer' | 'restaurant' | 'delivery' | 'refunds' | 'mine' | 'unassigned';

/** Each queue in the sidebar is the same list with a fixed filter. */
const VIEWS: Record<View, { title: string; subtitle: string; query: TicketQuery }> = {
  all: { title: 'All support tickets', subtitle: 'Every ticket, most recent activity first.', query: {} },
  customer: {
    title: 'Customer complaints',
    subtitle: 'Tickets raised by customers.',
    query: { requesterRole: 'customer' },
  },
  restaurant: {
    title: 'Restaurant complaints',
    subtitle: 'Tickets raised by restaurant partners.',
    query: { requesterRole: 'restaurant' },
  },
  delivery: {
    title: 'Delivery partner complaints',
    subtitle: 'Tickets raised by riders.',
    query: { requesterRole: 'delivery' },
  },
  refunds: {
    title: 'Refund requests',
    subtitle: 'Refund tickets. Escalate the ones finance needs to act on.',
    query: { type: 'refund' },
  },
  mine: { title: 'My tickets', subtitle: 'Tickets assigned to you.', query: { assignee: 'me' } },
  unassigned: {
    title: 'Not assigned',
    subtitle: 'Nobody owns these yet. Reply to one to take it.',
    query: { assignee: 'unassigned' },
  },
};

@Component({
  selector: 'bb-support-tickets',
  imports: [
    TableLabels,DatePipe, NP_FORM_FIELDS, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './support-tickets.html',
  styleUrl: './support-tickets.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportTickets {
  private readonly api = inject(SupportDeskService);
  private readonly router = inject(Router);

  /** Route parameter. */
  readonly view = input<View>('all');
  protected readonly config = computed(() => VIEWS[this.view()] ?? VIEWS.all);

  protected readonly statusLabel = TICKET_STATUS_LABEL;
  protected readonly statusTone = TICKET_STATUS_TONE;
  protected readonly priorityLabel = TICKET_PRIORITY_LABEL;
  protected readonly priorityTone = TICKET_PRIORITY_TONE;
  protected readonly typeLabel = TICKET_TYPE_LABEL;
  protected readonly requesterLabel = REQUESTER_LABEL;

  protected readonly filterModel = signal({ search: '', status: 'active', priority: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: 'active', label: 'Not resolved yet' },
    { value: '', label: 'Any status' },
    ...(Object.keys(TICKET_STATUS_LABEL) as TicketStatus[]).map((s) => ({
      value: s,
      label: TICKET_STATUS_LABEL[s],
    })),
  ];
  protected readonly priorityOptions: SelectOption[] = [
    { value: '', label: 'Any priority' },
    ...(Object.keys(TICKET_PRIORITY_LABEL) as TicketPriority[]).map((p) => ({
      value: p,
      label: TICKET_PRIORITY_LABEL[p],
    })),
  ];

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.list({
        ...this.config().query,
        status: (f.status || undefined) as TicketQuery['status'],
        priority: (f.priority || undefined) as TicketPriority | undefined,
        search: f.search.trim() || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => `${this.view()}|${JSON.stringify(this.filterModel())}`,
      pollMs: 60_000,
      when: () => false,
      errorText: 'Could not load tickets.',
    },
  );

  protected open(id: string): void {
    void this.router.navigate(['/admin/support/ticket', id]);
  }
}
