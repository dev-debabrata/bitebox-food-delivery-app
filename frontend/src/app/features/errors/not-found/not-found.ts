import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'bb-not-found',
  imports: [RouterLink, MatButtonModule, IconComponent],
  templateUrl: './not-found.html',
  styleUrl: '../error-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotFound {}
