/** Why Canadia Bank's gateway refused, named from the body code it answered with (`status.errorCode`). */
export type CanadiaRefusal =
  | 'unauthorized'
  | 'invalid_request'
  | 'duplicate'
  | 'not_found'
  | 'expired'
  | 'deeplink'
  | 'merchant_inactive'
  | 'merchant_unknown'
  | 'merchant_unauthorized'
  | 'maintenance'
  | 'unknown';

/**
 * Every error this package throws is a `CanadiaError`, so one `instanceof` catches them all. The PHP
 * twin throws the same as `CanadiaException`, `CanadiaRefusedException`, … with the same properties.
 */
export class CanadiaError extends Error {
  override name = 'CanadiaError';
}

/**
 * Canadia's gateway refused a call: its reason, and the body code it answered with (`NONE` when it
 * gave none, `NO_QR` / `NO_TOKEN` when a success came back without what it should carry).
 */
export class CanadiaRefusedError extends CanadiaError {
  override name = 'CanadiaRefusedError';
  constructor(
    readonly reason: CanadiaRefusal,
    readonly canadiaCode: string,
  ) {
    super(`Canadia Bank refused the request: ${reason} (${canadiaCode})`);
  }
}

/** Canadia did not answer at all: no connection, a timeout, or no readable status. */
export class CanadiaUnreachableError extends CanadiaError {
  override name = 'CanadiaUnreachableError';
  constructor(readonly status: number | null = null) {
    super('Canadia Bank did not answer');
  }
}

/** Why a call was refused before anything was sent. */
export type CanadiaInputProblem = 'amount' | 'format';

/**
 * What was asked cannot be sent as it is (nothing was sent): a partial refund with no amount above
 * zero or no currency (`amount`), or a QR format that is not `string` or `image` (`format`).
 */
export class CanadiaInputError extends CanadiaError {
  override name = 'CanadiaInputError';
  constructor(
    readonly problem: CanadiaInputProblem,
    message: string,
  ) {
    super(message);
  }
}
