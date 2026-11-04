import { Paginated } from './api.models';

export type ReviewTarget = 'restaurant' | 'food' | 'rider';
export type ReviewStatus = 'published' | 'hidden' | 'removed' | 'deleted';
export type ReviewSort = 'newest' | 'oldest' | 'highest' | 'lowest';
export type ModerationAction = 'hide' | 'remove' | 'restore';
export type ReportReason =
  | 'spam'
  | 'offensive'
  | 'harassment'
  | 'personal_info'
  | 'irrelevant'
  | 'fake'
  | 'other';

/** Built from published reviews only. `distribution[i]` counts (i + 1)-star reviews. */
export interface RatingSummary {
  average: number;
  count: number;
  distribution?: number[];
}

export interface ReviewResponse {
  text: string;
  respondedAt: string;
  updatedAt: string;
}

/** What anyone may see: a shortened name, never contact or order details. */
export interface PublicReview {
  id: string;
  target: ReviewTarget;
  rating: number;
  comment: string;
  authorName: string;
  foodItem: string | null;
  foodName: string | null;
  images: string[];
  verifiedOrder: true;
  response: ReviewResponse | null;
  createdAt: string;
  editedAt: string | null;
}

export interface MyReview extends PublicReview {
  status: Exclude<ReviewStatus, 'deleted'>;
  order: string;
  orderNumber: string;
  restaurant: string;
  restaurantName?: string | null;
  restaurantSlug?: string | null;
  deliveryPartner: string | null;
  moderation: { action: ModerationAction; reason: string } | null;
  editableUntil: string | null;
}

export interface RestaurantReview extends PublicReview {
  orderNumber: string;
  reportedByYou: boolean;
}

export interface RiderReview {
  id: string;
  rating: number;
  comment: string;
  authorName: string;
  orderNumber: string;
  createdAt: string;
  editedAt: string | null;
  reportedByYou: boolean;
}

export interface ReviewPage<T> extends Paginated<T> {
  summary?: RatingSummary;
}

/** GET /orders/:id/reviews: what can be rated on one order, and what already was. */
export interface OrderReviewState {
  orderId: string;
  canReview: boolean;
  reason: string | null;
  closesAt: string | null;
  restaurant: { id: string; name: string; review: MyReview | null };
  items: { foodItem: string; name: string; review: MyReview | null }[];
  rider: { review: MyReview | null } | null;
}

export interface RestaurantReviewSummary {
  rating: RatingSummary;
  unanswered: number;
  foods: { id: string; name: string; rating: RatingSummary }[];
}

export interface ModerationEntry {
  action: ModerationAction | 'dismiss_reports';
  reason: string;
  fromStatus: ReviewStatus;
  toStatus: ReviewStatus;
  at: string;
  by: { id: string; name: string } | null;
}

