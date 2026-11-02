import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Profile } from '../../profile/profile';

@Component({
  selector: 'bb-account',
  imports: [Profile],
  templateUrl: './account.html',
  styleUrl: './account.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Account {}
