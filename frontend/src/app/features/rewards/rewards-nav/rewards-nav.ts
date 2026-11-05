import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { IconComponent } from 'nexprime';

/** Tabs between the customer's coin wallet, refer & earn and special rewards pages. */
@Component({
  selector: 'bb-rewards-nav',
  imports: [RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './rewards-nav.html',
  styleUrl: './rewards-nav.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RewardsNav {
  protected readonly links = [
    { label: 'My coins', icon: 'coins', link: '/account/coins' },
    { label: 'Refer & earn', icon: 'user-plus', link: '/account/refer' },
    { label: 'Rewards', icon: 'gift', link: '/account/rewards' },
  ];
}
