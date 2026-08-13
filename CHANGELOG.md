# Changelog

## Unreleased

### Added
- `brands` collection (`brandSchema`: name, logoUrl, order, isActive) + `/api/brands` (public list, admin CRUD), mirroring `categories.routes.js`.
- `category.parentId` — null for a top-level category, set to the parent's id for a sub-category (e.g. "Powder" under "Detergent"). `product.brandId` — optional link to a brand.
- `/api/products` accepts a `brandId` filter alongside the existing `categoryId` filter.
- `PATCH /api/orders/:id/payment-claimed` — order owner confirms they paid via UPI; moves `paymentStatus` from `PENDING` to `AWAITING_CONFIRMATION`. The shop/admin still verifies and marks it `PAID` separately (e.g. via `/api/orders/:id/status`).
- Firestore composite indexes for `brands (isActive, order)` and `products (brandId, createdAt)`.

### Changed
- `PAYMENT_METHOD.UPI` renamed to `PAYMENT_METHOD.UPI_MANUAL`. Its `paymentService` provider no longer auto-marks orders `PAID` on creation (it previously bypassed real payment entirely for a test flow) — it now returns `PENDING`, since UPI deep links have no reliable success callback. `RAZORPAY` stays reserved in the enum for a future real gateway; no provider is wired up for it.
- `PAYMENT_STATUS` gained `AWAITING_CONFIRMATION`, between `PENDING` and `PAID`.

### Deployment note
The two new Firestore composite indexes (`brands`, and `products.brandId`) need to be deployed to the `supamart-b9c9a` project before `/api/brands` and `/api/products?brandId=` will work — `firebase deploy --only firestore:indexes` (from an account with access), or click the auto-generated link Firestore returns in the `FAILED_PRECONDITION` error on first query.
