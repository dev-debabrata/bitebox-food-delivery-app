/** Coins, referrals and special rewards. Mirrors backend config/rewards.js and the rewards services. */

export type CoinTxnType = 'CREDIT' | 'DEBIT' | 'RESERVE' | 'RELEASE' | 'EXPIRE' | 'REVERSAL';
export type CoinSource =
  | 'ORDER_REWARD'
  | 'REVIEW_REWARD'
  | 'REFERRAL_REWARD'
  | 'WELCOME_REWARD'
  | 'BIRTHDAY_REWARD'
  | 'FESTIVAL_REWARD'
  | 'PROMOTIONAL_REWARD'
  | 'COIN_REDEMPTION'
  | 'COIN_EXPIRY'
  | 'REWARD_REVERSAL';

export const EARN_SOURCES: CoinSource[] = [
  'ORDER_REWARD',
  'REVIEW_REWARD',
  'REFERRAL_REWARD',
  'WELCOME_REWARD',
  'BIRTHDAY_REWARD',
  'FESTIVAL_REWARD',
  'PROMOTIONAL_REWARD',
];

export const SOURCE_LABEL: Record<CoinSource, string> = {
  ORDER_REWARD: 'Order reward',
  REVIEW_REWARD: 'Review bonus',
  REFERRAL_REWARD: 'Referral bonus',
  WELCOME_REWARD: 'Welcome bonus',
  BIRTHDAY_REWARD: 'Birthday bonus',
  FESTIVAL_REWARD: 'Festival reward',
  PROMOTIONAL_REWARD: 'Promotional reward',
  COIN_REDEMPTION: 'Order redemption',
  COIN_EXPIRY: 'Expired',
  REWARD_REVERSAL: 'Reward reversed',
};

export const TXN_TYPE_LABEL: Record<CoinTxnType, string> = {
  CREDIT: 'Earned',
  DEBIT: 'Redeemed',
  RESERVE: 'Held for order',
  RELEASE: 'Returned',
  EXPIRE: 'Expired',
  REVERSAL: 'Reversal',
};

export interface CoinWallet {
  available: number;
  reserved: number;
  totalEarned: number;
  totalRedeemed: number;
  totalExpired: number;
  totalReversed: number;
  valuePaise: number;
  expiring: {
    enabled: boolean;
    withinDays: number;
    coins: number;
    next: { expiresAt: string; coins: number } | null;
    upcoming: { date: string; coins: number }[];
  };
}

export interface CoinRules {
  enabled: boolean;
  earningEnabled: boolean;
  coinValueCoins: number;
  coinValuePaise: number;
  minCoins: number;
  maxCoinsPerOrder: number;
  maxPercentOfOrder: number;
  minOrderPaise: number;
  paymentMethods: ('cod' | 'online')[];
  order: { coinsPerUnit: number; unitPaise: number; minOrderPaise: number; maxCoinsPerOrder: number };
  reviewCoins: number;
  expiry: { enabled: boolean; days: Partial<Record<CoinSource, number>> };
}

export interface CoinTransaction {
  id: string;
  type: CoinTxnType;
  source: CoinSource;
  coins: number;
  availableChange: number;
  reservedChange: number;
  balanceAfter: number;
  description: string | null;
  orderId: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

/** The checkout coins block of the cart quote. */
export interface CoinQuote {
  enabled: boolean;
  available: number;
  requested: number;
  applied: number;
  discountPaise: number;
  maxRedeemable: number;
  minCoins: number;
  coinValueCoins: number;
  coinValuePaise: number;
  paymentMethods: ('cod' | 'online')[];
  message: string | null;
}

export type OrderCoinState = 'reserved' | 'committed' | 'released' | 'refunded';
export interface OrderCoins {
  redeemed: number;
  discountPaise: number;
  state: OrderCoinState | null;
  earned: number;
}

// Referrals

export type ReferralStatus =
  | 'REGISTERED'
  | 'FIRST_ORDER_PLACED'
  | 'ORDER_DELIVERED'
  | 'REWARD_CREDITED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'PENDING';
export type CustomerReferralStatus = Exclude<ReferralStatus, 'REJECTED'> | 'NOT_ELIGIBLE';

export const REFERRAL_STATUS_LABEL: Record<CustomerReferralStatus | 'REJECTED', string> = {
  PENDING: 'Invited',
  REGISTERED: 'Signed up',
  FIRST_ORDER_PLACED: 'First order placed',
  ORDER_DELIVERED: 'Order delivered',
  REWARD_CREDITED: 'Rewarded',
  NOT_ELIGIBLE: 'Not eligible',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

/** Steps shown on the referral progress indicator. */
export const REFERRAL_STEPS: CustomerReferralStatus[] = [
  'REGISTERED',
  'FIRST_ORDER_PLACED',
  'ORDER_DELIVERED',
  'REWARD_CREDITED',
];

export interface MyReferral {
  code: string;
  link: string;
  rules: {
    enabled: boolean;
    referrerCoins: number;
    referredCoins: number;
    minOrderPaise: number;
    attributionDays: number;
    maxReferrals: number;
  };
  stats: {
    invited: number;
    pending: number;
    successful: number;
    unsuccessful: number;
    coinsEarned: number;
    remaining: number;
  };
  referredBy: { status: CustomerReferralStatus; coins: number; expiresAt: string } | null;
}

export interface ReferralFriend {
  id: string;
  friend: string;
  status: CustomerReferralStatus;
  coins: number;
  joinedAt: string;
  expiresAt: string;
  rewardedAt: string | null;
}

// Special rewards

export type RewardType = 'WELCOME' | 'BIRTHDAY' | 'FESTIVAL' | 'PROMOTIONAL';
export const REWARD_TYPE_LABEL: Record<RewardType, string> = {
  WELCOME: 'Welcome',
  BIRTHDAY: 'Birthday',
  FESTIVAL: 'Festival',
  PROMOTIONAL: 'Promotion',
};

export type CampaignType = 'FESTIVAL' | 'PROMOTIONAL';
export type CampaignTrigger = 'CLAIM' | 'ORDER';
export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'COMPLETED';
export type CustomerGroup = 'ALL' | 'NEW' | 'EXISTING' | 'INACTIVE';

export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  EXPIRED: 'Expired',
  COMPLETED: 'Completed',
};

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  FESTIVAL: 'Festival',
  PROMOTIONAL: 'Promotional',
};

