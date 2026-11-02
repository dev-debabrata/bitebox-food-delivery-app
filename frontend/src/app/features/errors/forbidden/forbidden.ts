import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '../../../core/auth/auth.service';
import { ROLE_META } from '../../../shared/models/user.models';

@Component({
  selector: 'bb-forbidden',
  imports: [RouterLink, MatButtonModule, MatIconModule],
  templateUrl: './forbidden.html',
  styleUrl: '../error-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Forbidden {
  private readonly auth = inject(AuthService);
  protected readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? ROLE_META[role].label.toLowerCase() : 'guest';
  });
  protected readonly home = computed(() => {
    const role = this.auth.role();
    return role ? ROLE_META[role].home : '/';
  });
}
