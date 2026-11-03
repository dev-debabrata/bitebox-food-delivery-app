import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormRoot, TreeValidationResult, form, required } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage, fieldErrors } from '../../core/services/api-error';
import { NotificationService } from '../../core/services/notification.service';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { ROLE_META } from '../../shared/models/user.models';
import { serverErrors, shownError } from '../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../shared/forms/np-form-fields';
import { matchesField, passwordRules, phoneRules, requiredText } from '../../shared/forms/form-rules';
import { PhoneInput } from '../../shared/components/phone-input/phone-input';

/** Profile details + change password. Shared by every panel. */
@Component({
  selector: 'bb-profile',
  imports: [
    PhoneInput,
    NP_FORM_FIELDS,
    DatePipe,
    FormRoot,
    MatButtonModule,
    IconComponent,
    MatProgressSpinnerModule,
    PageHeader,
    ],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Profile {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly user = this.auth.user;
  protected readonly roleLabel = computed(() => {
    const role = this.user()?.role;
    return role ? ROLE_META[role].label : '';
  });

  // Personal details
  protected readonly profileModel = signal({ name: '', phone: '' });
  protected readonly profileForm = form(
    this.profileModel,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 80 });
      phoneRules(path.phone, { optional: true });
    },
    { submission: { action: () => this.saveProfile() } },
  );

  // Change password
  protected readonly passwordModel = signal({ currentPassword: '', newPassword: '', confirmPassword: '' });
  protected readonly passwordForm = form(
    this.passwordModel,
    (path) => {
      required(path.currentPassword, { message: 'Current password is required' });
      passwordRules(path.newPassword, 'New password');
      matchesField(path.confirmPassword, path.newPassword);
    },
    { submission: { action: () => this.changePassword() } },
  );

  protected readonly profileError = signal<string | null>(null);
  protected readonly passwordError = signal<string | null>(null);
  protected readonly shownError = shownError;

  constructor() {
    // Keep the form in sync with the signed-in user (e.g. after session restore), unless being edited.
    effect(() => {
      const user = this.user();
      if (user && !untracked(() => this.profileForm().dirty())) {
        untracked(() => this.profileForm().reset({ name: user.name, phone: user.phone ?? '' }));
      }
    });
  }

  private async saveProfile(): Promise<TreeValidationResult> {
    this.profileError.set(null);
    try {
      const user = await firstValueFrom(this.auth.updateProfile(this.profileModel()));
      this.profileForm().reset({ name: user.name, phone: user.phone ?? '' });
      this.notify.success('Profile updated');
      return undefined;
    } catch (err) {
      this.profileError.set(errorMessage(err));
      return serverErrors(this.profileForm, fieldErrors(err));
    }
  }

  private async changePassword(): Promise<TreeValidationResult> {
    this.passwordError.set(null);
    const { currentPassword, newPassword } = this.passwordModel();
    try {
      this.notify.success(await firstValueFrom(this.auth.changePassword({ currentPassword, newPassword })));
      return undefined;
    } catch (err) {
      this.passwordError.set(errorMessage(err));
      return serverErrors(this.passwordForm, fieldErrors(err));
    }
  }
}
