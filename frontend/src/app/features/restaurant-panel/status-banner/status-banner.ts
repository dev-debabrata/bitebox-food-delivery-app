import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Restaurant } from '../../../shared/models/catalog.models';

const COPY = {
  pending: {
    icon: 'hourglass_top',
    tone: 'info',
    title: 'Waiting for approval',
    text: 'Our team is reviewing your restaurant. You can set up your menu meanwhile; customers will see it once you are approved.',
  },
  approved: {
    icon: 'verified',
    tone: 'success',
    title: 'Live on BiteBox',
    text: 'Customers can find your restaurant and browse your menu.',
  },
  rejected: {
    icon: 'report',
    tone: 'error',
    title: 'Application not approved',
    text: 'Update your restaurant details to re-submit for review.',
  },
  suspended: {
    icon: 'block',
    tone: 'error',
    title: 'Restaurant suspended',
    text: 'Your restaurant is hidden from customers. Contact BiteBox support.',
  },
} as const;

@Component({
  selector: 'bb-status-banner',
  imports: [RouterLink, IconComponent, NpIconPipe],
  templateUrl: './status-banner.html',
  styleUrl: './status-banner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBanner {
  readonly restaurant = input.required<Restaurant>();
  readonly showFixLink = input(true);
  protected readonly copy = computed(() => COPY[this.restaurant().status]);
}
