import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { BbDialog } from '../../shared/dialog/bb-dialog';
import { of, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { CartActions } from './cart-actions.service';
import { CartService } from './cart.service';
import { NotificationService } from './notification.service';

describe('CartActions', () => {
  const cart = { add: vi.fn(), setQuantity: vi.fn() };
  const notify = { success: vi.fn(), error: vi.fn() };
  const dialog = { open: vi.fn() };
  let authenticated = true;
  let actions: CartActions;
  let router: Router;

  beforeEach(() => {
    Object.values(cart).forEach((f) => f.mockReset());
    Object.values(notify).forEach((f) => f.mockReset());
    dialog.open.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: CartService, useValue: cart },
        { provide: NotificationService, useValue: notify },
        { provide: BbDialog, useValue: dialog },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: () => authenticated,
            role: () => (authenticated ? 'customer' : null),
          },
        },
      ],
    });
    actions = TestBed.inject(CartActions);
    router = TestBed.inject(Router);
  });

  it('sends signed-out visitors to sign in and back', () => {
    authenticated = false;
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    actions.add('f1', 'Naan');
    expect(cart.add).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: router.url } });
    authenticated = true;
  });

  it('adds to the cart and confirms', () => {
    cart.add.mockReturnValue(of({}));
    actions.add('f1', 'Naan');
    expect(cart.add).toHaveBeenCalledWith('f1');
    expect(notify.success).toHaveBeenCalledWith('Naan added to cart');
  });

  it('asks before replacing a cart from another restaurant', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: {
        success: false,
        message: 'Your cart has dishes from X. Start a new cart?',
        error: { code: 'CART_RESTAURANT_CONFLICT' },
      },
    });
    cart.add.mockReturnValueOnce(throwError(() => conflict)).mockReturnValueOnce(of({}));
    dialog.open.mockReturnValue({ closed: of(true) });

    actions.add('f2', 'Dosa');

    expect(dialog.open).toHaveBeenCalled();
    expect(cart.add).toHaveBeenLastCalledWith('f2', 1, true);
    expect(notify.success).toHaveBeenCalled();
  });

  it('keeps the existing cart if the customer declines', () => {
    const conflict = new HttpErrorResponse({
      status: 409,
      error: { error: { code: 'CART_RESTAURANT_CONFLICT' }, message: 'x' },
    });
    cart.add.mockReturnValue(throwError(() => conflict));
    dialog.open.mockReturnValue({ closed: of(undefined) });
    actions.add('f2', 'Dosa');
    expect(cart.add).toHaveBeenCalledTimes(1);
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('only lets guests and customers order', () => {
    expect(actions.canOrder()).toBe(true);
  });
});
