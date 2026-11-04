import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { IconComponent } from 'nexprime';
import { ReviewService } from '../../../../core/services/review.service';
import { DailyChart, SERIES_COLORS } from '../../../../shared/components/daily-chart/daily-chart';
import { RatingSummary } from '../../../../shared/components/rating-summary/rating-summary';
import { StatTile } from '../../../../shared/components/stat-tile/stat-tile';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { periodReport } from '../../../../shared/list/period-report';
import {
  REPORT_REASON_LABEL,
  ReviewTarget,
  TARGET_PLURAL,
  formatAverage,
} from '../../../../shared/models/review.models';

/** Rating analytics: per-subject averages, daily trend, reports, moderation and rankings. */
@Component({
  selector: 'bb-review-analytics',
  imports: [DecimalPipe, NP_FORM_FIELDS, IconComponent, DailyChart, RatingSummary, StatTile],
  templateUrl: './review-analytics.html',
  styleUrl: './review-analytics.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewAnalyticsPanel {
  private readonly reviews = inject(ReviewService);

  protected readonly report = periodReport(
    (days) => this.reviews.analytics(days),
    'Could not load rating analytics.',
  );
  protected readonly targets: ReviewTarget[] = ['restaurant', 'food', 'rider'];
  protected readonly targetLabel = TARGET_PLURAL;
  protected readonly reasonLabel = REPORT_REASON_LABEL;
  protected readonly average = formatAverage;
  protected readonly barColor = SERIES_COLORS[0];
  protected readonly count = (v: number) => String(v);
  protected readonly stars = (v: number) => v.toFixed(1);
  protected readonly published = (n: number, noun = 'review') =>
    `${n} published ${noun}${n === 1 ? '' : 's'}`;

  protected readonly dates = computed(() => this.report.data()?.daily.map((d) => d.date) ?? []);
  protected readonly volume = computed(() => [
    { label: 'Reviews', values: this.report.data()?.daily.map((d) => d.reviews) ?? [] },
  ]);
  protected readonly trend = computed(() => [
    { label: 'Average rating', values: this.report.data()?.daily.map((d) => d.averageRating) ?? [] },
  ]);
  protected readonly reportTotal = computed(() =>
    (this.report.data()?.reportReasons ?? []).reduce((n, r) => n + r.count, 0),
  );
  protected readonly moderated = computed(() => {
    const m = this.report.data()?.moderationActions ?? {};
    return (m.hide ?? 0) + (m.remove ?? 0);
  });
  protected readonly rankings = computed(() => {
    const d = this.report.data();
    if (!d) return [];
    return [
      { title: 'Best-rated restaurants', rows: d.restaurants.top },
      { title: 'Lowest-rated restaurants', rows: d.restaurants.bottom },
      { title: 'Best-rated riders', rows: d.riders.top },
      { title: 'Lowest-rated riders', rows: d.riders.bottom },
    ];
  });
}
