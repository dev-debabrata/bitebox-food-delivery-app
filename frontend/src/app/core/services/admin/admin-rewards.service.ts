import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ApiResponse, Paginated } from '../../../shared/models/api.models';
import {
  AdminCampaign,
  AdminCampaignDetail,
  AdminCampaignInput,
  AdminCoinTransaction,
  AdminReferral,
  AdminWalletDetail,
  CampaignStatus,
  CampaignType,
  CoinSource,
  CoinTxnType,
  ReferralRewardStatus,
  ReferralStatus,
  RewardClaim,
  RewardConfiguration,
  RewardConfigurationPatch,
  RewardType,
  RewardsReport,
} from '../../../shared/models/rewards.models';
import { toParams } from '../http-params';

/** Coins & Rewards management (super admin). */
@Injectable({ providedIn: 'root' })
export class AdminRewardsService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/admin/rewards`;

  private get<T>(path: string, query: object = {}): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.url}/${path}`, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  /** POST/PUT/PATCH and return `data[key]`. */
  private send<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, key: string, body: object, headers?: Record<string, string>) {
    return this.http
      .request<ApiResponse<Record<string, T>>>(method, `${this.url}/${path}`, { body, headers })
      .pipe(map((r) => r.data[key]));
  }

  configuration = () =>
    this.get<{ configuration: RewardConfiguration }>('configuration').pipe(map((d) => d.configuration));
  saveConfiguration = (version: number, patch: RewardConfigurationPatch) =>
    this.send<RewardConfiguration>('PUT', 'configuration', 'configuration', { version, ...patch });

  campaigns = (query: { status?: CampaignStatus; type?: CampaignType; search?: string; page?: number; limit?: number }) =>
    this.get<Paginated<AdminCampaign>>('campaigns', query);
  campaign = (id: string) => this.get<AdminCampaignDetail>(`campaigns/${id}`);
  createCampaign = (input: AdminCampaignInput) => this.send<AdminCampaign>('POST', 'campaigns', 'campaign', input);
  updateCampaign = (id: string, input: Partial<AdminCampaignInput>) =>
    this.send<AdminCampaign>('PUT', `campaigns/${id}`, 'campaign', input);
  setCampaignStatus = (id: string, action: 'activate' | 'pause' | 'end') =>
    this.send<AdminCampaign>('PATCH', `campaigns/${id}/status`, 'campaign', { action });
  claims = (query: { rewardType?: RewardType; campaign?: string; page?: number; limit?: number }) =>
    this.get<Paginated<RewardClaim>>('claims', query);

  transactions = (query: {
    type?: CoinTxnType;
    source?: CoinSource;
    search?: string;
    userId?: string;
    page?: number;
    limit?: number;
  }) => this.get<Paginated<AdminCoinTransaction>>('transactions', query);
  transaction = (id: string) =>
    this.get<{ transaction: AdminCoinTransaction; related: AdminCoinTransaction[] }>(`transactions/${id}`);
  reverse = (id: string, body: { coins?: number; reason: string }, idempotencyKey: string) =>
    this.send<AdminCoinTransaction>('POST', `transactions/${id}/reverse`, 'transaction', body, {
      'Idempotency-Key': idempotencyKey,
    });
  wallet = (userId: string) => this.get<AdminWalletDetail>(`wallets/${userId}`);

  reports = (days: number) => this.get<RewardsReport>('reports', { days });

  referrals = (query: {
    status?: ReferralStatus;
    rewardStatus?: ReferralRewardStatus;
    flagged?: boolean;
    search?: string;
    page?: number;
    limit?: number;
  }) => this.get<Paginated<AdminReferral> & { counts: Record<string, number> }>('referrals', query);
  approveReferral = (id: string, note?: string) =>
    this.send<AdminReferral>('POST', `referrals/${id}/approve`, 'referral', { note });
  rejectReferral = (id: string, note: string) =>
    this.send<AdminReferral>('POST', `referrals/${id}/reject`, 'referral', { note });
}
