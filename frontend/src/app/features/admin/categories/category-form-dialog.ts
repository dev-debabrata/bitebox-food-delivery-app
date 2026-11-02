import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, maxLength, pattern } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { ToggleComponent } from 'nexprime';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AdminCatalogService } from '../../../core/services/admin/admin-catalog.service';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { FoodCategory } from '../../../shared/models/catalog.models';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { numberRange, requiredText } from '../../../shared/forms/form-rules';

/** A few suggestions; any Material Symbols name works. */
const ICON_SUGGESTIONS = ['restaurant', 'rice_bowl', 'local_pizza', 'lunch_dining', 'ramen_dining', 'soup_kitchen', 'breakfast_dining', 'bakery_dining', 'icecream', 'cake', 'local_cafe', 'local_bar', 'kebab_dining', 'set_meal', 'egg_alt', 'eco'];

@Component({
  selector: 'bb-category-form-dialog',
  imports: [ToggleComponent, NP_FORM_FIELDS, FormRoot, MatDialogModule, MatButtonModule, MatIconModule],
  templateUrl: './category-form-dialog.html',
  styleUrl: './category-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryFormDialog {
  protected readonly data = inject<FoodCategory | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<CategoryFormDialog, FoodCategory>);
  private readonly service = inject(AdminCatalogService);
  protected readonly shownError = shownError;
  protected readonly icons = ICON_SUGGESTIONS;
  protected readonly error = signal<string | null>(null);

  protected readonly model = signal({
    name: this.data?.name ?? '',
    description: this.data?.description ?? '',
    icon: this.data?.icon ?? 'restaurant',
    sortOrder: (this.data?.sortOrder ?? 0) as number | null,
    isActive: this.data?.isActive ?? true,
  });

  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 50 });
      maxLength(path.description, 300, { message: 'Description must be at most 300 characters' });
      pattern(path.icon, /^[a-z0-9_]{1,40}$/, { message: 'Use a Material Symbols name, e.g. local_pizza' });
      numberRange(path.sortOrder, 'Sort order', 0, 10000, { optional: true });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    const input = { ...v, name: v.name.trim(), description: v.description.trim(), sortOrder: Number(v.sortOrder ?? 0) };
    this.error.set(null);
    try {
      const request = this.data ? this.service.updateCategory(this.data.id, input) : this.service.createCategory(input);
      this.ref.close(await firstValueFrom(request));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err));
      return serverErrors(this.form, fieldErrors(err));
    }
  }
}
