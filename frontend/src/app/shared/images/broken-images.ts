import {
  Directive,
  ElementRef,
  Injectable,
  PLATFORM_ID,
  Pipe,
  PipeTransform,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

type Url = string | null | undefined;

/** Image URLs that failed to load, so views show their placeholder instead of a broken image. */
@Injectable({ providedIn: 'root' })
export class BrokenImages {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly failed = signal<ReadonlySet<string>>(new Set());

  usable(url: Url): url is string {
    return !!url && !this.failed().has(url);
  }

  markFailed(url: Url): void {
    if (this.usable(url)) this.failed.update((urls) => new Set(urls).add(url));
  }

  /** Loads `url` off-screen, for images drawn by components we can't hook (NexPrime upload). */
  check(url: Url): void {
    if (!this.isBrowser || !this.usable(url)) return;
    const probe = new Image();
    probe.onerror = () => this.markFailed(url);
    probe.src = url;
  }
}

/** `<img [bbSrc]="url">`: sets `src` and reports a failed load, including one before hydration. */
@Directive({ selector: 'img[bbSrc]', host: { '[src]': 'bbSrc()', '(error)': 'fail()' } })
export class ImageFallback {
  readonly bbSrc = input.required<Url>();
  private readonly images = inject(BrokenImages);

  constructor() {
    const img = inject<ElementRef<HTMLImageElement>>(ElementRef).nativeElement;
    afterNextRender(() => img.complete && !img.naturalWidth && this.fail());
  }

  protected fail(): void {
    this.images.markFailed(this.bbSrc());
  }
}

/** `@if (url | usableImage)`: a URL is set and has not failed to load. */
@Pipe({ name: 'usableImage', pure: false })
export class UsableImagePipe implements PipeTransform {
  private readonly images = inject(BrokenImages);

  transform(url: Url): boolean {
    return this.images.usable(url);
  }
}
