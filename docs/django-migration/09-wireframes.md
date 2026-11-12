# 9. Wireframes for new screens (Phase 2)

Low-fidelity layouts for the screens listed in [05-frontend-plan.md §5.3](05-frontend-plan.md#53-new-screens), drawn mobile-first for customers and riders and desktop-first for restaurants and admins. Components named are NexPrime unless marked otherwise (see [08-nexprime-api-check.md](08-nexprime-api-check.md)). All forms use Signal Forms. Copy is indicative.

## 9.1 Phone login with OTP (customer, release 2)

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ [logo]                       │   │ [logo]                       │
│ Sign in with your phone      │   │ Enter the code               │
│ ┌──────┬───────────────────┐ │   │ Sent to +91 98•••••001  Edit │
│ │ +91 ▾│ 98000 00001       │ │   │  ┌─┐┌─┐┌─┐ ┌─┐┌─┐┌─┐         │
│ └──────┴───────────────────┘ │   │  │4││8││2│ │9││1││3│ np-input-otp
│ We'll text you a 6-digit code│   │  └─┘└─┘└─┘ └─┘└─┘└─┘         │
│ [ Send code ]  (submit)      │   │  ✕ Wrong code. 3 tries left  │
│ ───────── or ─────────       │   │ Resend in 0:24 (resendSeconds)│
│ Sign in with email →         │   │ [ Verify ]                   │
└──────────────────────────────┘   └──────────────────────────────┘
```
- The OTP is submitted automatically on `complete`.
- Errors come from the server: `OTP_INVALID` (with `attemptsLeft`), `OTP_EXPIRED` (shows "Send a new code") and `OTP_LOCKED` (shows "Try again in 15 minutes").
- A first-time number adds a "Your name" step before Verify (`purpose: register`).

## 9.2 Food dialog with variants and add-ons (customer, release 2)

```
┌──────────────────────────────────────┐
│ [photo carousel]                   ✕ │
│ ● Paneer Tikka                ★ 4.4  │
│ Smoky cottage cheese, mint chutney   │
│ Size (choose 1)               required│
│  (•) Half              ₹240          │   np-radio-group
│  ( ) Full              ₹420          │
│ Extra toppings (up to 3)             │
│  [✓] Cheese            +₹30          │   np-checkbox ×n
│  [ ] Onion rings       +₹40          │   "Pick at most 3" under the group
│ Instructions (optional)              │
│ ┌──────────────────────────────────┐ │   np-textarea, 200 max
│ │ Less spicy                       │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ [ − 1 + ]        [ Add · ₹270 ]      │   fixed footer, live total
└──────────────────────────────────────┘
```
On phones it opens as a bottom sheet (`np-bottom-sheet`); on desktop it's a `BbDialog`. Cart lines show the variant and add-ons under the dish name, with "Edit".

## 9.3 Delivery OTP: customer card and rider entry (MVP)

```
Customer order page (picked_up / on_the_way)    Rider active delivery
┌──────────────────────────────┐                ┌──────────────────────────────┐
│ [live map]                   │                │ Drop: Asha V. · 2.1 km (road)│
│ Rider is on the way · ~12 min│                │ [ Navigate ]  [ Call ]       │
│ ┌──────────────────────────┐ │                │                              │
│ │ Share this code with your│ │                │ Ask the customer for the code│
│ │ rider at the door        │ │                │  ┌─┐┌─┐┌─┐┌─┐                │
│ │      4  8  2  1          │ │                │  │ ││ ││ ││ │  np-input-otp(4)│
│ │ Don't share it before    │ │                │  └─┘└─┘└─┘└─┘                │
│ │ you have your order.     │ │                │ [ Complete delivery ]        │
│ └──────────────────────────┘ │                │ Can't deliver? Report a problem│
└──────────────────────────────┘                └──────────────────────────────┘
```
The code is shown large, with `aria-label="Delivery code 4 8 2 1"`. After 5 wrong attempts the rider sees "Locked. Contact support" with a support button.

## 9.4 Rider active delivery steps (MVP)

```
┌──────────────────────────────┐
│ ●───●───○───○  np-stepper    │  Accepted · At restaurant · Picked up · Delivered
│ Spice Route Kitchen  1.4 km  │
│ [ Navigate to restaurant ]   │  external map link
│ [ I've arrived ]             │  → arrived_at_restaurant (warns if > 200 m away)
│ Order BB-24-000183 · 3 items │
│ [ Confirm pickup ]           │
└──────────────────────────────┘
```

## 9.5 KYC wizard (restaurant and rider, MVP)

```
┌────────────────────────────────────────────────────────────────┐
│ Verify your restaurant                         Status: Pending  │
│ ●──────●──────○──────○   Business · Documents · Bank · Review   │ np-stepper (linear)
├────────────────────────────────────────────────────────────────┤
│ Documents                                                       │
│ FSSAI licence *    [fssai.pdf ✓ Accepted]                        │
│                     No. ••••1234 · Expires 31 Mar 2028           │
│ PAN card *         [ Choose file ] PDF/JPG/PNG up to 5 MB        │ np-file-upload
│ Cancelled cheque * [cheque.jpg ✕ Rejected: "Image is blurred"]   │ np-tag danger + Re-upload
│ Shop photo *       [ Choose file ]                               │
├────────────────────────────────────────────────────────────────┤
│                         [ Back ]  [ Save and continue ]         │
└────────────────────────────────────────────────────────────────┘
```
- The rider version has these steps: Profile photo (`np-image-upload`), Licence, Vehicle RC, ID proof, Bank.
- While the status is `needs_resubmission`, a banner (`np-alert`, warning) lists what to fix.
- "Go online" stays disabled with the reason until KYC is approved.

## 9.6 Opening hours and holidays (restaurant, release 2)

```
┌──────────────────────────────────────────────────────────────┐
│ Opening hours                     Time zone: Asia/Kolkata     │
│ Mon  [11:00]–[15:00]  [18:30]–[23:30]  + Add slot            │ np-time-picker pairs
│ Tue  [11:00]–[23:00]                   + Add slot            │
│ ...                                                           │
│ Sun  Closed  [ toggle ]                                      │
│ [ Copy Monday to all days ]                                  │
├──────────────────────────────────────────────────────────────┤
│ Holidays                                                     │
│ [ calendar (np-calendar, inline) ]   12 Nov · Diwali   ✕     │
│                                       25 Dec · —        ✕     │
│ [ Save ]                                                     │
└──────────────────────────────────────────────────────────────┘
```
Validation: a slot can't close at the time it opens, slots must not overlap, at most 3 per day. Errors show under the day row.

## 9.7 Menu item editor with variants and add-on groups (restaurant, release 2)

```
┌──────────────────────────────────────────────────────────────┐
│ Edit dish                                                  ✕ │
│ Name [Paneer Tikka        ]  Category [Starters ▾]  ● Veg     │
│ Price ₹[240] (used when no variants)   Stock [ ∞ / 25 ]       │
│ Variants                                                      │
│  Name [Half ] Price ₹[240] (•) default   🗑                   │
│  Name [Full ] Price ₹[420] ( ) default   🗑                   │
│  + Add variant                                                │
│ Add-on groups   [✓] Extra toppings (0–3)  [ ] Dips (1–1)      │
│                 Manage add-on groups →                        │
│ Photos  [img][img][ + ]                                       │
├──────────────────────────────────────────────────────────────┤
│                                       [ Cancel ] [ Save ]    │
└──────────────────────────────────────────────────────────────┘
```

## 9.8 Admin: KYC review (MVP)

```
┌───────────────┬──────────────────────────────────────────────────────┐
│ Queue         │ Spice Route Kitchen · submitted 2 h ago               │
│ ▸ Restaurants │ FSSAI 1234••••••1234 · expires 31 Mar 2028            │
│   Spice Route │ ┌──────────────────────────┐  Documents               │
│   Dosa Plaza  │ │  [document preview]      │  ✓ FSSAI licence          │
│ ▸ Riders (3)  │ │  signed URL, 5 min       │  ● PAN card      ← viewing│
│               │ └──────────────────────────┘  ✕ Cancelled cheque       │
│               │ [ Accept ] [ Reject… (reason required) ]               │
│               │ ─────────────────────────────────────────────          │
│               │ [ Approve restaurant ] (enabled when all accepted)     │
│               │ [ Ask to resubmit… ]  [ Reject… ]                      │
└───────────────┴──────────────────────────────────────────────────────┘
```
Every document view and decision is written to the audit log.

## 9.9 Admin: settings (release 2)

```
┌──────────────────────────────────────────────────────────────┐
│ Platform settings     [Pricing][Dispatch][Earnings][Delivery][COD] │ np-tabs strip
│ Pricing · revision 7 · changed by Super Admin, 3 Nov          │
│ Delivery base fee   ₹[25]   covers first [2] km               │
│ Per extra km        ₹[8]    capped at ₹[99]                   │
│ Free delivery from  ₹[499]  Platform fee ₹[5]  GST [5]%       │
│ Max delivery distance [15] km                                 │
│ ⚠ Applies to new orders only. Placed orders keep their prices.│
│ [ View history ]                     [ Discard ] [ Save ]     │
└──────────────────────────────────────────────────────────────┘
```
Saving opens a confirmation that shows a diff (old → new) before it applies.

## 9.10 Admin: partial refund (MVP)

```
┌────────────────────────────────────────┐
│ Refund order BB-24-000183            ✕ │
│ Paid ₹612 online · already refunded ₹0 │
│ Amount  ₹[120     ]  (max ₹612)        │ np-input-number
│ Reason  [Missing item ▾]               │
│ Note    [Raita missing from order    ] │
├────────────────────────────────────────┤
│               [ Cancel ] [ Refund ₹120 ]│ danger, confirms before sending
└────────────────────────────────────────┘
```

## 9.11 Reorder result (customer, release 2)

```
┌──────────────────────────────┐
│ Added 3 items to your cart   │  np-toast with action "View cart"
│ 1 item is no longer available│
│ · Mango Lassi (unavailable)  │
└──────────────────────────────┘
```
