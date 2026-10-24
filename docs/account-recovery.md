# Account recovery and security email

The customer app requests a six-digit email code, verifies it, collects and confirms the new password, then resets navigation to Login. Reset tokens never enter URLs or persistent client storage. Passwords must be at least eight characters and at most 72 UTF-8 bytes (bcrypt's input limit).

Codes and reset permissions expire after 15 minutes. Every issuance replaces the previous code and reset permission. Concurrent requests are ordered by Firestore transaction commit; email delivery order does not determine which code is valid. Verification consumes a code once; password saving consumes the resulting reset permission once. Account deletion uses its own purpose-bound six-digit codes.

Each identity and purpose allows three requests per rolling hour, including resends and failed deliveries. Three incorrect code guesses across resends lock the identity until its three-hour security window ends. The security window starts with the first request and resets on the next request after three hours. Recovery endpoints also limit each IP to 30 requests per hour. Unknown email addresses receive the same normal request response as registered accounts.

The server-only `accountSecurityCodes` collection contains HMAC-protected codes and random reset token hashes, never plaintext codes. Existing Firestore default-deny rules protect this collection from all client reads and writes. Keep JWT_SECRET stable and secret across instances. All instances must use the same Firestore database and secret. Replacing the secret invalidates outstanding recovery state.

Password saving awaits Firebase Auth, refresh-token revocation and the Firestore bcrypt password write before returning success. A Firebase failure returns an error and permits retry with the same verified reset permission. These are separate services, so failure between writes can temporarily leave different passwords until retry succeeds. An in-progress claim prevents overlapping saves or code replacement. A process termination while a claim is in progress fails closed: investigate and clear that private record's `processing` flag before retrying; never clear an active worker's claim.

Deploy the backend with `assets/email-logo.png`, and release the customer app together with it: reset saving now requires email and confirmPassword; deletion codes changed from four to six digits. Legacy reset URL pages direct users to request a fresh code in the app.

## Email configuration and delivery

Configure SMTP_HOST, SMTP_PORT (587 STARTTLS or 465 TLS), SMTP_USER, SMTP_PASS, and optionally SMTP_FROM. Use a verified sender identity; when SMTP_FROM is omitted the display name is MS Traders. TLS certificate validation remains enabled. Messages contain an inline logo, emerald brand styling, HTML and plain text. SMTP acceptance is reported accurately; absence or rejection of SMTP delivery returns failure and invalidates that request's code. Codes and reset URLs are never logged.

Email is sent only through Nodemailer and the configured SMTP server. There is no additional email service, verification API, or provider registration step in the app. SMTP acceptance does not guarantee inbox placement. The six-digit code remains required for user authentication during password reset and account deletion.

Run `npm test` in backend for recovery, concurrency, throttling, delivery-failure and existing regression coverage. Recovery tests use deterministic in-memory transactions and a Firebase/SMTP stub; they do not send real messages or change production accounts.
