import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Paginated } from '../../shared/models/api.models';
import {
  CoinRules,
  CoinSource,
  CoinTransaction,
  CoinTxnType,
  CoinWallet,
  CustomerCampaign,
  MyReferral,
  ReferralFriend,
  RewardClaim,
  RewardType,
  RewardsOverview,
} from '../../shared/models/rewards.models';
import { toParams } from './http-params';

/** The signed-in customer's coins, referrals and special rewards (read-only except claims). */
@Injectable({ providedIn: 'root' })
export class RewardsService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.baseUrl;

  private get<T>(path: string, query: object = {}): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.api}/${path}`, { params: toParams(query) })
      .pipe(map((r) => r.data));
  }

  private send<T>(method: 'POST' | 'PUT', path: string, body: object): Observable<T> {
    return this.http.request<ApiResponse<T>>(method, `${this.api}/${path}`, { body }).pipe(map((r) => r.data));
  }

  wallet = () => this.get<{ wallet: CoinWallet; rules: CoinRules }>('coins/wallet');
  transactions = (query: { type?: CoinTxnType; source?: CoinSource; page?: number; limit?: number }) =>
    this.get<Paginated<CoinTransaction>>('coins/transactions', query);

  referral = () => this.get<MyReferral>('referrals/me');
  referralHistory = (query: { status?: string; page?: number; limit?: number }) =>
    this.get<Paginated<ReferralFriend>>('referrals/me/history', query);
  validateReferralCode = (code: string) =>
    this.send<{ valid: boolean; message?: string }>('POST', 'referrals/validate', { code });

  overview = () => this.get<RewardsOverview>('rewards');
  campaigns = () => this.get<{ items: CustomerCampaign[] }>('rewards/campaigns').pipe(map((d) => d.items));
  claim = (campaignId: string) =>
    this.send<{ claim: RewardClaim }>('POST', `rewards/campaigns/${campaignId}/claim`, {}).pipe(map((d) => d.claim));
  history = (query: { rewardType?: RewardType; page?: number; limit?: number }) =>
    this.get<Paginated<RewardClaim>>('rewards/history', query);
  saveBirthday = (birthDate: string) => this.send<{ birthDate: string }>('PUT', 'rewards/birthday', { birthDate });
}
