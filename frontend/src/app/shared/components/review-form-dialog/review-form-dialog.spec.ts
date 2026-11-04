import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ReviewService } from '../../../core/services/review.service';
import { UploadService } from '../../../core/services/upload.service';
import { MyReview } from '../../models/review.models';
import { ReviewFormDialog } from './review-form-dialog';

const review = (extra: Partial<MyReview> = {}) =>
  ({ id: 'r1', target: 'food', rating: 5, comment: 'Great', images: [], editableUntil: null, ...extra }) as MyReview;

describe('ReviewFormDialog', () => {
  const service = { update: vi.fn() };
  const ref = { close: vi.fn() };

  async function create(r: MyReview) {
    await TestBed.configureTestingModule({
      imports: [ReviewFormDialog],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { subject: 'Garlic Naan', review: r } },
        { provide: MatDialogRef, useValue: ref },
        { provide: ReviewService, useValue: service },
        { provide: UploadService, useValue: { uploadImage: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ReviewFormDialog);
    await fixture.whenStable();
    return fixture;
  }
  type Internals = { model: { set: (v: { rating: number; comment: string }) => void } };
  const submit = async (fixture: Awaited<ReturnType<typeof create>>) => {
    (fixture.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };

  beforeEach(() => {
    service.update.mockReset();
    ref.close.mockReset();
  });

  it('uses the accessible NexPrime star picker, pre-filled and labelled by a legend', async () => {
    const el = (await create(review())).nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('Edit your review');
    expect(el.querySelector('fieldset legend')?.textContent).toContain('How was this dish?');
    const radios = el.querySelectorAll('np-rating [role="radio"]');
    expect(radios.length).toBe(5);
    expect(radios[4].getAttribute('aria-checked')).toBe('true');
  });

  it('saves the changed stars, words and photos', async () => {
    const saved = review({ rating: 2 });
    service.update.mockReturnValue(of(saved));
    const fixture = await create(review());
    (fixture.componentInstance as unknown as Internals).model.set({ rating: 2, comment: '  Cold ' });
    await submit(fixture);
    expect(service.update).toHaveBeenCalledWith('r1', { rating: 2, comment: 'Cold', images: [] });
    expect(ref.close).toHaveBeenCalledWith(saved);
  });

  it('sends no photos for delivery ratings and shows API errors', async () => {
    service.update.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: { success: false, message: 'Reviews can be edited for 30 days after posting' },
          }),
      ),
    );
    const fixture = await create(review({ target: 'rider' }));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('bb-photo-upload')).toBeNull();
    (fixture.componentInstance as unknown as Internals).model.set({ rating: 2, comment: 'Great' });
    await submit(fixture);
    expect(service.update).toHaveBeenCalledWith('r1', { rating: 2, comment: 'Great' });
    expect(ref.close).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('edited for 30 days');
  });
});
