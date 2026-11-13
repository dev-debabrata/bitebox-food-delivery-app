import { BreakpointObserver } from '@angular/cdk/layout';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  const open = vi.fn();

  function create(phone: boolean) {
    TestBed.configureTestingModule({
      providers: [
        { provide: MatSnackBar, useValue: { open } },
        { provide: BreakpointObserver, useValue: { isMatched: () => phone } },
      ],
    });
    return TestBed.inject(NotificationService);
  }

  beforeEach(() => open.mockReset());

  it('opens at the top on phones, keeping the type class', () => {
    create(true).success('Added to cart');
    expect(open).toHaveBeenCalledWith('Added to cart', 'OK', {
      duration: 3500,
      panelClass: ['bb-snack-success', 'bb-snack-top'],
      verticalPosition: 'top',
    });
  });

  it('opens in the bottom-right corner on tablets and desktops', () => {
    create(false).error('Could not save');
    expect(open).toHaveBeenCalledWith('Could not save', 'Dismiss', {
      duration: 6000,
      panelClass: 'bb-snack-error',
      horizontalPosition: 'end',
    });
  });
});
