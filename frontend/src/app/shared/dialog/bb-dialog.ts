import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { ComponentType } from '@angular/cdk/portal';
import { Directive, Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, filter } from 'rxjs';

/**
 * Dialogs without Angular Material: the CDK dialog (overlay, focus trap, Escape, backdrop,
 * focus restore) with BiteBox styling (`.bb-dialog-*` in styles.scss). NexPrime 0.1.5 has
 * no programmatic dialog opener, so this replaces `MatDialog`.
 *
 * In a dialog component:
 * - `inject(BB_DIALOG_DATA)` for the data and `inject(BbDialogRef)` to close it;
 * - mark the heading with `bbDialogTitle` (it names the dialog for screen readers);
 * - lay it out with `.bb-dialog__content` and `.bb-dialog__actions`.
 */
export const BB_DIALOG_DATA = DIALOG_DATA;
export { DialogRef as BbDialogRef };

/** The id the dialog's `aria-labelledby` points at; `bbDialogTitle` puts it on the heading. */
export const BB_DIALOG_TITLE_ID = new InjectionToken<string>('BB_DIALOG_TITLE_ID');

export interface BbDialogConfig<D> {
  data?: D;
  /** CSS width; capped to the viewport on phones. Default 440px. */
  width?: string;
  /** Stop backdrop clicks and Escape from closing it (e.g. while a payment is in progress). */
  disableClose?: boolean;
  /** Extra class on the overlay pane, for a dialog that needs its own panel styling. */
  panelClass?: string;
}

let nextId = 0;

@Injectable({ providedIn: 'root' })
export class BbDialog {
  private readonly dialog = inject(Dialog);

  open<C, D = unknown, R = unknown>(
    component: ComponentType<C>,
    config: BbDialogConfig<D> = {},
  ): DialogRef<R, C> {
    const titleId = `bb-dialog-title-${nextId++}`;
    return this.dialog.open<R, D, C>(component, {
      data: config.data,
      width: config.width ?? '440px',
      maxWidth: 'calc(100vw - 32px)',
      maxHeight: 'calc(100dvh - 32px)',
      panelClass: ['bb-dialog-panel', ...(config.panelClass ? [config.panelClass] : [])],
      backdropClass: 'bb-dialog-backdrop',
      disableClose: config.disableClose ?? false,
      ariaLabelledBy: titleId,
      autoFocus: 'first-tabbable',
      restoreFocus: true,
      providers: [{ provide: BB_DIALOG_TITLE_ID, useValue: titleId }],
    });
  }

  /** Opens the dialog and emits its result once, only if it closed with one (not dismissed). */
  result<C, D, R>(component: ComponentType<C>, config: BbDialogConfig<D> = {}): Observable<R> {
    return this.open<C, D, R>(component, config).closed.pipe(
      filter((r): r is R => r !== undefined && r !== null),
    );
  }
}

/** Put on the dialog's heading: `<h2 bbDialogTitle>…</h2>`. */
@Directive({
  selector: '[bbDialogTitle]',
  host: { class: 'bb-dialog__title', '[id]': 'id' },
})
export class BbDialogTitle {
  protected readonly id = inject(BB_DIALOG_TITLE_ID, { optional: true });
}
