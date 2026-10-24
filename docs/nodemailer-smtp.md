# Nodemailer SMTP email

Reset and deletion emails are sent by Nodemailer directly through the SMTP server in the backend environment. There is no paid email integration, additional email API, or verification service. The app's six-digit code remains the user identity check.

## Gmail setup

For `SMTP_HOST=smtp.gmail.com`, Gmail requires a valid App Password belonging to the exact Google account in SMTP_USER. Generate it at https://myaccount.google.com/apppasswords while signed into that account. Google requires 2-Step Verification on the sender account to offer App Passwords. The sender's ordinary Gmail account password does not work for this SMTP login. App Passwords can be revoked, including when the account password changes.

Set the following values in backend/.env for local development and in the backend hosting environment for deployment:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-sending-account@gmail.com
SMTP_PASS=your-new-app-password
SMTP_FROM="MS Traders <your-sending-account@gmail.com>"
```

SMTP_PASS is a secret. Keep it out of Git, screenshots and chat. Grouped spaces from Google's App Password display are accepted and normalized for Gmail only. Other SMTP passwords retain their original whitespace. Port 587 uses STARTTLS; port 465 uses implicit TLS. Both use Nodemailer.

Save the file and restart the backend after changing credentials. For a hosted backend, save the new environment value and restart/redeploy that service so its running process reads it. Local .env and the hosted environment are separate.

Run in backend:

```
npm run smtp:check
```

This checks SMTP connectivity and login without sending an email, issuing a reset code, or consuming the user's code quota. It is an operator diagnostic command, not an additional app verification step. It uses the same Nodemailer transport as the app. Once it succeeds, request a code from Forgot password to test an actual app email.

## Errors

- `EAUTH`, `535`, `5.7.8`: Gmail rejected the supplied login. Confirm that SMTP_USER is the account that generated the App Password, replace a revoked/incorrect App Password and restart the backend. A syntactically correct 16-character string can still be an invalid password.
- `SMTP_NOT_CONFIGURED` / `SMTP_INVALID_PORT`: fix the missing environment settings or invalid port.
- `EDNS`, `ECONNECTION`, `ESOCKET`, `ETIMEDOUT`: check DNS/network access to the configured SMTP host and port from the actual backend host.

The SMTP diagnostic and delivery logs include error codes and actionable guidance. They do not print passwords, codes, email bodies, recipient addresses or raw SMTP responses. Failed email delivery continues returning an error and invalidating the undelivered code.

SMTP login success confirms authentication. SMTP acceptance of a message does not prove inbox receipt. Test a real app reset request to confirm receipt once Gmail accepts the login.

References: https://nodemailer.com/guides/using-gmail and https://support.google.com/mail/answer/185833
