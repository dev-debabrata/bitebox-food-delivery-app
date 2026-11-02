import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../../core/auth/auth.service';

export interface UpcomingModule {
  icon: string;
  title: string;
  text: string;
}

@Component({
  selector: 'bb-panel-welcome',
  imports: [DatePipe, RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './panel-welcome.html',
  styleUrl: './panel-welcome.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanelWelcome {
  readonly intro = input.required<string>();
  readonly profileLink = input.required<string>();
  readonly upcoming = input.required<UpcomingModule[]>();

  protected readonly user = inject(AuthService).user;
  protected readonly firstName = computed(() => this.user()?.name.split(' ')[0] ?? '');
}
