import { TableLabels } from '../../../shared/list/table-labels';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatPaginatorModule } from '@angular/material/paginator';
import { IconComponent, SelectOption } from 'nexprime';
import { AdminStaffService } from '../../../core/services/admin/admin-staff.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import { ADMIN_ROLES, AdminRole, ROLE_META } from '../../../shared/models/user.models';

/** Labels for the actions the API records (services/audit.service.js callers). */
const ACTIONS: Record<string, string> = {
  'admin.create': 'Admin created',
  'admin.update': 'Admin updated',
  'admin.status': 'Admin (de)activated',
  'user.status': 'Account suspended / reactivated',
  'restaurant.status': 'Restaurant approval',
  'food.delete': 'Menu item deleted',
  'category.delete': 'Category deleted',
  'order.cancel': 'Order cancelled',
  'order.unassign': 'Rider unassigned',
  'rider.status': 'Rider status',
  'payment.refund': 'Refund retried',
  'payout.create': 'Payout created',
  'payout.paid': 'Payout paid',
  'payout.cancel': 'Payout cancelled',
  'review.moderate': 'Review moderated',
  'ticket.update': 'Ticket updated',
  'ticket.escalate': 'Ticket escalated',
};

@Component({
  selector: 'bb-audit-log',
  imports: [
    TableLabels,DatePipe, NP_FORM_FIELDS, MatPaginatorModule, IconComponent, EmptyState, PageHeader],
  templateUrl: './audit-log.html',
  styleUrl: './audit-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditLogPage {
  private readonly api = inject(AdminStaffService);
  protected readonly actionLabel = (a: string) => ACTIONS[a] ?? a;
  protected readonly roleLabel = (r: AdminRole) => ROLE_META[r]?.label ?? r;

  protected readonly filterModel = signal({ search: '', action: '', role: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly actionOptions: SelectOption[] = [
    { value: '', label: 'All actions' },
    ...Object.entries(ACTIONS).map(([value, label]) => ({ value, label })),
  ];
  protected readonly roleOptions: SelectOption[] = [
    { value: '', label: 'All admin roles' },
    ...ADMIN_ROLES.map((r) => ({ value: r, label: ROLE_META[r].label })),
  ];

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.api.auditLog({
        search: f.search.trim() || undefined,
        action: f.action || undefined,
        role: f.role || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => JSON.stringify(this.filterModel()),
      limit: 50,
      errorText: 'Could not load the audit log.',
    },
  );
}
