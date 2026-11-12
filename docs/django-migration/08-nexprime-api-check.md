# 8. NexPrime API check (Phase 2)

Generated from the **installed** type definitions (`frontend/node_modules/nexprime/types/nexprime.d.ts`, nexprime **0.1.5**), not from memory, per MASTER_PROMPT rule 11. Re-run this check after any NexPrime upgrade.

`*` marks a required input. `[(x)]` is a two-way `model()`. "Content" lists `<ng-content>` slots; "none" means the component can't host projected markup.

## 8.1 Components in the Material migration (05 §5.4)

| Selector | Inputs | Two-way | Outputs | Content |
|---|---|---|---|---|
| `np-button` | primary, severity, variant (`solid`/`outlined`/`soft`/`text`), shape, backgroundColor, size, label, icon, iconPos, loading, disabled, ariaLabel | – | clicked | **none** |
| `np-dialog` | header, subtitle, icon, variant, tone, modal, closable, dismissableMask, maximizable, position, width, draggable, blockScroll | visible | show, hide | default + `[dialogFooter]` |
| `np-modal` | title, variant, size, closeOnBackdrop, closeOnEscape | open | – | default + `[modalFooter]` |
| `np-bottom-sheet` | header, dismissable, showHandle, maxHeight | visible | show, hide | default |
| `np-confirm-dialog` (+ `ConfirmationService`) | key, variant | – | – | – |
| `np-pagination` | totalPages, siblings, variant, size, totalRecords, rowsOptions, showSummary, showFirstLast, showJump | page, rows | – | – |
| `np-spinner` | size, label | – | – | – |
| `np-progress-bar` | value, variant, showLabel, look, size, circular, indeterminate, buffer, segments, labelPosition, label | – | – | – |
| `np-menu` | model (`MenuItem[]`: label, icon, url, items, command, disabled), popup, variant, shortcuts | – | itemClick | – |
| `np-button-toggle` | options (`{value,label,icon,ariaLabel,disabled}[]`), multiple, vertical, showCheck, size, disabled, ariaLabel | value | – | – |
| `np-tabs` | tabs (`{id,label,content: string,icon,badge,disabled}[]`), variant, vertical, stretch | activeTab | – | **none** |
| `np-tooltip` | text, position, variant, tone, heading, shortcut, arrow, showDelay, hideDelay | – | – | default |
| `np-chip` | label, icon, image, variant, tone, size, count, selectable, pulse, removable, disabled | selected | remove | – |
| `np-tag` | value, severity, icon, rounded, variant, size, count, removable | – | remove | – |
| `np-table` | variant, size, striped, bordered, noWrap, scrollHeight, stickyFooter, footerNote, selectable, reorderable, reorderableColumns, expandable, detailKey, loading, rows, rowsOptions, paginator, showFirstLast, sortField, sortOrder, lazy, totalRecords, emptyMessage, filterable, filterPlaceholder, noResultsMessage | columns, data, selection | rowClick, rowAction, columnReorder, rowReorder, lazyLoad | `detail` template only |
| `np-toast` | message, type, position, duration, variant, title, action, pauseOnHover, swipeable | open | actionClick | **none** |
| `np-radio-group` | label, options, horizontal, disabled, variant | value | – | – |
| `np-header` | user, variant, brand, links, sticky, avatar | active | login, logout, createAccount | – |

## 8.2 Components for the new screens