export const CUSTOMER_GROUP_LABEL: Record<CustomerGroup, string> = {
  ALL: 'All customers',
  NEW: 'New customers (no orders yet)',
  EXISTING: 'Existing customers',
  INACTIVE: 'Inactive customers',
};

export interface RewardsOverview {
  enabled: boolean;
  birthday: {
    enabled: boolean;
    coins: number;
    saved: boolean;
    birthDate?: string;
    next?: string;
    claimedThisYear?: boolean;
  };
  welcome: { enabled: boolean; coins: number; trigger: 'registration' | 'first_order'; claimed: boolean };
  totals: { claims: number; coins: number };
}

export interface CustomerCampaign {
  id: string;
  name: string;
  description: string;
  type: CampaignType;
  trigger: CampaignTrigger;
  rewardCoins: number;
  startAt: string;
  endAt: string;
  status: CampaignStatus;
  conditions: { minOrderPaise: number; firstOrderOnly: boolean; restaurantOnly: boolean };
  claimedTimes: number;
  maxClaimsPerCustomer: number;
  canClaim: boolean;
  reason: string | null;
}

export interface RewardClaim {
  id: string;
  rewardType: RewardType;
  coins: number;
  status: 'PENDING' | 'ISSUED';
  campaign: { id: string; name: string } | null;
  orderId: string | null;
  claimedAt: string;
  customer?: { id: string; name: string; email: string } | null;
}

// Admin

export interface RewardConfiguration {
  version: number;
  coinsEnabled: boolean;
  earning: {
    order: { enabled: boolean; coinsPerUnit: number; unitPaise: number; minOrderPaise: number; maxCoinsPerOrder: number };
    review: { enabled: boolean; coins: number; minCommentLength: number };
  };
  redemption: {
    enabled: boolean;
    coinValueCoins: number;
    coinValuePaise: number;
    minCoins: number;
    maxCoinsPerOrder: number;
    maxPercentOfOrder: number;
    minOrderPaise: number;
    paymentMethods: ('cod' | 'online')[];
  };
  expiry: {
    enabled: boolean;
    days: Record<string, number>;
    restoreGraceDays: number;
    expiringSoonDays: number;
  };
  referral: {
    enabled: boolean;
    referrerCoins: number;
    referredCoins: number;
    minOrderPaise: number;
    attributionDays: number;
    maxReferralsPerCustomer: number;
    maxRewardsPerMonth: number;
  };
  birthday: { enabled: boolean; coins: number };
  welcome: { enabled: boolean; coins: number; trigger: 'registration' | 'first_order' };
  timezone: string;
  updatedAt?: string;
  updatedBy?: string | null;
}

export type RewardConfigurationPatch = Partial<Omit<RewardConfiguration, 'version' | 'updatedAt' | 'updatedBy'>>;

export interface AdminCampaign {
  id: string;
  name: string;
  description: string;
  type: CampaignType;
  trigger: CampaignTrigger;
  rewardCoins: number;
  startAt: string;
  endAt: string;
  status: CampaignStatus;
  conditions: {
    customerGroup: CustomerGroup;
    inactiveDays: number;
    minOrderPaise: number;
    firstOrderOnly: boolean;
    restaurants: string[];
  };
  limits: { maxClaimsPerCustomer: number; maxTotalClaims: number | null; maxTotalCoins: number | null };
  stats: { claims: number; coins: number };
  remainingClaims: number | null;
  remainingCoins: number | null;
  createdAt: string;
}

