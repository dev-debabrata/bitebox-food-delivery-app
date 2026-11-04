import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { PhotoViewer } from './photo-viewer';

describe('PhotoViewer', () => {
  async function create(index = 0) {
    await TestBed.configureTestingModule({
      imports: [PhotoViewer],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { images: ['a.png', 'b.png', 'c.png'], index, caption: 'Asha C.' } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PhotoViewer);
    await fixture.whenStable();
    return fixture;
  }
  const el = (f: Awaited<ReturnType<typeof create>>) => f.nativeElement as HTMLElement;
  const img = (f: Awaited<ReturnType<typeof create>>) => el(f).querySelector<HTMLImageElement>('.stage img')!;
  const click = async (f: Awaited<ReturnType<typeof create>>, label: string) => {
    el(f).querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
    await f.whenStable();
  };
  const key = async (f: Awaited<ReturnType<typeof create>>, k: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    await f.whenStable();
  };

  it('opens on the clicked photo with a descriptive alt text', async () => {
    const f = await create(1);
    expect(img(f).getAttribute('src')).toBe('b.png');
    expect(img(f).alt).toBe('Photo 2 of 3 from Asha C.');
    expect(el(f).querySelector('.count')?.textContent).toContain('2 / 3');
  });

  it('zooms in and out with the buttons, keyboard and double-click', async () => {
    const f = await create();
    expect(el(f).querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.disabled).toBe(true);
    await click(f, 'Zoom in');
    expect(img(f).style.transform).toContain('scale(1.5)');
    await key(f, '+');
    expect(el(f).querySelector('.zoom-level')?.textContent).toContain('200%');
    await key(f, '0');
    expect(img(f).style.transform).toContain('scale(1)');
    el(f).querySelector('.stage')!.dispatchEvent(new MouseEvent('dblclick'));
    await f.whenStable();
    expect(img(f).style.transform).toContain('scale(2)');
    for (let i = 0; i < 10; i++) await click(f, 'Zoom in');
    expect(img(f).style.transform).toContain('scale(4)'); // capped
  });

  it('moves between photos and resets the zoom', async () => {
    const f = await create(2);
    await click(f, 'Zoom in');
    await click(f, 'Next photo');
    expect(img(f).getAttribute('src')).toBe('a.png'); // wraps around
    expect(img(f).style.transform).toContain('scale(1)');
    await key(f, 'ArrowLeft');
    expect(img(f).getAttribute('src')).toBe('c.png');
    await click(f, 'Show photo 2');
    expect(img(f).getAttribute('src')).toBe('b.png');
  });
});
