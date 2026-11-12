import { Dialog } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { BbDialog } from '../../dialog/bb-dialog';
import { confirmed } from './confirm-dialog';

describe('confirmed()', () => {
  const open = async (reasonLabel?: string) => {
    const results: (true | string)[] = [];
    let completed = false;
    confirmed(TestBed.inject(BbDialog), {
      title: 'Cancel this order?',
      message: 'Sure?',
      confirmLabel: 'Cancel order',
      reasonLabel,
    }).subscribe({ next: (r) => results.push(r), complete: () => (completed = true) });
    const ref = TestBed.inject(Dialog).openDialogs[0];
    await TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    const button = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('.bb-dialog__actions button')).find(
        (b) => b.textContent?.trim() === label,
      )!;
    return { results, button, ref, isCompleted: () => completed };
  };

  afterEach(() => TestBed.inject(Dialog).closeAll());

  it('names the dialog by its title for screen readers', async () => {
    const { ref } = await open();
    const container = document.querySelector('.bb-dialog-panel [role="dialog"]')!;
    const titleId = container.getAttribute('aria-labelledby')!;
    expect(document.getElementById(titleId)?.textContent).toBe('Cancel this order?');
    expect(ref).toBeTruthy();
  });

  it('emits nothing when the user clicks Cancel', async () => {
    const { results, button, ref, isCompleted } = await open();
    const closed = firstValueFrom(ref.closed);
    button('Cancel').click();
    await closed;
    expect(results).toEqual([]);
    expect(isCompleted()).toBe(true);
  });

  it('emits true when the user confirms', async () => {
    const { results, button, ref } = await open();
    const closed = firstValueFrom(ref.closed);
    button('Cancel order').click();
    await closed;
    expect(results).toEqual([true]);
  });

  it('requires a reason when asked for one, then emits it trimmed', async () => {
    const { results, button, ref } = await open('Reason');
    button('Cancel order').click();
    await TestBed.tick();
    expect(results).toEqual([]);
    expect(TestBed.inject(Dialog).openDialogs.length).toBe(1);

    const textarea = document.querySelector<HTMLTextAreaElement>('.bb-dialog-panel textarea')!;
    textarea.value = '  Customer called to cancel  ';
    textarea.dispatchEvent(new Event('input'));
    const closed = firstValueFrom(ref.closed);
    button('Cancel order').click();
    await closed;
    expect(results).toEqual(['Customer called to cancel']);
  });
});
