# Closing a sign-in token replay gap with server-issued nonces

## What happened

Nothing was exploited. I found this in a security review of the API. It was rated low because it needs a captured
token first, but the fix was small, and I shipped it while the only build in use was my own test build.

## The cause

Sign in with Apple and Google works with OpenID Connect ID tokens. The app makes a random nonce, gives it to the
provider, and the provider signs a token that contains it. The app then sends the token and the raw nonce to my
API, which checks the signature, issuer, audience, expiry and that the token's nonce matches the one sent.

The gap: the server neither issued the nonce nor remembered it. Google puts the nonce in the token as sent. So
anyone who captured a Google ID token for my app's audience had both halves and could sign in as that person until
the token expired, about an hour later. Apple puts only a SHA-256 of the nonce in its token, which makes replay
harder, but the same gap existed in principle. The re-check before deleting an account accepted the same kind of
token.

## How I found it

Reading the token validator during the review: the nonce check compared two values that both came from the client,
and nothing on the server remembered a nonce after it was used.

## The fix

The server now issues every nonce and accepts each one once (ADR 0052).

1. Right before opening Apple's or Google's sheet, the app calls `POST /auth/nonce`. The API returns 32 random bytes
   as base64url with a 10 minute expiry and stores only their SHA-256.
2. The app gives the nonce to the provider and sends it back with the ID token, as before.
3. The API validates the token fully first. Only then does it use the nonce, with one atomic statement that deletes
   the row with that hash if it has not expired. No row deleted means the request fails exactly like a bad token.

Details I cared about:

- Using the nonce last means a bad token never burns a valid nonce, and the database is written only for requests
  that pass every other check.
- One `DELETE ... WHERE hash = @hash AND expires_at > @now` decides the race. Two requests with the same nonce
  cannot both succeed.
- The nonce lives in PostgreSQL, so the API stays stateless and any instance can accept a nonce another issued.
- Neither the nonce nor its hash is ever logged. A refusal logs only the reason.
- The endpoint is anonymous and shares the sign-in rate limit. The existing daily cleanup removes expired rows.

## What it prevents now

`NonceTests` runs against a real PostgreSQL in Testcontainers, through the real endpoints:

- a nonce signs in once, and the replay is refused, for both providers.
- a nonce the app made itself is refused.
- an expired nonce is refused.
- a token with the wrong audience does not use up the nonce.
- six requests racing with one nonce produce exactly one sign-in.
- a sign-in token cannot be replayed to delete the account.
- the cleanup removes only expired rows.
- the nonce and its hash never appear in the logs.
