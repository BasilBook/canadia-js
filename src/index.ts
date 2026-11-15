/**
 * @basilbook/canadia (#1687): Canadia Bank's KHQR payment gateway for Node — make a KHQR (its
 * text, or an image of it), ask where a payment stands, refund it. The sign-in token is kept for
 * you. Credentials are passed in, never read from the environment; amounts are integer minor units
 * with their currency. The PHP twin, `basilbook/canadia`, has the same calls (`CanadiaClient`,
 * `CanadiaClient::hash`, …).
 */
export {
  CanadiaClient,
  CanadiaMemoryTokenStore,
  canadiaHash,
  jwtExpiresAt,
  CANADIA_URL,
  CANADIA_SANDBOX_URL,
  CANADIA_PATHS,
  CANADIA_REFUSALS,
  type CanadiaConfig,
  type CanadiaKeptToken,
  type CanadiaTokenStore,
  type CanadiaLogLevel,
  type CanadiaKhqr,
  type CanadiaKhqrParams,
  type CanadiaPayment,
  type CanadiaRefund,
  type CanadiaStatus,
} from './client.js';
export {
  CanadiaError,
  CanadiaRefusedError,
  CanadiaUnreachableError,
  CanadiaInputError,
  type CanadiaInputProblem,
  type CanadiaRefusal,
} from './errors.js';
