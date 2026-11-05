import { BreakpointObserver } from '@angular/cdk/layout';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { NewsletterService } from '../../../core/services/newsletter.service';
import { PaymentService } from '../../../core/services/payment.service';
import { available } from './footer-links';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  let fixture: ComponentFixture<SiteFooter>;
  const phone = new BehaviorSubject({ matches: false, breakpoints: {} });
  const displayUser = signal<{ name: string } | null>(null);
  const cod = { method: 'cod', label: 'Cash on delivery', provider: 'cash_on_delivery', simulated: false };

  async function render(methods = [cod], compact = false) {
    await TestBed.configureTestingModule({
      imports: [SiteFooter],
      providers: [
        provideRouter([]),
        { provide: PaymentService, useValue: { methods$: of(methods) } },
        { provide: NewsletterService, useValue: { subscribe: vi.fn() } },
        { provide: BreakpointObserver, useValue: { observe: () => phone } },
        { provide: AuthService, useValue: { displayUser } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SiteFooter);
    fixture.componentRef.setInput('compact', compact);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  beforeEach(() => {
    phone.next({ matches: false, breakpoints: {} });
    displayUser.set(null);
  });

  it('shows partner sign-up to visitors only', async () => {
    const el = await render();
    expect(el.querySelector('.partners')).not.toBeNull();
    displayUser.set({ name: 'Asha Rao' });
    await fixture.whenStable();
    expect(el.querySelector('.partners')).toBeNull();
    expect(text()).not.toContain('Register your restaurant');
  });

  it('shows the current year and only links that lead to real pages', async () => {
    const el = await render();
    expect(text()).toContain(`© ${new Date().getFullYear()} BiteBox. All rights reserved.`);
    const hrefs = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/restaurants');
    expect(hrefs).toContain('/restaurants?sort=rating');
    expect(hrefs).toContain('/restaurant/register');
    expect(hrefs).toContain('/delivery/register');
    expect(hrefs).toContain('/#partners');
    expect(hrefs.every((h) => h && h !== '#')).toBe(true);
    // Pages that do not exist yet are not linked.
    expect(text()).not.toContain('About us');
    expect(text()).not.toContain('Privacy policy');
    expect(text()).not.toContain('Legal & policies');
  });

  it('lists only payment methods checkout really accepts', async () => {
    await render([cod, { method: 'online', label: 'Test payment', provider: 'mock', simulated: true }]);
    expect(text()).toContain('Cash on delivery');
    expect(text()).not.toContain('UPI');
    TestBed.resetTestingModule();
    await render([cod, { method: 'online', label: 'Pay online', provider: 'razorpay', simulated: false }]);
    expect(text()).toContain('UPI');
    expect(text()).toContain('Net banking');
  });

  it('hides social and app links until their URLs are configured', async () => {
    await render();
    expect(text()).not.toContain('Enjoy BiteBox on the go');
    expect(fixture.nativeElement.querySelector('.social')).toBeNull();
    expect(available([{ label: 'X', href: '' }, { label: 'Y', href: 'https://example.com' }])).toHaveLength(1);
  });

  it('turns link groups into an accordion on phones', async () => {
    const el = await render();
    phone.next({ matches: true, breakpoints: {} });
    await fixture.whenStable();
    const toggle = el.querySelector<HTMLButtonElement>('.group-toggle')!;
    const list = el.querySelector<HTMLElement>(`#${toggle.getAttribute('aria-controls')}`)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    toggle.click();
    await fixture.whenStable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    toggle.click();
    await fixture.whenStable();
    expect(list.hidden).toBe(true);
  });

  it('keeps only the bottom bar on checkout', async () => {
    const el = await render([cod], true);
    expect(el.querySelector('.newsletter')).toBeNull();
    expect(el.querySelector('.groups')).toBeNull();
    expect(text()).toContain('All rights reserved');
  });
});
