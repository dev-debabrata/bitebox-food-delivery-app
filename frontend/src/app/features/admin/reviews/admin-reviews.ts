import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatTabsModule } from '@angular/material/tabs';
import { IconComponent, SelectOption } from 'nexprime';
import { ReviewService } from '../../../core/services/review.service';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { ReviewOrderRow } from '../../../shared/components/review-order-row/review-order-row';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { pagedList } from '../../../shared/list/paged-list';
import {
  AdminOrderReviewPage,
  AdminOrderReviews,
  ReviewStatus,
  ReviewTarget,
  RATING_FILTER_OPTIONS,
  STATUS_LABEL,
  TARGET_PLURAL,
} from '../../../shared/models/review.models';
import { openAdminOrderReviews } from './order-dialog/admin-order-reviews-dialog';
import { ReviewAnalyticsPanel } from './review-analytics/review-analytics';

const TABS = ['reported', 'all', 'analytics'] as const;

/** Reviews one row per order (reported orders first in the queue), and rating analytics. */
@Component({
  selector: 'bb-admin-reviews',
  imports: [
    NP_FORM_FIELDS,
    MatButtonModule,
    MatPaginatorModule,
    MatTabsModule,
    IconComponent,
    EmptyState,
    PageHeader,
    ReviewOrderRow,
    ReviewAnalyticsPanel,
  ],
  templateUrl: './admin-reviews.html',
  styleUrl: './admin-reviews.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminReviews {
  private readonly reviews = inject(ReviewService);
  private readonly dialog = inject(MatDialog);

  protected readonly activeTab = signal(0);
  protected readonly tab = computed(() => TABS[this.activeTab()]);

  protected readonly filterModel = signal({ target: '', status: '', rating: '', search: '' });
  protected readonly filters = form(this.filterModel);
  protected readonly targetOptions: SelectOption[] = [
    { value: '', label: 'Restaurants, dishes and riders' },
    ...(Object.keys(TARGET_PLURAL) as ReviewTarget[]).map((t) => ({ value: t, label: TARGET_PLURAL[t] })),
  ];
  protected readonly statusOptions: SelectOption[] = [
    { value: '', label: 'Any status (not deleted)' },
    ...(Object.keys(STATUS_LABEL) as ReviewStatus[]).map((s) => ({
      value: s,
      label: STATUS_LABEL[s],
    })),
  ];
  protected readonly ratingOptions = RATING_FILTER_OPTIONS;

  protected readonly list = pagedList(
    (page, limit) => {
      const f = this.filterModel();
      return this.reviews.adminOrders({
        reported: this.tab() === 'reported' || undefined,
        target: (f.target || undefined) as ReviewTarget | undefined,
        status: (this.tab() === 'all' && f.status ? f.status : undefined) as ReviewStatus | undefined,
        rating: Number(f.rating) || undefined,
        search: f.search.trim() || undefined,
        page,
        limit,
      });
    },
    {
      filterKey: () => `${this.tab()}|${JSON.stringify(this.filterModel())}`,
      pollMs: 60_000,
      when: () => false, // order events don't change reviews; just the slow poll
      errorText: 'Could not load reviews.',
    },
  );

  /** Tab badge; keeps the last count while the list is cleared for a tab switch. */
  protected readonly reportedCount = linkedSignal<AdminOrderReviewPage | null, number | undefined>({
    source: this.list.data,
    computation: (page, previous) => (page ? page.counts?.reported : previous?.value),
  });

  protected selectTab(index: number): void {
    if (index === this.activeTab()) return;
    this.list.clear(); // the other tab's rows would otherwise show, dimmed, until the new list loads
    this.activeTab.set(index);
  }

  protected open(row: AdminOrderReviews): void {
    openAdminOrderReviews(this.dialog, row.order).subscribe(() => this.list.reload());
  }

  protected statusNote(row: AdminOrderReviews): string | null {
    const off = row.reviews.filter((r) => r.status !== 'published');
    if (!off.length) return null;
    return off.length === 1 ? `1 ${STATUS_LABEL[off[0].status].toLowerCase()}` : `${off.length} not public`;
  }
}
