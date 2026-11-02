import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { User } from '../../../shared/models/user.models';
import { Login, landingFor, safeReturnUrl } from './login';

const admin: User = {
  id: 'a1',
  name: 'Admin',
  email: 'admin@bitebox.test',
  role: 'admin',
  status: 'active',
  createdAt: '',
  updatedAt: '',
};

describe('Login', () => {
  let fixture: ComponentFixture<Login>;
  let login: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    login = vi.fn();
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AuthService, useValue: { login } }],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(Login);
    fixture.componentRef.setInput('heading', 'Sign in');
    await fixture.whenStable();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const fill = (email: string, password: string) => {
    const [emailInput, passwordInput] = Array.from(el().querySelectorAll('input'));
    emailInput.value = email;
    emailInput.dispatchEvent(new Event('input'));
    passwordInput.value = password;
    passwordInput.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };

  it('renders the heading', () => {
    expect(el().querySelector('h1')?.textContent).toContain('Sign in');
  });

  it('does not call the API when the form is invalid', async () => {
    await submit();
    expect(login).not.toHaveBeenCalled();
    expect(el().textContent).toContain('Email is required');
  });

  it("signs in any role (no portal) and lands on that role's home", async () => {
    login.mockReturnValue(of(admin));
    fill('admin@bitebox.test', 'Secret123');
    await submit();
    expect(login).toHaveBeenCalledWith({ email: 'admin@bitebox.test', password: 'Secret123' });
    expect(navigate).toHaveBeenCalledWith('/admin');
  });

  it('shows the server error message on failure', async () => {
    login.mockReturnValue(
      throwError(
        () => new HttpErrorResponse({ status: 401, error: { success: false, message: 'Invalid email or password' } }),
      ),
    );
    fill('admin@bitebox.test', 'wrong-pass1');
    await submit();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Invalid email or password');
  });
});

describe('safeReturnUrl', () => {
  it('accepts in-app paths', () => expect(safeReturnUrl('/admin/users')).toBe('/admin/users'));
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', '', undefined])(
    'rejects %s',
    (url) => expect(safeReturnUrl(url)).toBeNull(),
  );
});

describe('landingFor', () => {
  it("follows a return URL inside the account's own area", () => {
    expect(landingFor('admin', '/admin/users')).toBe('/admin/users');
    expect(landingFor('restaurant', '/restaurant/orders')).toBe('/restaurant/orders');
    expect(landingFor('customer', '/orders/abc')).toBe('/orders/abc');
  });
  it('ignores return URLs for another panel and goes home instead', () => {
    expect(landingFor('customer', '/admin/users')).toBe('/');
    expect(landingFor('delivery', '/restaurant/orders')).toBe('/delivery');
    expect(landingFor('restaurant', '/checkout')).toBe('/restaurant');
    expect(landingFor('admin', 'https://evil.example')).toBe('/admin');
  });
});
