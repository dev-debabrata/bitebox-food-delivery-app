import { TestBed } from '@angular/core/testing';
import { Stars } from './stars';

describe('Stars', () => {
  async function render(value: number, ariaLabel?: string) {
    const fixture = TestBed.createComponent(Stars);
    fixture.componentRef.setInput('value', value);
    if (ariaLabel) fixture.componentRef.setInput('ariaLabel', ariaLabel);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }
  const widths = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>('.fill')).map((f) => f.style.width);

  it('fills whole, partial and empty stars', async () => {
    const el = await render(3.4);
    expect(widths(el)).toEqual(['100%', '100%', '100%', '40%', '0%']);
  });

  it('is one image with a spoken rating', async () => {
    const el = await render(4.25);
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Rated 4.3 out of 5');
    expect(el.querySelectorAll('[aria-hidden="true"]').length).toBe(5);
  });

  it('takes a custom label', async () => {
    const el = await render(0, 'Not rated yet');
    expect(el.getAttribute('aria-label')).toBe('Not rated yet');
    expect(widths(el).every((w) => w === '0%')).toBe(true);
  });
});
