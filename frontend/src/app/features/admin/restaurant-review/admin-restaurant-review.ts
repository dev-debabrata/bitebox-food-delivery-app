import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { filter } from 'rxjs';
import { AdminCatalogService } from '../../../core/services/admin/admin-catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { AdminRestaurant, MenuStats, RestaurantStatus } from '../../../shared/models/catalog.models';
import { InrPipe } from '../../../shared/pipes/money.pipes';

interface StatusAction {
  status: RestaurantStatus;
  label: string;
  icon: string;
  needsReason: boolean;
  danger: boolean;
}

/** Mirrors the backend ADMIN_STATUS_TRANSITIONS table (the API enforces it). */
const ACTIONS: Record<RestaurantStatus, StatusAction[]> = {
  pending: [
    { status: 'approved', label: 'Approve', icon: 'check_circle', needsReason: false, danger: false },
    { status: 'rejected', label: 'Reject', icon: 'cancel', needsReason: true, danger: true },
  ],
  approved: [{ status: 'suspended', label: 'Suspend', icon: 'block', needsReason: true, danger: true }],
  suspended: [{ status: 'approved', label: 'Reinstate', icon: 'restart_alt', needsReason: false, danger: false }],
  rejected: [{ status: 'approved', label: 'Approve anyway', icon: 'check_circle', needsReason: false, danger: false }],
};

@Component({
  selector: 'bb-admin-restaurant-review',
  imports: [DatePipe, RouterLink, MatButtonModule, IconComponent, NpIconPipe, EmptyState, InrPipe],
  templateUrl: './admin-restaurant-review.html',
  styleUrl: './admin-restaurant-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminRestaurantReview {
  private readonly service = inject(AdminCatalogService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  readonly id = input.required<string>();

  protected readonly restaurant = signal<AdminRestaurant | null>(null);
  protected readonly stats = signal<MenuStats | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly acting = signal(false);

  protected readonly actions = computed(() => {
    const r = this.restaurant();
    return r ? ACTIONS[r.status] : [];
  });
  protected readonly mapLink = computed(() => {
    const r = this.restaurant();
    if (!r) return null;
    const [lng, lat] = r.location.coordinates;
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });
  }

  protected load(id = this.id()): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.restaurant(id).subscribe({
      next: ({ restaurant, stats }) => {
        this.restaurant.set(restaurant);
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 422)) this.notFound.set(true);
        else this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  protected act(action: StatusAction): void {
    const r = this.restaurant();
    if (!r) return;
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true | string>(ConfirmDialog, {
        data: {
          title: `${action.label} ${r.name}?`,
          message:
            action.status === 'approved'
              ? 'The restaurant will become visible to customers.'
              : 'The restaurant will be hidden from customers. The owner will see your reason.',
          confirmLabel: action.label,
          danger: action.danger,
          reasonLabel: action.needsReason ? 'Reason (shown to the restaurant owner)' : undefined,
        },
        width: '460px',
        maxWidth: '95vw',
      })
      .afterClosed()
      .pipe(filter((result): result is true | string => !!result))
      .subscribe((result) => {
        this.acting.set(true);
        const reason = typeof result === 'string' ? result : undefined;
        this.service.setRestaurantStatus(r.id, action.status, reason).subscribe({
          next: (updated) => {
            this.restaurant.set(updated);
            this.notify.success(`${updated.name} is now ${updated.status}`);
            this.acting.set(false);
          },
          error: (err: unknown) => {
            this.notify.error(errorMessage(err));
            this.acting.set(false);
            // Someone else may have changed it (409): show the current state.
            if (err instanceof HttpErrorResponse && err.status === 409) this.load();
          },
        });
      });
  }
}
