import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { NewsletterService } from '../../../../core/services/newsletter.service';
import { NewsletterSignup } from './newsletter-signup';

describe('NewsletterSignup', () => {
  let fixture: ComponentFixture<NewsletterSignup>;
  const api = { subscribe: vi.fn() };

  beforeEach(async () => {
    api.subscribe.mockReset();
    await TestBed.configureTestingModule({
      imports: [NewsletterSignup],
      providers: [{ provide: NewsletterService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(NewsletterSignup);
    await fixture.whenStable();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  async function submit(email: string) {
    const input = el().querySelector<HTMLInputElement>('input')!;
    input.value = email;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    el().querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  }

  it('does not call the API for an invalid email', async () => {
    await submit('not-an-email');
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(el().textContent).toContain('valid email');
  });

  it('shows success only after the API confirms', async () => {
    api.subscribe.mockReturnValue(of({ subscribed: true, alreadySubscribed: false }));
    await submit('riya@example.com');
    expect(api.subscribe).toHaveBeenCalledWith('riya@example.com');
    expect(el().textContent).toContain('You’re subscribed');
  });

  it('tells an existing subscriber they are already on the list', async () => {
    api.subscribe.mockReturnValue(of({ subscribed: true, alreadySubscribed: true }));
    await submit('riya@example.com');
    expect(el().textContent).toContain('already on our list');
  });

  it('shows the error when the API fails', async () => {
    api.subscribe.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 429, error: { message: 'Too many sign-up attempts.' } })),
    );
    await submit('riya@example.com');
    expect(el().querySelector('[role=alert]')?.textContent).toContain('Too many sign-up attempts.');
    expect(el().textContent).not.toContain('subscribed!');
  });
});
