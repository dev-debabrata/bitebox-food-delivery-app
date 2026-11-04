import { TestBed } from '@angular/core/testing';
import { RatingSummary } from './rating-summary';

describe('RatingSummary', () => {
  async function render(filterable = false) {
    const fixture = TestBed.createComponent(RatingSummary);
    fixture.componentRef.setInput('summary', {
      average: 3.5,
      count: 4,
      distribution: [1, 0, 0, 2, 1],
    });
    fixture.componentRef.setInput('filterable', filterable);
    await fixture.whenStable();
    return fixture;
  }

  it('shows the average, the count and the 5-to-1 breakdown', async () => {
    const el = (await render()).nativeElement as HTMLElement;
    expect(el.querySelector('.average')?.textContent).toBe('3.5');
    expect(el.textContent).toContain('4 reviews');
    const spoken = Array.from(el.querySelectorAll('.bb-sr-only')).map((s) => s.textContent?.trim());
    expect(spoken).toEqual([
      '5 star: 1 review, 25%',
      '4 star: 2 reviews, 50%',
      '3 star: 0 reviews, 0%',
      '2 star: 0 reviews, 0%',
      '1 star: 1 review, 25%',
    ]);
  });

  it('emits the star value to filter by, and null to clear it', async () => {
    const fixture = await render(true);
    const picked: (number | null)[] = [];
    fixture.componentInstance.pick.subscribe((v) => picked.push(v));
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button');
    expect(buttons[2].disabled).toBe(true); // no 3-star reviews
    buttons[1].click();
    fixture.componentRef.setInput('selected', 4);
    await fixture.whenStable();
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    buttons[1].click();
    expect(picked).toEqual([4, null]);
  });
});
