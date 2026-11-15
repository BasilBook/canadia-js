# Changelog

Every version of `@basilbook/canadia`, newest first. The PHP twin `basilbook/canadia` carries the same
version for the same change: the same calls, checked against the same test vectors. Versions follow
[semantic versioning](https://semver.org).

## 0.1.0 — unreleased

The first release, taken out of Bill&Go.

- `CanadiaClient`: `createKhqr` (KHQR text, or an image with `format: 'image'`), `status`, `refund` (whole or partial).
- The sign-in token kept until its `exp`, renewed once on `PG_UNAUTHORIZED`, in a `CanadiaTokenStore` (`CanadiaMemoryTokenStore` unless given) that clients can share.
- Signing: `canadiaHash`, `jwtExpiresAt`.
- Typed errors: `CanadiaRefusedError` (with Canadia’s reason), `CanadiaUnreachableError`, `CanadiaInputError`.
