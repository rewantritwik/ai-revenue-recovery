# Razorpay Test-Mode Reference

Source: Razorpay official docs — always re-check before the demo, since Razorpay updates these:
- https://razorpay.com/docs/payments/payments/test-card-details/
- https://razorpay.com/docs/errors/payments/cards/
- https://razorpay.com/docs/payments/payments/test-upi-details/

## Basic success/failure test instruments
- **Card (generic success)**: Visa `4111 1111 1111 1111`, any future expiry, any CVV
- **UPI success**: enter `success@razorpay` as the VPA
- **UPI failure**: enter `failure@razorpay` as the VPA
- On the mock bank page after any test card, you can click **Success** or **Failure** to force the outcome.
- For a random OTP: 4–10 digits = success, fewer than 4 digits = forces a failure (authentication_failed).

## Card error-scenario test numbers (trigger specific error codes)
| Error reason | Network | Test card number |
|---|---|---|
| payment_timed_out | Visa | 4100 2800 0001 0008 |
| payment_timed_out | Mastercard | 5305 6200 0008 0008 |
| gateway_technical_error | Visa | 4100 2800 0002 0007 |
| gateway_technical_error | Mastercard | 5305 6200 0009 0007 |
| authentication_failed | — | use OTP under 4 digits on any test card |

For error codes without a dedicated test card, force **Failure** on the mock bank page — Razorpay will let you pick or will assign a generic decline code.

## Full card error taxonomy (used for synthetic data + diagnosis engine)
Each maps to one root-cause bucket in our system:

| error_code | Our bucket | Why |
|---|---|---|
| payment_timed_out | TRANSIENT | customer took too long / network lag |
| gateway_technical_error | TRANSIENT | temporary bank/gateway downtime |
| bank_technical_error | TRANSIENT | customer's bank had downtime |
| payment_cancelled | CUSTOMER_ABANDONED | customer backed out mid-flow |
| card_declined | HARD_DECLINE | bank declined, reason not shared |
| payment_failed | HARD_DECLINE | generic bank decline |
| insufficient_funds | SOFT_DECLINE | not enough balance right now |
| incorrect_cvv | USER_ERROR | typo, immediately correctable |
| card_not_enrolled | ACTION_REQUIRED | card not enabled for online use |
| card_disabled_for_online_payments | ACTION_REQUIRED | same as above |
| debit_instrument_inactive | ACTION_REQUIRED | card not activated |
| debit_instrument_blocked | BLOCKED | card blocked by bank/customer |
| card_expired | EXPIRED | card past expiry |
| transaction_limit_exceeded | LIMIT_HIT | daily limit reached |
| authentication_failed | AUTH_FAILURE | wrong OTP / abandoned auth |
| payment_risk_check_failed | FRAUD_FLAG | bank suspects fraud — never auto-act |

## Subscriptions / mandates
- Card tokens in test mode are valid for only 3 days, so a subsequent auto-debit test must happen within that window.
- Mandate registration/authentication is mocked — no real 3DS/OTP involved.
