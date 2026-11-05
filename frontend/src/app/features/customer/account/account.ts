import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Profile } from '../../profile/profile';
import { RewardsNav } from '../../rewards/rewards-nav/rewards-nav';

@Component({
  selector: 'bb-account',
  imports: [Profile, RewardsNav],
  templateUrl: './account.html',
  styleUrl: './account.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Account {}