| Selector | Inputs | Two-way | Outputs | Use |
|---|---|---|---|---|
| `np-input-otp` | length, integerOnly, mask, size, variant, placeholder, success, disabled, invalid, autofocus, separatorAfter, label, hint, resendSeconds | value | complete, resend | Phone login, delivery OTP |
| `np-file-upload` | mode, variant, hint, multiple, accept, maxFileSize, fileLimit, auto, disabled, chooseLabel, uploadLabel, cancelLabel, uploadHandler | – | select, upload, remove, clear, error | KYC documents |
| `np-image-upload` | variant, initials, maxFileSize, shape, width, aspectRatio, label, hint, disabled | value | fileSelect, remove | Rider photo, restaurant logo/cover |
| `np-stepper` | steps (`string \| {label,description,icon,error}`), variant, vertical, clickable, linear | activeStep | – | KYC wizard |
| `np-timeline` | value (`{status,date,icon,tone,description,tag}[]`), align, layout, variant, activeIndex, lineColor, dateOpposite | – | – | Order timeline, KYC history |
| `np-time-picker` | hourFormat, showSeconds, stepHour, stepMinute, mode, interval, minTime, maxTime, inline, label, placeholder, disabled, variant | value | – | Opening hours |
| `np-calendar` | selectionMode, inline, minDate, maxDate, disabledDates, disabledDays, firstDayOfWeek, showTime, hourFormat, showButtonBar, view, dateFormat, placeholder, label, disabled, showIcon, numberOfMonths, variant, marks, presets, showWeekNumbers | value | select, clear, monthChange | Holidays, coupon validity, report ranges |
| `np-select` | label, options, placeholder, ariaLabel, disabled, variant, icon, filter, multiple, layout | value, values | – | (already used) |
| `np-toggle` | label, disabled, variant, size, labelPosition, onLabel, offLabel, onIcon, offIcon | checked | – | (already used) |
| `np-checkbox` | label, description, disabled, invalid, variant, size, icon | checked, indeterminate | – | Add-on choices |
| `np-input-number` | min, max, step, showButtons, buttonLayout, variant, icon, meter, mode, currency, locale, min/maxFractionDigits, useGrouping, prefix, suffix, placeholder, label, hint, disabled, readonly, invalid | value | – | Prices, stock, radius |
| `np-skeleton` | shape, width, height, size, borderRadius, animation, variant, preset, lines, columns, duration | – | – | Loading states |
| `np-card` | title, subtitle, image, imageAlt, imagePosition, imageHeight, avatar, footerAlign, variant, horizontal, overlay, badge, href, clickable, loading | – | cardClick | Content + `[cardFooter]` |
| `np-alert` | type, title, message, dismissible, variant, icon, compact, closable | – | dismiss | `[alertActions]` slot |

## 8.3 Findings that change the migration plan

1. **`np-button` can't submit a form or be a link.** It always renders `<button type="button">`, has no `type` input and no content slot (text comes from `label`, the icon from `icon`). Consequences:
   - **Form submit buttons** stay native `<button type="submit">` with a shared `.bb-btn` class that copies the NexPrime button look from its tokens. The alternative, calling the form's submission from `(clicked)`, would lose Enter-to-submit.
   - **Links styled as buttons** (`<a mat-button routerLink>`) become `<a class="bb-btn">`, because a `<button>` inside an `<a>` is invalid HTML.
   - `np-button` is used for plain actions (`(clicked)`).
   - **Phase 13 task:** a `.bb-btn` family in `styles.scss` (solid, outlined, text, danger, icon-only) built on `--ui-*` tokens.
2. **`np-tabs` holds only string content.** With no content projection, tab panels can't contain components. Use `np-tabs` as the tab strip with `[(activeTab)]` and render the panels ourselves with `@switch`, giving each panel `role="tabpanel"` and the matching `aria-labelledby`. Check the id scheme against the rendered DOM first (the `uid` prefix is internal). Affected screens: `admin/operations/monitoring`, `admin/restaurants`, plus one more `mat-tab-group`.
3. **`np-menu` items have `url` and `command`, not `routerLink`.** In-app navigation uses `command: () => router.navigateByUrl(...)`. Keep a real `<a href>` for anything users may open in a new tab. The account menus use `routerLink` today, so build a small `menuLinks()` helper.
4. **Dialogs.** `np-dialog`/`np-modal` are declarative (`[(visible)]`) and project content, which suits simple in-page dialogs. Programmatic opening (`confirmed()`, the 23 component dialogs) uses **`BbDialog` (CDK)**, built and proved in this phase. Rider sheets may use `np-bottom-sheet`.
5. **Toast.** `np-toast` is a single declarative instance (`[(open)]`, `message`, `type`, `action`). A `ToastHost` component in the shell, driven by `NotificationService` signals, will replace `MatSnackBar`. It must queue messages, because only one shows at a time.
6. **Tables.** `np-table` is data-driven (`columns`, `data`, `lazy` + `lazyLoad`) with only a row-`detail` template. Admin lists today are custom card and row templates (only one uses `mat-table`), so most lists keep their own markup and swap only the paginator to `np-pagination` (`[(page)]`, `[(rows)]`, `totalRecords`).
7. **Forms.** `np-text-input`, `np-textarea`, `np-select`, `np-toggle`, `np-checkbox`, `np-input-number`, `np-input-otp`, `np-time-picker` and `np-calendar` all expose `[(value)]`/`[(checked)]` models, so they work with Signal Forms `[formField]` the way the existing inputs already do through `NP_FORM_FIELDS`. Add the new ones to that bundle when first used.

## 8.4 Theme tokens

NexPrime reads `--ui-*` tokens and switches to dark on `:root[data-theme='dark']`. BiteBox maps its `--bb-*` tokens onto them in both themes (`styles.scss`). Because NexPrime's dark block uses the same selector, ours must come later in the cascade (it does: `styles.scss` loads after `nexprime/styles/theme.css` in `angular.json`).
