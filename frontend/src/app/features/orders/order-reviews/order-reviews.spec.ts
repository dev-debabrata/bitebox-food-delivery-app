import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ReviewService } from '../../../core/services/review.service';
import { MyReview, OrderReviewState } from '../../../shared/models/review.models';
import { OrderReviews } from './order-reviews';

const mine = (id: string, rating: number, extra: Partial<MyReview> = {}) =>
  ({
    id,
    target: 'restaurant',
    rating,
    comment: '',
    images: [],
    status: 'published',
    createdAt: '2026-11-04T10:00:00Z',
    editableUntil: new Date(Date.now() + 86_400_000).toISOString(),
    moderation: null,
    response: null,
    ...extra,
  }) as MyReview;

const base: OrderReviewState = {
  orderId: 'o1',
  canReview: true,
  reason: null,
  closesAt: new Date().toISOString(),
  restaurant: { id: 'x', name: 'Spice Route Kitchen', review: null },
  items: [{ foodItem: 'f1', name: 'Garlic Naan', review: null }],
  rider: { review: null },
};

describe('OrderReviews', () => {
  async function render(state: OrderReviewState) {
    await TestBed.configureTestingModule({
      imports: [OrderReviews],
      providers: [provideRouter([]), { provide: ReviewService, useValue: { forOrder: () => of(state) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(OrderReviews);
    fixture.componentRef.setInput('orderId', 'o1');
    fixture.componentRef.setInput('orderNumber', 'BB-1');
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }
  const buttons = (el: HTMLElement) => Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());

  it('asks "How was your order?" before anything is rated', async () => {
    const el = await render(base);
    expect(el.querySelector('#prompt-title')?.textContent).toContain('How was your order?');
    expect(buttons(el)).toEqual(['Rate your experience']);
  });

  it('shows all ratings as one summary with a single button', async () => {
    const el = await render({
      ...base,
      restaurant: { ...base.restaurant, review: mine('r1', 4, { comment: 'All over is good.', images: ['a.png'] }) },
      items: [{ foodItem: 'f1', name: 'Garlic Naan', review: mine('r2', 4, { target: 'food', foodName: 'Garlic Naan' }) }],
      rider: { review: mine('r3', 5, { target: 'rider' }) },
    });
    expect(el.querySelector('#rated-title')?.textContent).toContain('Your ratings');
    expect(el.querySelectorAll('bb-review-order-row .chip').length).toBe(3);
    expect(el.textContent).toContain('All over is good.');
    expect(buttons(el)).toEqual(['View & edit']); // one button, no per-row edit/delete
  });

  it('offers to rate the rest, and only views when nothing can change', async () => {
    let el = await render({ ...base, restaurant: { ...base.restaurant, review: mine('r1', 4) } });
    expect(buttons(el)).toEqual(['Rate the rest']);
    TestBed.resetTestingModule();
    el = await render({
      ...base,
      canReview: false,
      reason: 'Reviews can be written up to 30 days after delivery',
      restaurant: { ...base.restaurant, review: mine('r1', 4, { editableUntil: null }) },
    });
    expect(buttons(el)).toEqual(['View']);
  });

  it("shows the restaurant's replies under the ratings", async () => {
    const reply = { text: 'Thanks, see you again!', respondedAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z' };
    const el = await render({
      ...base,
      restaurant: { ...base.restaurant, review: mine('r1', 5, { response: reply }) },
      items: [{ foodItem: 'f1', name: 'Garlic Naan', review: mine('r2', 3, { target: 'food', foodName: 'Garlic Naan' }) }],
    });
    const replies = el.querySelectorAll('bb-review-reply');
    expect(replies.length).toBe(1);
    expect(replies[0].textContent).toContain('Spice Route Kitchen replied');
    expect(replies[0].textContent).toContain('to your review');
    expect(replies[0].textContent).toContain('Thanks, see you again!');
  });
});
