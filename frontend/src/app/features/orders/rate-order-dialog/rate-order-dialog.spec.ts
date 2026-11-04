import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { of } from 'rxjs';
import { ReviewService } from '../../../core/services/review.service';
import { UploadService } from '../../../core/services/upload.service';
import { MyReview, OrderReviewState } from '../../../shared/models/review.models';
import { RateOrderDialog } from './rate-order-dialog';

const future = () => new Date(Date.now() + 86_400_000).toISOString();
const mine = (id: string, rating: number, extra: Partial<MyReview> = {}) =>
  ({ id, rating, comment: '', images: [], status: 'published', editableUntil: future(), ...extra }) as MyReview;

const fresh: OrderReviewState = {
  orderId: 'o1',
  canReview: true,
  reason: null,
  closesAt: future(),
  restaurant: { id: 'x', name: 'Spice Route Kitchen', review: null },
  items: [
    { foodItem: 'f1', name: 'Garlic Naan', review: null },
    { foodItem: 'f2', name: 'Dal Makhani', review: null },
  ],
  rider: { review: null },
};

describe('RateOrderDialog', () => {
  const service = { rateOrder: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), forOrder: vi.fn() };
  const ref = { close: vi.fn() };

  async function create(state: OrderReviewState) {
    await TestBed.configureTestingModule({
      imports: [RateOrderDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { state, orderNumber: 'BB-1', riderName: 'Ravi Rider' } },
        { provide: MatDialogRef, useValue: ref },
        { provide: ReviewService, useValue: service },
        { provide: UploadService, useValue: { uploadImage: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(RateOrderDialog);
    await fixture.whenStable();
    return fixture;
  }
  type Internals = {
    model: { set: (v: { ratings: number[]; comment: string }) => void };
    photos: { set: (v: string[]) => void };
  };
  const submit = async (fixture: Awaited<ReturnType<typeof create>>) => {
    (fixture.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };
  const titles = (el: HTMLElement) => Array.from(el.querySelectorAll('.row-title')).map((t) => t.textContent?.trim());

  beforeEach(() => {
    Object.values(service).forEach((f) => f.mockReset());
    ref.close.mockReset();
    service.forOrder.mockReturnValue(of(fresh));
  });

  it('rates the first time with one Food quality row, in one request', async () => {
    const fixture = await create(fresh);
    const el = fixture.nativeElement as HTMLElement;
    expect(titles(el)).toEqual(['Restaurant', 'Food quality', 'Delivery partner']);
    expect(el.querySelector('.title')?.textContent).toContain('Rate your experience');

    await submit(fixture);
    expect(service.rateOrder).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('at least one');

    service.rateOrder.mockReturnValue(of(fresh));
    const c = fixture.componentInstance as unknown as Internals;
    c.model.set({ ratings: [4, 5, 3], comment: ' Lovely ' });
    c.photos.set(['http://localhost:5000/uploads/images/a.png']);
    await submit(fixture);
    expect(service.rateOrder).toHaveBeenCalledWith('o1', {
      restaurant: 4,
      food: 5,
      rider: 3,
      comment: 'Lovely',
      images: ['http://localhost:5000/uploads/images/a.png'],
    });
    expect(ref.close).toHaveBeenCalledWith(fresh);
  });

  it('edits everything in the same dialog: rows per dish, changed ratings and words', async () => {
    const rated: OrderReviewState = {
      ...fresh,
      restaurant: { ...fresh.restaurant, review: mine('r1', 4, { comment: 'Good', images: ['a.png'] }) },
      items: [
        { foodItem: 'f1', name: 'Garlic Naan', review: mine('r2', 4) },
        { foodItem: 'f2', name: 'Dal Makhani', review: null },
      ],
      rider: { review: mine('r3', 5) },
    };
    service.update.mockReturnValue(of({}));
    service.create.mockReturnValue(of({}));
    const fixture = await create(rated);
    const el = fixture.nativeElement as HTMLElement;
    expect(titles(el)).toEqual(['Restaurant', 'Garlic Naan', 'Dal Makhani', 'Delivery partner']);
    expect(el.querySelectorAll('[aria-label^="Delete your rating of"]').length).toBe(3);
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Save changes');

    (fixture.componentInstance as unknown as Internals).model.set({ ratings: [5, 4, 3, 5], comment: 'Great' });
    await submit(fixture);
    expect(service.update).toHaveBeenCalledWith('r1', { rating: 5, comment: 'Great' });
    expect(service.update).toHaveBeenCalledTimes(1); // unchanged ratings are not sent
    expect(service.create).toHaveBeenCalledWith({ orderId: 'o1', target: 'food', foodItemId: 'f2', rating: 3 });
    expect(ref.close).toHaveBeenCalled();
  });

  it('shows moderated ratings read-only with the reason', async () => {
    const fixture = await create({
      ...fresh,
      restaurant: {
        ...fresh.restaurant,
        review: mine('r1', 1, { status: 'hidden', moderation: { action: 'hide', reason: 'Phone number' } }),
      },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.lock-note')?.textContent).toContain('Hidden by moderators: Phone number');
    expect(el.querySelector('fieldset.locked np-rating')).toBeNull();
  });
});