export interface AdminCampaignInput {
  name: string;
  description: string;
  type: CampaignType;
  trigger: CampaignTrigger;
  rewardCoins: number;
  startAt: string;
  endAt: string;
  conditions: { customerGroup: CustomerGroup; inactiveDays: number; minOrderPaise: number; firstOrderOnly: boolean };
  limits: { maxClaimsPerCustomer: number; maxTotalClaims: number | null; maxTotalCoins: number | null };
}

export interface AdminCampaignDetail {
  campaign: AdminCampaign;
  performance: { claims: number; coins: number; customers: number };
  recentClaims: {
    id: string;
    customer: { id: string; name: string; email: string } | null;
    coins: number;
    status: string;
    orderId: string | null;
    claimedAt: string;
  }[];
}

export interface Person {
  id: string;
  name: string;
  email: string;
}

export interface AdminCoinTransaction extends CoinTransaction {
  seq: number;
  status: 'pending' | 'posted';
  reversalOf: 'credit' | 'redemption' | null;
  requestedCoins: number | null;
  shortfall: number | null;
  availableBefore: number;
  availableAfter: number;
  reservedBefore: number;
  reservedAfter: number;
  idempotencyKey: string;
  campaignId: string | null;
  referralId: string | null;
  relatedTxnId: string | null;
  note: string | null;
  createdBy: Person | { id: string } | null;
  customer: Person | null;
  allocations: { source: CoinSource; coins: number; earnedAt: string; expiresAt: string | null }[];
}

export interface AdminWalletDetail {
  customer: Person & { role: string; status: string; referralCode: string | null };
  wallet: CoinWallet & { uncollectedReversal: number; seq: number };
  batches: { source: CoinSource; original: number; remaining: number; earnedAt: string; expiresAt: string | null }[];
  integrity: { ok: boolean; issues: string[]; rows: number };
  recent: AdminCoinTransaction[];
}

export type ReferralRewardStatus = 'NONE' | 'HELD' | 'CREDITING' | 'CREDITED' | 'PARTIAL' | 'REJECTED';
export const REFERRAL_REWARD_LABEL: Record<ReferralRewardStatus, string> = {
  NONE: 'Not yet',
  HELD: 'Held for review',
  CREDITING: 'Paying',
  CREDITED: 'Paid',
  PARTIAL: 'Friend paid (referrer at limit)',
  REJECTED: 'Rejected',
};
export const RISK_LABEL: Record<string, string> = {
  SAME_SIGNUP_IP: 'Signed up from the referrer’s network',
  ADDRESS_MATCHES_REFERRER: 'Delivered to the referrer’s address',
  ADDRESS_SHARED_WITH_OTHER_REFERRAL: 'Same address as another referral',
  REFERRER_VELOCITY: 'Many sign-ups with this code in a day',
};

export interface AdminReferral {
  id: string;
  referrer: Person | null;
  referred: Person | null;
  code: string;
  status: ReferralStatus;
  rewardStatus: ReferralRewardStatus;
  qualifyingOrder: { id: string; orderNumber: string; status: string } | string | null;
  attributionExpiresAt: string;
  referrerCoins: number;
  referredCoins: number;
  riskFlags: string[];
  decision?: { note?: string; at?: string };
  history: { status: ReferralStatus; at: string; note?: string }[];
  createdAt: string;
  rewardedAt: string | null;
}

interface RewardTotals {
  issued: number;
  redeemed: number;
  refundedRedemptions: number;
  netRedeemed: number;
  expired: number;
  reversed: number;
  orderRewards: number;
  reviewRewards: number;
  referralRewards: number;
  welcomeRewards: number;
  birthdayRewards: number;
  promotionalRewards: number;
}

export interface RewardsReport {
  days: number;
  allTime: RewardTotals;
  period: RewardTotals;
  daily: { date: string; issued: number; redeemed: number; expired: number }[];
  liability: { coins: number; paise: number; availableCoins: number; reservedCoins: number };
  wallets: { total: number; active: number };
  campaigns: {
    active: number;
    top: { id: string; name: string; type: CampaignType; status: CampaignStatus; claims: number; coins: number }[];
  };
  referrals: { byStatus: Record<string, number>; total: number; coinsPaid: number; held: number; flagged: number };
  suspicious: {
    heldReferrals: number;
    flaggedReferrals: number;
    uncollectedReversals: { wallets: number; coins: number };
    topEarners: { customer: Person | null; coins: number; credits: number }[];
  };
}
