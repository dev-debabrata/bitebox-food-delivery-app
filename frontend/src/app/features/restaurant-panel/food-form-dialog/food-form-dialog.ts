import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormRoot, TreeValidationResult, form, maxLength, required } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { errorMessage, fieldErrors } from '../../../core/services/api-error';
import { MyRestaurantService } from '../../../core/services/my-restaurant.service';
import { ImageUpload } from '../../../shared/components/image-upload/image-upload';
import { FoodCategory, FoodItem, FoodItemInput, categoryIdOf } from '../../../shared/models/catalog.models';
import { rupeesToPaise } from '../../../shared/pipes/money.pipes';
import { serverErrors, shownError } from '../../../shared/forms/form-errors';
import { SelectOption, ToggleComponent } from 'nexprime';
import { NP_FORM_FIELDS } from '../../../shared/forms/np-form-fields';
import { numberRange, requiredText } from '../../../shared/forms/form-rules';

export interface FoodFormData {
  item?: FoodItem;
  categories: FoodCategory[];
}

/** Add or edit a menu item. Closes with the saved item. */
@Component({
  selector: 'bb-food-form-dialog',
  imports: [
    ToggleComponent,
    NP_FORM_FIELDS,
    FormRoot,
    MatDialogModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ImageUpload,
  ],
  templateUrl: './food-form-dialog.html',
  styleUrl: './food-form-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodFormDialog {
  protected readonly data = inject<FoodFormData>(MAT_DIALOG_DATA);
  protected readonly categoryOptions: SelectOption[] = this.data.categories.map((c) => ({ value: c.id, label: c.name }));
  private readonly ref = inject(MatDialogRef<FoodFormDialog, FoodItem>);
  private readonly service = inject(MyRestaurantService);
  protected readonly shownError = shownError;

  protected readonly error = signal<string | null>(null);
  protected readonly imageUrl = signal(this.data.item?.imageUrl ?? '');

  /** Price is typed in rupees and sent to the API as integer paise. */
  protected readonly model = signal({
    name: this.data.item?.name ?? '',
    category: this.data.item ? categoryIdOf(this.data.item) : '',
    price: this.data.item ? this.data.item.pricePaise / 100 : (null as number | null),
    description: this.data.item?.description ?? '',
    isVeg: this.data.item?.isVeg ?? true,
    prepTimeMinutes: this.data.item?.prepTimeMinutes ?? (null as number | null),
    isAvailable: this.data.item?.isAvailable ?? true,
  });

  protected readonly form = form(
    this.model,
    (path) => {
      requiredText(path.name, 'Name', { min: 2, max: 100 });
      required(path.category, { message: 'Choose a category' });
      numberRange(path.price, 'Price', 1, 100000);
      maxLength(path.description, 500, { message: 'Description must be at most 500 characters' });
      numberRange(path.prepTimeMinutes, 'Prep time', 1, 180, { optional: true });
    },
    { submission: { action: () => this.save() } },
  );

  private async save(): Promise<TreeValidationResult> {
    const v = this.model();
    const input: FoodItemInput = {
      name: v.name.trim(),
      category: v.category,
      pricePaise: rupeesToPaise(Number(v.price)),
      description: v.description.trim(),
      isVeg: v.isVeg,
      isAvailable: v.isAvailable,
      imageUrl: this.imageUrl(),
      prepTimeMinutes: v.prepTimeMinutes ? Number(v.prepTimeMinutes) : null,
    };
    this.error.set(null);
    try {
      const request = this.data.item ? this.service.updateFood(this.data.item.id, input) : this.service.createFood(input);
      this.ref.close(await firstValueFrom(request));
      return undefined;
    } catch (err) {
      this.error.set(errorMessage(err, 'Could not save this dish.'));
      // The API reports the price as "pricePaise"; show it under the Price field.
      return serverErrors(this.form, fieldErrors(err).map((e) => (e.field === 'pricePaise' ? { ...e, field: 'price' } : e)));
    }
  }
}
