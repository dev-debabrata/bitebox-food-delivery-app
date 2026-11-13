import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from 'nexprime';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/services/api-error';
import { ADMIN_ROLES, Role } from '../../../shared/models/user.models';

/** Where each role edits its profile (and asks for a new link). */
export const profileUrl = (role: Role): string =>
  role === 'customer'
    ? '/account'
    : (ADMIN_ROLES as readonly Role[]).includes(role)
      ? '/admin/profile'
      : `/${role}/profile`;

/** Opened from the email link (/verify-email?token=…): confirms the address once. */
@Component({
  selector: 'bb-verify-email',
  imports: [RouterLink, IconComponent],
  templateUrl: './verify-email.html',
  styleUrl: './verify-email.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmail {
  private readonly auth = inject(AuthService);
  readonly token = input<string>();

  protected readonly state = signal<'working' | 'done' | 'failed'>('working');
  protected readonly message = signal('');
  protected readonly profile = computed(() => {
    const role = this.auth.role();
    return role ? profileUrl(role) : null;
  });

  constructor() {
    // In the browser only: the token works once, and a server render must not use it up.
    afterNextRender(() => void this.verify());
  }

  private async verify(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.state.set('failed');
      this.message.set('This link is incomplete. Open the link from the email again.');
      return;
    }
    try {
      this.message.set(await firstValueFrom(this.auth.verifyEmail(token)));
      this.state.set('done');
    } catch (err) {
      this.message.set(errorMessage(err, 'This link is invalid or has expired.'));
      this.state.set('failed');
    }
  }
}
