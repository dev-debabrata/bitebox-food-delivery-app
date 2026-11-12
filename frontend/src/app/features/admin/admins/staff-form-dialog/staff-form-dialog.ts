import { DatePipe } from '@angular/common';
import {
  BB_DIALOG_DATA,
  BbDialog,
  BbDialogRef,
  BbDialogTitle,
} from '../../../../shared/dialog/bb-dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, required } from '@angular/forms/signals';
import { ButtonComponent, IconComponent, SelectOption } from 'nexprime';
import { Observable, firstValueFrom } from 'rxjs';
import { AdminStaffService } from '../../../../core/services/admin/admin-staff.service';
import { errorMessage, fieldErrors } from '../../../../core/services/api-error';
import { PhoneInput } from '../../../../shared/components/phone-input/phone-input';
import { serverErrors, shownError } from '../../../../shared/forms/form-errors';
import {
  emailRules,
  passwordRules,
  phoneRules,
  requiredText,
} from '../../../../shared/forms/form-rules';
import { NP_FORM_FIELDS } from '../../../../shared/forms/np-form-fields';
import { STAFF_ROLE_SUMMARY } from '../../../../shared/models/admin-roles.models';
import {
  ROLE_META,
  STAFF_ADMIN_ROLES,
  StaffAdminRole,
  User,
} from '../../../../shared/models/user.models';

/** Create a staff admin (no data) or edit one (their user). Closes with the saved user. */
@Component({
  selector: 'bb-staff-form-dialog',
  imports: [
    DatePipe,
    FormRoot,
    NP_FORM_FIELDS,
    BbDialogTitle,
    ButtonComponent,
    IconComponent,
    PhoneInput,
  ],
  templateUrl: './staff-form-dialog.html',
  styleUrl: './staff-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StaffFormDialog {
  protected readonly user = inject<User | null>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<User>>(BbDialogRef);
  private readonly api = inject(AdminStaffService);
  protected readonly shownError = shownError;
  protected readonly error = signal<string | null>(null);
  protected readonly editing = !!this.user;

  protected readonly roleOptions: SelectOption[] = STAFF_ADMIN_ROLES.map((r) => ({
    value: r,
    label: ROLE_META[r].label,
  }));

  protected readonly model = signal({
    name: this.user?.name ?? '',
    email: this.user?.email ?? '',
    phone: this.user?.phone ?? '',
    password: '',
    role: (this.user?.role as StaffAdminRole | undefined) ?? 'operations_admin',
  });
  protected readonly roleSummary = computed(() => STAFF_ROLE_SUMMARY[this.model().role]);
  protected readonly roleChanged = computed(
    () => this.editing && this.model().role !== this.user?.role,
  );

  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 80 });
      phoneRules(path.phone, { optional: true });
      required(path.role, { message: 'Choose a role' });
      if (!this.editing) {
        emailRules(path.email);
        passwordRules(path.password);
      }
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    this.error.set(null);
    try {
      const saved = this.editing
        ? this.api.update(this.user!.id, { name: v.name.trim(), phone: v.phone, role: v.role })
        : this.api.create({
            name: v.name.trim(),
            email: v.email.trim(),
            phone: v.phone || undefined,
            password: v.password,
            role: v.role,
          });
      this.ref.close(await firstValueFrom(saved));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}

export const openStaffForm = (dialog: BbDialog, user: User | null): Observable<User | undefined> =>
  dialog.open<StaffFormDialog, User | null, User>(StaffFormDialog, { data: user, width: '520px' })
    .closed;
