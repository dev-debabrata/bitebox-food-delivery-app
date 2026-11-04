import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { IconComponent, SearchInputComponent } from 'nexprime';
import { EMPTY, catchError, debounceTime, distinctUntilChanged, switchMap, tap } from 'rxjs';
import { errorMessage } from '../../../core/services/api-error';
import { DeliveryLocationService, Place } from '../../../core/services/delivery-location.service';

@Component({
  selector: 'bb-place-search',
  imports: [IconComponent, SearchInputComponent],
  templateUrl: './place-search.html',
  styleUrl: './place-search.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaceSearch {
  private readonly places = inject(DeliveryLocationService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly showEmpty = input(false);
  readonly picked = output<Place>();

  protected readonly query = signal('');
  protected readonly results = signal<Place[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    toObservable(this.query)
      .pipe(
        debounceTime(500),
        distinctUntilChanged(),
        tap(() => {
          this.error.set(null);
          this.searched.set(false);
        }),
        switchMap((q) => {
          if (q.trim().length < 3) {
            this.results.set([]);
            return EMPTY;
          }
          this.searching.set(true);
          return this.places.search(q.trim()).pipe(
            catchError((err: unknown) => {
              this.error.set(errorMessage(err, 'Place search failed.'));
              this.searching.set(false);
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((places) => {
        this.results.set(places);
        this.searched.set(true);
        this.searching.set(false);
      });
  }

  focus(): void {
    this.host.querySelector('input')?.focus();
  }

  protected pick(place: Place): void {
    this.results.set([]);
    this.query.set('');
    this.searched.set(false);
    this.picked.emit(place);
  }
}
