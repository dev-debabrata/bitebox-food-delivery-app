import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { Payout } from '../../shared/models/admin-roles.models';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import { EarningsScope } from './reports.service';
import { FileDownloadService } from './file-download.service';
import { toParams } from './http-params';

/** One delivered order's money for this partner, and whether it has been paid out. */
export interface SettlementRow {
  orderId: string;
  orderNumber: string;
  settledAt: string;
  foodPaise: number;
  commissionBp: number;
  commissionPaise: number;
  refundAdjustmentPaise: number;
  netPaise: number;
  payout: { id: string; status: Payout['status']; paidAt: string | null } | null;
}

/** Settlement and payout history for restaurants and riders, and payout statements. */
@Injectable({ providedIn: 'root' })
export class PartnerFinanceService {
  private readonly http = inject(HttpClient);
  private readonly files = inject(FileDownloadService);

  private base(scope: EarningsScope): string {
    return `${environment.baseUrl}/${scope === 'restaurant' ? 'my/restaurant' : 'delivery'}`;
  }

  private list<T>(scope: EarningsScope, path: string, page: number, limit: number) {
    return this.http
      .get<ApiResponse<Paginated<T>>>(`${this.base(scope)}/${path}`, {
        params: toParams({ page, limit }),
      })
      .pipe(map((r) => r.data));
  }

  settlements = (scope: EarningsScope, page = 1, limit = 10) =>
    this.list<SettlementRow>(scope, 'settlements', page, limit);

  payouts = (scope: EarningsScope, page = 1, limit = 10) =>
    this.list<Payout>(scope, 'payouts', page, limit);

  statement(scope: EarningsScope, id: string): Promise<void> {
    return this.files.save(
      `${this.base(scope)}/payouts/${encodeURIComponent(id)}/statement`,
      'BiteBox-payout-statement.pdf',
    );
  }
}
