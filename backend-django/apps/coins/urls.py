from django.urls import path

from . import views_admin as admin
from . import views_customer as customer

urlpatterns = [
    # Customer
    path("coins/wallet", customer.CoinWalletView.as_view()),
    path("coins/transactions", customer.CoinTransactionsView.as_view()),
    path("referrals/validate", customer.ReferralValidateView.as_view()),  # public
    path("referrals/me", customer.MyReferralView.as_view()),
    path("referrals/me/history", customer.MyReferralHistoryView.as_view()),
    path("rewards", customer.RewardsOverviewView.as_view()),
    path("rewards/campaigns", customer.RewardCampaignsView.as_view()),
    path("rewards/campaigns/<str:id>/claim", customer.RewardClaimView.as_view()),
    path("rewards/history", customer.RewardHistoryView.as_view()),
    path("rewards/birthday", customer.BirthdayView.as_view()),
    # Admin
    path("admin/rewards/configuration", admin.ConfigurationView.as_view()),
    path("admin/rewards/campaigns", admin.CampaignsView.as_view()),
    path("admin/rewards/campaigns/<str:id>", admin.CampaignView.as_view()),
    path("admin/rewards/campaigns/<str:id>/status", admin.CampaignStatusView.as_view()),
    path("admin/rewards/claims", admin.ClaimsView.as_view()),
    path("admin/rewards/transactions", admin.TransactionsView.as_view()),
    path("admin/rewards/transactions/<str:id>", admin.TransactionView.as_view()),
    path("admin/rewards/transactions/<str:id>/reverse", admin.ReverseView.as_view()),
    path("admin/rewards/wallets/<str:id>", admin.WalletView.as_view()),
    path("admin/rewards/reports", admin.ReportsView.as_view()),
    path("admin/rewards/referrals", admin.ReferralsView.as_view()),
    path("admin/rewards/referrals/<str:id>", admin.ReferralView.as_view()),
    path("admin/rewards/referrals/<str:id>/approve", admin.ReferralApproveView.as_view()),
    path("admin/rewards/referrals/<str:id>/reject", admin.ReferralRejectView.as_view()),
]
