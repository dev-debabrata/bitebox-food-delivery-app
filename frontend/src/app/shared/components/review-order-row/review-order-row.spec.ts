import { TestBed } from '@angular/core/testing';
import { ReviewOrderRow, RowReview } from './review-order-row';

describe('ReviewOrderRow', () => {
  async function render(reviews: RowReview[]) {
    const fixture = TestBed.createComponent(ReviewOrderRow);
    fixture.componentRef.setInput('orderNumber', 'BB-1');
    fixture.componentRef.setInput('author', 'Debabrata D.');
    fixture.componentRef.setInput('date', '2026-11-04T10:00:00Z');
    fixture.componentRef.setInput('reviews', reviews);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('shows one chip per rated thing, the comment and the photos of the order', async () => {
    const el = await render([
      { id: '1', target: 'restaurant', rating: 4, comment: 'All over is good.', images: ['a.png', 'b.png'] },
      { id: '2', target: 'food', rating: 5, comment: '', foodName: 'Paneer Tikka Biryani' },
      { id: '3', target: 'rider', rating: 5, comment: '', status: 'hidden' },
    ]);
    expect(el.textContent).toContain('Order BB-1');
    expect(el.textContent).toContain('Debabrata D.');
    const chips = Array.from(el.querySelectorAll('.chip')).map((c) => [
      c.querySelector('.chip-label')?.textContent?.trim(),
      c.querySelector('.chip-score')?.textContent?.trim(),
    ]);
    expect(chips).toEqual([
      ['Restaurant', '4'],
      ['Paneer Tikka Biryani', '5'],
      ['Delivery', '5'],
    ]);
    expect(el.querySelectorAll('.chip.muted').length).toBe(1);
    expect(el.querySelector('.comment')?.textContent).toContain('All over is good.');
    expect(el.querySelectorAll('.thumbs img').length).toBe(2);
    expect(el.querySelector('.thumbs .bb-sr-only')?.textContent).toContain('2 photos');
  });
});
