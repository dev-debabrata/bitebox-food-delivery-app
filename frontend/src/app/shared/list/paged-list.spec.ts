import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { pagedList } from './paged-list';

describe('pagedList', () => {
  const setup = () => {
    vi.useFakeTimers();
    const filter = signal('reported');
    const calls: Subject<{ items: string[] }>[] = [];
    const list = TestBed.runInInjectionContext(() =>
      pagedList(
        () => {
          const response = new Subject<{ items: string[] }>();
          calls.push(response);
          return response;
        },
        { filterKey: () => filter(), errorText: 'failed' },
      ),
    );
    TestBed.tick();
    return { filter, calls, list };
  };

  afterEach(() => vi.useRealTimers());

  /** Answers a request the way HttpClient does: one value, then complete. */
  const answer = (call: Subject<{ items: string[] }>, items: string[]) => {
    call.next({ items });
    call.complete();
  };

  it('reports loading as soon as the filters change, before the debounced request', () => {
    const { filter, calls, list } = setup();
    answer(calls[0], []);
    expect(list.loading()).toBe(false);

    filter.set('all');
    TestBed.tick();
    expect(list.loading()).toBe(true); // old empty result must not read as "no matches"
    expect(calls.length).toBe(1);

    vi.advanceTimersByTime(300);
    expect(calls.length).toBe(2);
    answer(calls[1], ['a']);
    expect(list.loading()).toBe(false);
    expect(list.data()).toEqual({ items: ['a'] });
  });

  it('ignores a slow response for filters that are no longer current', () => {
    const { filter, calls, list } = setup();
    filter.set('all');
    TestBed.tick();
    vi.advanceTimersByTime(300);

    answer(calls[1], ['new']);
    answer(calls[0], []); // the first request answers last
    expect(list.data()).toEqual({ items: ['new'] });
    expect(list.loading()).toBe(false);
  });
});