export interface ReviewReportView {
  id: string;
  reason: ReportReason;
  note: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  reporterRole: string;
  reporterName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface AdminReview {
  id: string;
  target: ReviewTarget;
  status: ReviewStatus;
  rating: number;
  comment: string;
  customerName: string;
  orderNumber: string;
  order: string;
  restaurant: { id: string; name: string; slug?: string } | null;
  deliveryPartner: { id: string; name: string } | null;
  foodItem: string | null;
  foodName?: string;
  images?: string[];
  response?: { text?: string; respondedAt?: string; updatedAt?: string };
  openReports: number;
  moderation?: { action?: ModerationAction; reason?: string; at?: string };
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReviewDetail extends AdminReview {
  customer: { id: string; name: string; email: string } | null;
  edits: { rating: number; comment: string; replacedAt: string }[];
  moderationLog: ModerationEntry[];
  reports: ReviewReportView[];
}

/** Restaurant panel: one order's restaurant and dish reviews. */
export interface RestaurantOrderReviews {
  order: string;
  orderNumber: string;
  authorName: string;
  createdAt: string;
  unanswered: number;
  reviews: RestaurantReview[];
}

/** Admin: one order's reviews (rows carry the short form, the dialog the full records). */
export interface AdminOrderReviews<R = AdminReview> {
  order: string;
  orderNumber: string;
  customerName: string;
  restaurant: { id: string; name: string } | null;
  createdAt?: string;
  openReports: number;
  reviews: R[];
}

export interface AdminOrderReviewPage extends Paginated<AdminOrderReviews> {
  counts: Partial<Record<ReviewStatus | 'reported', number>>;
}

export interface RankedSubject {
  id: string;
  name: string;
  average: number;
  count: number;
}

export interface ReviewAnalytics {
  days: number;
  targets: Record<ReviewTarget, Required<RatingSummary>>;
  statusCounts: Partial<Record<ReviewStatus, number>>;
  newReviews: number;
  openReports: number;
  reportReasons: { reason: ReportReason; count: number }[];
  moderationActions: Partial<Record<ModerationAction | 'dismiss_reports', number>>;
  daily: { date: string; reviews: number; averageRating: number }[];
  restaurants: { top: RankedSubject[]; bottom: RankedSubject[] };
  riders: { top: RankedSubject[]; bottom: RankedSubject[] };
  minReviewsToRank: number;
}

/** Mirrors backend/config/reviews.js (REVIEW_POLICY): the API enforces the same limits. */
export const REVIEW_LIMITS = Object.freeze({
  comment: 1000,
  reply: 1000,
  reportNote: 300,
  moderationReason: 300,
  photos: 5,
  editDays: 30,
});

/** POST /orders/:id/reviews: one "Rate your experience" submission. */
export interface OrderRatingInput {
  restaurant?: number;
  food?: number;
  rider?: number;
  comment?: string;
  images?: string[];
}

export const TARGET_LABEL: Record<ReviewTarget, string> = {
  restaurant: 'Restaurant',
  food: 'Dish',
  rider: 'Delivery',
};

export const TARGET_PLURAL: Record<ReviewTarget, string> = {
  restaurant: 'Restaurants',
  food: 'Dishes',
  rider: 'Delivery partners',
};

/** "Restaurant", "Delivery", or the dish's name. */
export const subjectLabel = (r: { target: ReviewTarget; foodName?: string | null }): string =>
  r.target === 'food' ? (r.foodName ?? TARGET_LABEL.food) : TARGET_LABEL[r.target];

/** The customer may still change it (the API sends editableUntil only for published reviews). */
export const isEditable = (r: { editableUntil: string | null }): boolean =>
  !!r.editableUntil && Date.parse(r.editableUntil) > Date.now();

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  published: 'Published',
  hidden: 'Hidden',
  removed: 'Removed',
  deleted: 'Deleted by author',
};

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive language',
  harassment: 'Harassment or threats',
  personal_info: 'Shares personal information',
  irrelevant: 'Not about this order',
  fake: 'Fake or misleading',
  other: 'Something else',
};

export const SORT_LABEL: Record<ReviewSort, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  highest: 'Highest rated',
  lowest: 'Lowest rated',
};

export const SORT_OPTIONS = (Object.keys(SORT_LABEL) as ReviewSort[]).map((value) => ({
  value,
  label: SORT_LABEL[value],
}));

/** "Any rating", then 5 to 1 stars, as select options (values are strings). */
export const RATING_FILTER_OPTIONS = [
  { value: '', label: 'Any rating' },
  ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} star${n > 1 ? 's' : ''}` })),
];

/** What each admin action asks and says. The reason is always required and logged. */
export const MODERATION_COPY: Record<
  ModerationAction | 'dismiss',
  { title: string; message: string; confirm: string; done: string; reasonLabel: string; danger?: boolean }
> = {
  hide: {
    title: 'Hide this review?',
    message: 'It leaves public pages and ratings while you look into it. You can restore it later.',
    confirm: 'Hide review',
    done: 'Review hidden',
    reasonLabel: 'Reason (the author sees this)',
  },
  remove: {
    title: 'Remove this review?',
    message: 'Use this when the review breaks the review policy. It no longer counts towards any rating.',
    confirm: 'Remove review',
    done: 'Review removed',
    reasonLabel: 'Reason (the author sees this)',
    danger: true,
  },
  restore: {
    title: 'Restore this review?',
    message: 'It becomes public again and counts towards the rating.',
    confirm: 'Restore',
    done: 'Review restored',
    reasonLabel: 'Reason (for the log)',
  },
  dismiss: {
    title: 'Dismiss the reports?',
    message: 'The review stays as it is. The open reports are closed and the decision is logged.',
    confirm: 'Dismiss reports',
    done: 'Reports dismissed',
    reasonLabel: 'Reason (for the log)',
  },
};

/** Words for each star, used by the rating input and screen-reader text. */
export const RATING_WORDS = ['Terrible', 'Poor', 'Okay', 'Good', 'Excellent'] as const;

export const formatAverage = (summary: RatingSummary | null | undefined): string | null =>
  summary && summary.count > 0 ? summary.average.toFixed(1) : null;
