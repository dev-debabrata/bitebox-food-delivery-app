import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { RestaurantActiveOrders, RestaurantOrder } from '../../shared/models/order-management.models';
import { NotificationService } from './notification.service';
import { OrderEvent, RealtimeService } from './realtime.service';
import { RestaurantOrdersService } from './order-management.service';
import { RestaurantOrderBoard } from './restaurant-order-board';

const order = (id: string, status: RestaurantOrder['status'] = 'pending') =>
  ({ id, orderNumber: `BB-${id}`, status, items: [], createdAt: new Date().toISOString() }) as unknown as RestaurantOrder;
const board = (...items: RestaurantOrder[]): RestaurantActiveOrders => ({
  items,
  counts: { pending: items.filter((o) => o.status === 'pending').length },
});

describe('RestaurantOrderBoard', () => {
  let responses: Subject<RestaurantActiveOrders>;
  const api = { active: vi.fn() };
  const notify = { info: vi.fn() };
  let live: Subject<OrderEvent>;
  let service: RestaurantOrderBoard;

  beforeEach(() => {
    vi.useFakeTimers();
    api.active.mockReset().mockImplementation(() => {
      responses = new Subject();
      return responses;
    });
    notify.info.mockReset();
    live = new Subject();
    TestBed.configureTestingModule({
      providers: [
        { provide: RestaurantOrdersService, useValue: api },
        { provide: NotificationService, useValue: notify },
        { provide: RealtimeService, useValue: { orderUpdates$: live.asObservable() } },
      ],
    });
    service = TestBed.inject(RestaurantOrderBoard);
  });

  afterEach(() => vi.useRealTimers());

  const fakeDestroyRef = () => {
    const callbacks: (() => void)[] = [];
    return { ref: { onDestroy: (fn: () => void) => callbacks.push(fn) } as unknown as DestroyRef, destroy: () => callbacks.forEach((f) => f()) };
  };

  it('announces only orders that arrive after the first load, once each', () => {
    const page = fakeDestroyRef();
    service.connect(page.ref);
    responses.next(board(order('1'), order('2', 'preparing')));
    expect(service.pendingCount()).toBe(1);
    expect(notify.info).not.toHaveBeenCalled(); // already there when the page opened

    service.refresh();
    responses.next(board(order('1'), order('3')));
    expect(notify.info).toHaveBeenCalledExactlyOnceWith('New order BB-3');

    service.refresh();
    responses.next(board(order('1'), order('3')));
    expect(notify.info).toHaveBeenCalledTimes(1); // not again
    page.destroy();
  });

  it('polls while connected and stops when the last connection goes', () => {
    const layout = fakeDestroyRef();
    const page = fakeDestroyRef();
    service.connect(layout.ref);
    service.connect(page.ref);
    expect(api.active).toHaveBeenCalledTimes(1); // one poller, not two

    page.destroy();
    vi.advanceTimersByTime(60_000);
    expect(api.active).toHaveBeenCalledTimes(2); // still polling (slowly) for the layout

    layout.destroy();
    vi.advanceTimersByTime(120_000);
    expect(api.active).toHaveBeenCalledTimes(2);
  });

  it('reloads straight away when a live order event arrives', () => {
    const page = fakeDestroyRef();
    service.connect(page.ref);
    responses.next(board());
    live.next({ id: '9', orderNumber: 'BB-9', status: 'pending', updatedAt: '' });
    vi.advanceTimersByTime(300); // events are debounced briefly
    expect(api.active).toHaveBeenCalledTimes(2);
    responses.next(board(order('9')));
    expect(notify.info).toHaveBeenCalledWith('New order BB-9');
    page.destroy();
    live.next({ id: '9', orderNumber: 'BB-9', status: 'confirmed', updatedAt: '' });
    vi.advanceTimersByTime(300);
    expect(api.active).toHaveBeenCalledTimes(2); // not listening once disconnected
  });

  it('remembers when the partner has no restaurant yet', async () => {
    const { HttpErrorResponse } = await import('@angular/common/http');
    service.refresh();
    responses.error(new HttpErrorResponse({ status: 404 }));
    expect(service.noRestaurant()).toBe(true);
  });
});
