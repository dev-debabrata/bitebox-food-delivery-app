import { HttpErrorResponse } from '@angular/common/http';
import { WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../../../core/auth/auth.service';
import { User } from '../../../../shared/models/user.models';
import { PhoneLogin } from './phone-login';

const customer = { id: 'c1', name: 'Asha', role: 'customer' } as User;

describe('PhoneLogin', () => {
  let fixture: ComponentFixture<PhoneLogin>;
  let auth: { requestLoginCode: ReturnType<typeof vi.fn>; loginWithCode: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    auth = {
      requestLoginCode: vi.fn(() =>
        of({
          message: 'If this number has a BiteBox account, we have sent a code',
          resendInSeconds: 30,
          expiresInSeconds: 300,
        }),
      ),
      loginWithCode: vi.fn(() => of(customer)),
    };
    await TestBed.configureTestingModule({
      imports: [PhoneLogin],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compileComponents();
    fixture = TestBed.createComponent(PhoneLogin);
    await fixture.whenStable();
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const component = () =>
    fixture.componentInstance as unknown as {
      phoneModel: WritableSignal<{ phone: string }>;
      codeModel: WritableSignal<{ code: string }>;
    };
  const submit = async () => {
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
  };

  it('asks for a code, then signs in with it', async () => {
    const signedIn = vi.fn();
    fixture.componentInstance.signedIn.subscribe(signedIn);
    component().phoneModel.set({ phone: '+919000000002' });
    await submit();
    expect(auth.requestLoginCode).toHaveBeenCalledWith('+919000000002');
    expect(el().textContent).toContain('we have sent a code');

    component().codeModel.set({ code: '12345' });
    await submit();
    expect(auth.loginWithCode).not.toHaveBeenCalled(); // 6 digits needed

    component().codeModel.set({ code: '123456' });
    await submit();
    expect(auth.loginWithCode).toHaveBeenCalledWith('+919000000002', '123456');
    expect(signedIn).toHaveBeenCalledWith(customer);
  });

  it('shows why a code was refused', async () => {
    auth.loginWithCode.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { success: false, message: 'That code is not right. 4 tries left' },
          }),
      ),
    );
    component().phoneModel.set({ phone: '+919000000002' });
    await submit();
    component().codeModel.set({ code: '000000' });
    await submit();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('4 tries left');
  });
});
