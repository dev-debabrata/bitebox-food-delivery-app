import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { confirmed } from './confirm-dialog';

describe('confirmed()', () => {
  const open = async (reasonLabel?: string) => {
    const dialog = TestBed.inject(MatDialog);
    const results: (true | string)[] = [];
    confirmed(dialog, { title: 'Cancel this order?', message: 'Sure?', confirmLabel: 'Cancel order', reasonLabel }).subscribe((r) => results.push(r));
    await TestBed.inject(MatDialog).openDialogs[0].afterOpened().toPromise();
    TestBed.tick();
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('mat-dialog-actions button'));
    return { results, buttons, dialog };
  };

  afterEach(() => TestBed.inject(MatDialog).closeAll());

  it('emits nothing when the user clicks Cancel', async () => {
    const { results, buttons, dialog } = await open();
    buttons().find((b) => b.textContent?.trim() === 'Cancel')!.click();
    await dialog.openDialogs[0]?.afterClosed().toPromise();
    TestBed.tick();
    expect(results).toEqual([]);
  });

  it('emits true when the user confirms', async () => {
    const { results, buttons, dialog } = await open();
    const ref = dialog.openDialogs[0];
    buttons().find((b) => b.textContent?.trim() === 'Cancel order')!.click();
    await ref.afterClosed().toPromise();
    expect(results).toEqual([true]);
  });
});
