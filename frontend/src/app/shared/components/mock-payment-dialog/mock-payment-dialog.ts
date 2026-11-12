import { NpIconPipe } from '../../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { CheckoutSession } from '../../models/payment.models';
import { InrPipe } from '../../pipes/money.pipes';

type GatewayMethod = 'upi' | 'card' | 'netbanking' | 'wallet';

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
  imports: [MatDialogModule, MatButtonModule, IconComponent, NpIconPipe, InrPipe],
  templateUrl: './mock-payment-dialog.html',
  styleUrl: './mock-payment-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MockPaymentDialog {
  protected readonly session = inject<CheckoutSession>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<MockPaymentDialog, 'success' | 'failure'>);

  protected readonly methods = METHODS;
  protected readonly method = signal<GatewayMethod>('upi');
  protected readonly selected = computed(() => METHODS.find((m) => m.id === this.method())!);
  protected readonly processing = signal(false);

  protected finish(outcome: 'success' | 'failure'): void {
    this.processing.set(true);
    setTimeout(() => this.ref.close(outcome), 700);
  }
}
