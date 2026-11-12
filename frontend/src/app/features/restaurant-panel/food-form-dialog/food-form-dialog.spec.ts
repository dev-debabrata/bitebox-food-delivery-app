import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { MyRestaurantService } from '../../../core/services/my-restaurant.service';
import { UploadService } from '../../../core/services/upload.service';
import { FoodItem } from '../../../shared/models/catalog.models';
import { FoodFormDialog } from './food-form-dialog';

describe('FoodFormDialog', () => {
  const service = { createFood: vi.fn(), updateFood: vi.fn() };
  const ref = { close: vi.fn() };

  async function create(item?: FoodItem) {
    await TestBed.configureTestingModule({
      imports: [FoodFormDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { item, categories: [{ id: 'c1', name: 'Pizza', icon: 'local_pizza' }] } },
        { provide: MatDialogRef, useValue: ref },
        { provide: MyRestaurantService, useValue: service },
        { provide: UploadService, useValue: { validate: () => null, uploadImage: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(FoodFormDialog);
    await fixture.whenStable();
    return fixture;
  }

  beforeEach(() => {
    service.createFood.mockReset();
    service.updateFood.mockReset();
    ref.close.mockReset();
  });

  type Internals = {
    model: { set: (v: unknown) => void; (): { price: number | null; category: string } };
  };
  const submit = async (fixture: Awaited<ReturnType<typeof create>>) => {
    (fixture.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };

  it('does not submit an invalid form and shows the errors', async () => {
    const fixture = await create();
    await submit(fixture);
    expect(service.createFood).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Choose a category');
  });

  it('sends the price as integer paise and closes with the saved item', async () => {
    const saved = { id: 'f1', name: 'Margherita' } as FoodItem;
    service.createFood.mockReturnValue(of(saved));
    const fixture = await create();
    (fixture.componentInstance as unknown as Internals).model.set({
      name: ' Margherita ',
      category: 'c1',
      price: 249.99,
      description: '',
      isVeg: true,
      prepTimeMinutes: null,
      isAvailable: true,
    });
    await submit(fixture);
    expect(service.createFood).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Margherita', category: 'c1', pricePaise: 24999, isVeg: true }),
    );
    expect(ref.close).toHaveBeenCalledWith(saved);
  });

  it('pre-fills rupees from paise when editing', async () => {
    const item = { id: 'f1', name: 'Naan', pricePaise: 6900, isVeg: true, isAvailable: true, category: { id: 'c1', name: 'Pizza', slug: 'pizza', icon: 'x' } } as FoodItem;
    const fixture = await create(item);
    const model = (fixture.componentInstance as unknown as Internals).model();
    expect(model.price).toBe(69);
    expect(model.category).toBe('c1');
  });
});
