# ADR 0052: Single-use sign-in nonces issued by the server

Status: accepted

Lightly edited for outside readers.

## Context

A sign-in sends the provider's ID token and the raw nonce the app chose. The API checked that the token carried
that nonce, but it neither issued the nonce nor remembered it. Google puts the nonce in the token as sent, so anyone
who captured a Google ID token for our audience had both halves and could sign in as that person until the token
expired, about an hour later. Apple embeds only the SHA-256 of the nonce, which makes a captured Apple token harder
to replay, but the same gap exists in principle. The re-check before deleting an account accepts the same kind of
token, within 10 minutes of issue.

This was found in an internal security review and rated low, because it needs a captured token first.

## Decision

### The flow

1. The app asks `POST /auth/nonce` for a nonce right before it opens Apple's or Google's sheet, for a sign-in and
   for the re-check before deleting an account.
2. The API makes 32 random bytes, returns them as base64url (43 characters) with the expiry, and stores only the
   SHA-256 of the value with that expiry, in `sign_in_nonce`.
3. The app gives the provider the nonce (Apple gets its SHA-256 hex, Google the raw value) and sends the raw value
   back with the ID token, to `/auth/apple`, `/auth/google` or `DELETE /me`. The request bodies are unchanged.
4. The API validates the token as before (signature, issuer, audience, expiry, nonce claim, and for deletion also
   the account's `sub` and the 10 minute age). Only then does it use the nonce: one statement deletes the row with
   that hash if it has not expired. If no row was deleted, the request fails like a bad token: 401 for a sign-in,
   403 for a deletion.

A nonce is used once. A replayed token carries a nonce whose row is gone, so it is refused. Two requests racing with
the same nonce cannot both win: the delete is atomic, and only one of them removes the row.

### Details

- **Expiry: 10 minutes.** Long enough to finish Apple's or Google's sheet, including a password or a second factor,
  and the same as the deletion re-check's limit.
- **Anonymous and rate limited.** A sign-in starts signed out, so the endpoint needs no token. It shares the
  sign-in rate limit per client address. A row is a 32-byte hash and a timestamp. The daily cleanup that already
  removes expired refresh tokens also removes expired nonces, in batches, using the index on the expiry. Most rows
  are gone sooner, because a sign-in deletes its own.
- **Not bound to a provider, a purpose or an account.** A nonce works for either provider and for a sign-in or a
  deletion. Binding adds nothing against replay: the token is already bound to its nonce by the provider's
  signature, and the nonce can be used only once. Deletion still requires the token's `sub` to be the signed-in
  account's.
- **Used only after the token is valid.** A bad token does not use up the nonce, and the database is written only
  for a request that passes every other check.
- **Stateless API.** The rows live in PostgreSQL, so any instance can issue a nonce and any other can accept it.
- **Never logged.** Neither the nonce nor its hash appears in logs. A refusal logs the reason only
  (`NonceNotIssued`).

### Scope

This stays inside the users module (the auth endpoints, the account deletion check, the entity and its
configuration, the cleanup job, one migration) and the app's sign-in code. The sync protocol, the token formats and
the bodies of the existing endpoints do not change. The generated TypeScript API client gains the new endpoint.

### Older builds

A build from before this change makes its own nonce, which the API never issued, so its sign-ins are refused with
the same answer as a bad token. Sessions already signed in keep working, because refresh does not involve a nonce.
At the time only internal test builds were in use, so the API and a new build went out together with no transition
period. Accepting an app-made nonce for a while would have kept the gap open for exactly that while.

## Consequences

- The replay gap is closed for Google and Apple, at sign-in and at the deletion re-check.
- Every sign-in makes one more small request before the provider's sheet opens. Sign-in already needs a connection.
- One small table and a cleanup step. Nonces that are asked for and never used stay until the daily cleanup. The
  rate limit bounds how fast that can grow.
