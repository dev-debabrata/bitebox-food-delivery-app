import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { Router, RouterLink } from '@angular/router';
import { IconComponent, SelectOption } from 'nexprime';
import { SupportService } from '../../../core/services/support.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  TICKET_STATUS_LABEL,
  TICKET_STATUS_TONE,
  TICKET_TYPE_LABEL,
} from '../../../shared/models/admin-roles.models';
import { openNewTicket } from '../new-ticket-dialog/new-ticket-dialog';
import { supportBase } from '../support-base';

/** "Help & support" for customers, restaurants and riders: their tickets and a way to open one. */
@Component({
  selector: 'bb-my-tickets',
  imports: [
    DatePipe,
    RouterLink,
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    IconComponent,
    EmptyState,
    PageHeader,
  ],
  templateUrl: './my-tickets.html',
  styleUrl: './my-tickets.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyTickets {
  private readonly api = inject(SupportService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  protected readonly base = supportBase();
  protected readonly statusLabel = TICKET_STATUS_LABEL;
  protected readonly statusTone = TICKET_STATUS_TONE;
  protected readonly typeLabel = TICKET_TYPE_LABEL;

  /** ?order=BB-… (from an order page) opens the form with the order filled in. */
  readonly order = input<string>();

  protected readonly filterModel = signal({ status: 'open' });
  protected readonly filters = form(this.filterModel);
  protected readonly statusOptions: SelectOption[] = [
    { value: 'open', label: 'Open tickets' },
    { value: 'closed', label: 'Resolved and closed' },
    { value: '', label: 'All tickets' },
  ];

  protected readonly list = pagedList(
    (page, limit) =>
      this.api.mine({
        status: (this.filterModel().status || undefined) as 'open' | 'closed' | undefined,
        page,
        limit,
      }),
    { filterKey: () => this.filterModel().status, errorText: 'Could not load your tickets.' },
  );

  constructor() {
    afterNextRender(() => {
      if (this.order()) this.create(this.order());
    });
  }

  protected create(orderNumber?: string): void {
    openNewTicket(this.dialog, orderNumber ? { orderNumber } : null).subscribe((ticket) => {
      if (ticket) void this.router.navigate([this.base.path(), ticket.id]);
    });
  }
}
