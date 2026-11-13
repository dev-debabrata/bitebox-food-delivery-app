import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ButtonComponent, IconComponent } from 'nexprime';
import { errorMessage } from '../../../../core/services/api-error';
import { KycService } from '../../../../core/services/kyc.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { BbDialog } from '../../../dialog/bb-dialog';
import { DOCUMENT_LABEL, DOCUMENT_TONE, KycDocument } from '../../../models/kyc.models';
import { confirmed } from '../../confirm-dialog/confirm-dialog';

/**
 * Admin review of a partner's verification: the checklist, each document (view, approve,
 * reject with a note the partner sees) and the masked bank account. Every view is audited.
 */
@Component({
  selector: 'bb-kyc-review',
  imports: [DatePipe, ButtonComponent, IconComponent],
  templateUrl: './kyc-review.html',
  styleUrl: './kyc-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KycReview {
  private readonly api = inject(KycService);
  private readonly dialog = inject(BbDialog);
  private readonly notify = inject(NotificationService);

  /** The partner's user id. */
  readonly partnerId = input.required<string>();
  readonly canReview = input(true);
  /** A document was reviewed (the parent may refresh what depends on it). */
  readonly changed = output<void>();

  protected readonly summary = rxResource({
    params: () => this.partnerId(),
    stream: ({ params }) => this.api.partner(params),
  });
  protected readonly data = computed(() => (this.summary.hasValue() ? this.summary.value() : null));
  protected readonly loadError = computed(() =>
    this.summary.error()
      ? errorMessage(this.summary.error(), 'Could not load the documents.')
      : null,
  );
  protected readonly rows = computed(() => {
    const s = this.data();
    if (!s) return [];
    const docs = new Map(s.documents.map((d) => [d.kind, d]));
    return s.checklist.map((item) => ({ ...item, doc: docs.get(item.kind) ?? null }));
  });
  protected readonly busy = signal<string | null>(null);
  protected readonly tone = DOCUMENT_TONE;
  protected readonly statusLabel = DOCUMENT_LABEL;

  protected view(doc: KycDocument): void {
    this.api.open(doc, true).catch((err: Error) => this.notify.error(err.message));
  }

  protected approve(doc: KycDocument): void {
    this.decide(doc, 'approved');
  }

  protected reject(doc: KycDocument): void {
    confirmed(this.dialog, {
      title: `Reject the ${doc.label}?`,
      message: 'The partner is told what to fix and asked to upload it again.',
      confirmLabel: 'Reject',
      danger: true,
      reasonLabel: 'What is wrong',
    }).subscribe((note) => this.decide(doc, 'rejected', String(note)));
  }

  private decide(doc: KycDocument, status: 'approved' | 'rejected', note = ''): void {
    this.busy.set(doc.id);
    this.api.review(doc.id, status, note).subscribe({
      next: () => {
        this.busy.set(null);
        this.notify.success(
          status === 'approved' ? `${doc.label} approved` : `${doc.label} rejected`,
        );
        this.summary.reload();
        this.changed.emit();
      },
      error: (err: unknown) => {
        this.busy.set(null);
        this.notify.error(errorMessage(err));
      },
    });
  }
}
