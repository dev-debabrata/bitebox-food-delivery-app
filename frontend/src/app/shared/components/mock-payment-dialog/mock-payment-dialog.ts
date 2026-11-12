import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BB_DIALOG_DATA, BB_DIALOG_TITLE_ID, BbDialog, BbDialogRef } from '../../dialog/bb-dialog';
import { CheckoutSession } from '../../models/payment.models';
import { InrPipe } from '../../pipes/money.pipes';

type GatewayMethod = 'upi' | 'card' | 'netbanking' | 'wallet';
export type PaymentOutcome = 'success' | 'failure';

const METHODS: { id: GatewayMethod; label: string; icon: string; hint: string; detail: string }[] =
  [
    {
      id: 'upi',
      label: 'UPI',
      icon: 'qr_code_2',
      hint: 'Google Pay, PhonePe, Paytm & more',
      detail: 'Test UPI ID: success@bitebox',
    },
    {
      id: 'card',
      label: 'Card',
      icon: 'credit_card',
      hint: 'Visa, Mastercard, RuPay',
      detail: 'Test card: 4111 1111 1111 1111 · 12/30 · 123',
    },
    {
      id: 'netbanking',
      label: 'Netbanking',
      icon: 'account_balance',
      hint: 'All major banks',
      detail: 'Test bank: BiteBox Demo Bank',
    },
    {
      id: 'wallet',
      label: 'Wallet',
      icon: 'account_balance_wallet',
      hint: 'Paytm, Amazon Pay & more',
      detail: 'Test wallet: BiteBox Demo Wallet',
    },
  ];

@Component({
  selector: 'bb-mock-payment-dialog',
  imports: [IconComponent, NpIconPipe, InrPipe],
  templateUrl: './mock-payment-dialog.html',
  styleUrl: './mock-payment-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MockPaymentDialog {
  protected readonly session = inject<CheckoutSession>(BB_DIALOG_DATA);
  protected readonly ref = inject<BbDialogRef<PaymentOutcome>>(BbDialogRef);
  protected readonly titleId = inject(BB_DIALOG_TITLE_ID, { optional: true });

  protected readonly methods = METHODS;
  protected readonly method = signal<GatewayMethod>('upi');
  protected readonly selected = computed(() => METHODS.find((m) => m.id === this.method())!);
  protected readonly processing = signal(false);

  protected finish(outcome: PaymentOutcome): void {
    this.processing.set(true);
    this.ref.disableClose = true; // no closing half-way through "processing"
    setTimeout(() => this.ref.close(outcome), 700);
  }
}

/** The simulated gateway; emits the outcome, or `undefined` when closed without paying. */
export const openMockPayment = (dialog: BbDialog, session: CheckoutSession) =>
  dialog.open<MockPaymentDialog, CheckoutSession, PaymentOutcome>(MockPaymentDialog, {
    data: session,
    width: '440px',
    panelClass: 'bb-gateway-dialog',
  }).closed;
