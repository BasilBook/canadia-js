# @basilbook/canadia

Canadia Bank's KHQR payment gateway for Node: make a KHQR for an amount (its text, or an image of
it), ask where a payment stands, refund it. The sign-in token is kept for you. No framework; your
credentials are passed in, never read from the environment.

- Money in **integer minor units** with a currency code: riel whole, dollars in cents.
- Every refusal is a typed error naming Canadia's reason.
- A `log` hook that never sees a secret, an injectable `fetch` and clock, a token store of your own.
- ES modules and CommonJS, with types. Node 18 or later (it uses `fetch` and Node's `crypto`).

Made by BasilBook for [Bill&Go](https://billandgo.app), MIT. The PHP twin is
[`basilbook/canadia`](https://packagist.org/packages/basilbook/canadia) on Packagist, with **the
same calls** (see [the same calls in PHP](#the-same-calls-in-php)). KHQR itself is
[`@basilbook/khqr`](https://www.npmjs.com/package/@basilbook/khqr).

## Install

```sh
npm install @basilbook/canadia
```

## Quick start

```ts
import { CanadiaClient } from '@basilbook/canadia';

const canadia = new CanadiaClient({
  username: 'shop-login',
  password: process.env.CANADIA_PASSWORD!,
  apiKey: process.env.CANADIA_API_KEY!, // the merchant's hash key
  sandbox: true,
});

const khqr = await canadia.createKhqr({ externalId: '20261115-0007', amount: 450, currency: 'USD' });
// { paymentId, qr: '000201…', link?, expiresAt }

await canadia.status('20261115-0007');
// { status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired', refNumber, amount, currency }
```

`externalId` is yours and unique per merchant: Canadia refuses a second one (`duplicate`).

## A string or an image

```ts
const withImage = await canadia.createKhqr({ externalId: 'o2', amount: 20900, currency: 'KHR', format: 'image' });
withImage.image; // 'data:image/png;base64,…', drawn from withImage.qr
```

Canadia sends only the text; with `format: 'image'` the image is drawn from it by
`@basilbook/khqr/image` (`image: { type: 'svg', size, margin }` to choose).

## Refunds

```ts
const { refNumber } = await canadia.status('20261115-0007'); // Canadia's own reference, once paid
await canadia.refund({ refNumber: refNumber!, reason: 'Customer cancelled order' }); // the whole payment
await canadia.refund({ refNumber: refNumber!, reason: 'One drink missing', amount: 150, currency: 'USD' }); // part of it
// { refundRef, amount (minor units, null when Canadia gave none), currency, at }
```

Several partial refunds may add up to the payment, never more.

## Callbacks

Give `callbackUrl` to `createKhqr` and Canadia posts there when the payment moves. Treat it as a
doorbell: **ask `status(externalId)` before you settle anything**, and settle only on `paid` with
the amount you asked for.

## The sign-in token

Every call needs a JWT from Canadia's `/api/authenticate`. The client signs in on the first call,
keeps the token until a minute before its `exp` (five minutes when it has none), and signs in
again; a `PG_UNAUTHORIZED` answer drops the token and retries once. Two calls at once on one store
share one sign-in. To share tokens across clients (one made per request, say), give them one store:

```ts
import { CanadiaClient, CanadiaMemoryTokenStore } from '@basilbook/canadia';
const tokens = new CanadiaMemoryTokenStore();
const client = (account) => new CanadiaClient({ ...account, tokens });
```

Or keep them in your own cache with a `CanadiaTokenStore`: `get(key)` gives back
`{ token, expiresAt }` (or null), `set(key, token, expiresAt)` keeps it, `delete(key)` drops it; any
of them may return a Promise (Redis, a table). The token is a credential: keep it where the shop's
secrets are kept.

## API

Every call, with its PHP twin. A TypeScript options object is PHP named arguments with the same
names; `Promise<T>` is `T` in PHP.

| TypeScript | PHP (`BasilBook\Canadia\CanadiaClient`) | Returns | Throws |
|---|---|---|---|
| `new CanadiaClient(config)` | `new CanadiaClient($config, $http?, $requests?, $streams?)` | | |
| `createKhqr({ externalId, amount, currency, customerName?, callbackUrl?, format?, image? })` | `->createKhqr(externalId:, amount:, currency:, customerName:, callbackUrl:, format:, image:)` | `CanadiaKhqr` | `CanadiaInputError` (`format`; nothing sent), `CanadiaRefusedError`, `CanadiaUnreachableError` |
| `status(externalId)` | `->status($externalId)` | `CanadiaPayment` (an expired QR is `expired`, not an error; a status not known is `pending`) | `CanadiaRefusedError`, `CanadiaUnreachableError` |
| `refund({ refNumber, reason, amount?, currency? })` | `->refund(refNumber:, reason:, amount:, currency:)` | `CanadiaRefund`; without `amount`, the whole payment | `CanadiaInputError` (`amount`; nothing sent), `CanadiaRefusedError`, `CanadiaUnreachableError` |
| `baseUrl` | `->baseUrl()` | The base URL in use | |
| `canadiaHash(apiKey, values, timestampMs)` | `CanadiaClient::hash($apiKey, $values, $timestampMs)` | SHA-256 hex of the values run together, then the timestamp, then the key | |
| `jwtExpiresAt(token)` | `CanadiaClient::jwtExpiresAt($token)` | A JWT's `exp` in epoch ms, or null | |
| `CanadiaTokenStore`, `CanadiaMemoryTokenStore` | `CanadiaTokenStore`, `CanadiaMemoryTokenStore` | Where sign-in tokens are kept | |
| `CANADIA_URL`, `CANADIA_SANDBOX_URL`, `CANADIA_PATHS`, `CANADIA_REFUSALS` | `CanadiaClient::URL`, `::SANDBOX_URL`, `::PATHS`, `::REFUSALS` | Base URLs, paths, body codes to their reasons | |

| `CanadiaConfig` | |
|---|---|
| `username`, `password` | The merchant's login |
| `apiKey` | The merchant's hash key |
| `sandbox?` | `true`: `https://sandbox-pay.canadiabank.com.kh/sandbox`; else `https://pay.canadiabank.com.kh/payment-gateway/v2` |
| `baseUrl?` | Another base URL; wins over `sandbox` |
| `timeoutMs?` | 8000 |
| `now?()` | The clock (timestamps, token lifetimes), a `Date` |
| `tokens?` | A `CanadiaTokenStore`; a memory store of the client's own unless given |
| `decimals?(currency)` | Minor units per major; riel 0 and dollars 2 unless given |
| `log?(level, message)` | `info`, `warn`, `error`; never a secret |
| `fetch?` | Your `fetch`; the global one otherwise (PHP: a PSR-18 client) |

`CanadiaKhqr`: `paymentId`, `qr`, `link?` (Canadia's hosted page), `expiresAt`, `image?`.
`CanadiaPayment`: `status` (`pending`, `paid`, `failed`, `cancelled`, `expired`), `refNumber`,
`amount`, `currency` (null until Canadia gives them). `CanadiaRefund`: `refundRef`, `amount` (null
when Canadia gave none), `currency`, `at` (as Canadia wrote it).

Each call's `hash` covers: sign-in `username, password`; init `amount, externalId, currency`;
status `externalId`; refund `reason, refNumber` (and `amount, currency` for a partial one).

## Errors

All extend `CanadiaError` (PHP: `CanadiaException`, and each below is `…Exception` there).

| Class | Carries | When |
|---|---|---|
| `CanadiaRefusedError` | `reason`, `canadiaCode` | Canadia answered no. `reason`: `unauthorized`, `invalid_request`, `duplicate`, `not_found`, `expired`, `deeplink`, `merchant_inactive`, `merchant_unknown`, `merchant_unauthorized`, `maintenance`, `unknown` (`canadiaCode` `NO_QR` / `NO_TOKEN` when a success came without what it should carry) |
| `CanadiaUnreachableError` | `status` | No answer, a timeout, or no readable status |
| `CanadiaInputError` | `problem` (`amount`, `format`) | A partial refund without a currency or a whole amount above zero, or a format that is not `string` / `image`; nothing was sent |

Canadia answers most refusals as HTTP 200 (or 401) with the code in the body; the client reads the
body whatever the status.

## The same calls in PHP

`composer require basilbook/canadia` gives the same calls, the same requests, the same results and
the same errors, checked by tests that run this package's own requests and answers
(`tests/fixtures/ts-vectors.json`). What differs is only each language's own way: a function here is
a static method of `CanadiaClient` there (`canadiaHash` → `CanadiaClient::hash`); an options object
here is named arguments there; `Promise` here, a plain return there; `Date` here,
`DateTimeImmutable` there; a getter here (`baseUrl`) is a method there; `fetch` here, a PSR-18 HTTP
client there; `…Error` here, `…Exception` there, with the same properties.

## Sandbox and production

`sandbox: true` uses Canadia's sandbox and its test login. **Not yet confirmed against Canadia's
own specification** (read from its developer portal and public samples): how the paths join the
base URL, the hash convention and hex output, `paymentTimeoutMillis` read as epoch ms, and the
token's lifetime. Try the sandbox before production.

## Contributing and tests

In BasilBook's Bill&Go repository at `packages/canadia`; the PHP twin at `packages/php/canadia`. A
change to one is made to both: build, then run `node packages/php-vectors.mjs` to write the PHP
tests' vectors from this package, and run both test suites. The tests run a fake Canadia gateway
on a local port that checks every hash and token.

```sh
pnpm --filter @basilbook/canadia... build
pnpm --filter @basilbook/canadia test
```

Report a security issue privately through GitHub's *Report a vulnerability*, not in a public issue.

## License

MIT © BasilBook. See [LICENSE](./LICENSE).
