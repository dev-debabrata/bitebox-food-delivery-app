import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { ToggleComponent } from 'nexprime';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { filter } from 'rxjs';
import { AdminCatalogService } from '../../../core/services/admin/admin-catalog.service';
import { errorMessage } from '../../../core/services/api-error';
import { NotificationService } from '../../../core/services/notification.service';
import { ConfirmDialog, ConfirmDialogData } from '../../../shared/components/confirm-dialog/confirm-dialog';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import { FoodCategory } from '../../../shared/models/catalog.models';
import { CategoryFormDialog } from './category-form-dialog';

@Component({
  selector: 'bb-admin-categories',
  imports: [ToggleComponent, MatButtonModule, MatIconModule, MatTooltipModule, EmptyState, PageHeader],
  templateUrl: './admin-categories.html',
  styleUrl: './admin-categories.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminCategories {
  private readonly service = inject(AdminCatalogService);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotificationService);

  protected readonly categories = signal<FoodCategory[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.categories().subscribe({
      next: (list) => {
        this.categories.set(list);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(errorMessage(err, 'Could not load categories.'));
        this.loading.set(false);
      },
    });
  }

  protected open(category?: FoodCategory): void {
    this.dialog
      .open<CategoryFormDialog, FoodCategory | null, FoodCategory>(CategoryFormDialog, { data: category ?? null, width: '520px', maxWidth: '95vw' })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() => {
        this.notify.success(category ? 'Category saved' : 'Category created');
        this.load();
      });
  }

  protected toggle(category: FoodCategory, checked: boolean, toggle: ToggleComponent): void {
    this.service.updateCategory(category.id, { isActive: checked }).subscribe({
      next: (updated) => this.categories.update((list) => list.map((c) => (c.id === updated.id ? { ...c, ...updated } : c))),
      error: (err: unknown) => {
        toggle.checked.set(!checked); // back to what the server has
        this.notify.error(errorMessage(err));
      },
    });
  }

  protected remove(category: FoodCategory): void {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, true>(ConfirmDialog, {
        data: { title: `Delete “${category.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true },
        width: '420px',
      })
      .afterClosed()
      .pipe(filter(Boolean))
      .subscribe(() =>
        this.service.deleteCategory(category.id).subscribe({
          next: () => {
            this.categories.update((list) => list.filter((c) => c.id !== category.id));
            this.notify.success('Category deleted');
          },
          error: (err: unknown) => this.notify.error(errorMessage(err)),
        }),
      );
  }
}
