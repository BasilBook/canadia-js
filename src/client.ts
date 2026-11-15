import { createHash } from 'node:crypto';
import { khqrImage, type KhqrImageOptions } from '@basilbook/khqr/image';
import { CanadiaInputError, CanadiaRefusedError, CanadiaUnreachableError, type CanadiaRefusal } from './errors.js';

/** Canadia Bank's payment gateway, production and sandbox. */
export const CANADIA_URL = 'https://pay.canadiabank.com.kh/payment-gateway/v2';
export const CANADIA_SANDBOX_URL = 'https://sandbox-pay.canadiabank.com.kh/sandbox';

/** Paths as the developer portal lists them, joined onto the base URL. Unconfirmed against Canadia's spec: see the README. */
export const CANADIA_PATHS = {
  authenticate: '/api/authenticate',
  init: '/tps/api/payment/init',
  status: '/tps/api/payment/status',
  refund: '/tps/api/payment/refund',
} as const;

/** Body codes (`status.errorCode`) to the reason they mean, from the portal's error table. */
export const CANADIA_REFUSALS: ReadonlyMap<string, CanadiaRefusal> = new Map<string, CanadiaRefusal>([
  ['PG_UNAUTHORIZED', 'unauthorized'],
  ['PG_INVALID_REQUEST', 'invalid_request'],
  ['PG_EXTERNAL_ID_EXIST', 'duplicate'],
  ['PYM_NOT_FOUND', 'not_found'],
  ['PG_GET_STATUS_FAILED', 'expired'],
  ['PG_GENERATE_DEEPLINK_FAILED', 'deeplink'],
  ['PG_MERCHANT_INACTIVE', 'merchant_inactive'],
  ['PG_MERCHANT_NOT_EXIST', 'merchant_unknown'],
  ['PG_MERCHANT_UNAUTHORIZED', 'merchant_unauthorized'],
  ['PG_SYSTEM_UNDER_MAINTENANCE', 'maintenance'],
]);

/** What Canadia says a KHQR's payment is. `expired`: the QR's time ran out before anyone paid. */
export type CanadiaStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired';

/** Status strings (`data.status`). Anything else is read as pending: never settle on what is not understood. */
const STATUSES = new Map<string, CanadiaStatus>([
  ['PENDING', 'pending'],
  ['SUCCESS', 'paid'],
  ['FAILED', 'failed'],
  ['CANCELLED', 'cancelled'],
]);

/** The gateway's `status.code` for success. */
const OK = 0;
/** Refresh a token this long before its `exp`, so a call never leaves with one about to die. */
const TOKEN_SLACK_MS = 60_000;
/** A token with no `exp` lives this long here, until Canadia states a lifetime. */
const TOKEN_FALLBACK_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 8000;
const DECIMALS: Readonly<Record<string, number>> = { KHR: 0, USD: 2 };

/** A number Canadia sent, as a number or a numeric string; null for anything else. */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) return null;
  return Number(value);
}

/**
 * The `hash` every request carries: the values run together, then the timestamp in ms, then the API
 * key, SHA-256, hex. Read from Canadia's public samples, not from its spec (see the README).
 */
export const canadiaHash = (apiKey: string, values: string[], timestampMs: number): string =>
  createHash('sha256')
    .update([...values, String(timestampMs), apiKey].join(''))
    .digest('hex');

/** The `exp` of a JWT in epoch ms, or null when it has none. Read only; the gateway checks it. */
export function jwtExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A kept sign-in token and when to stop using it (epoch ms). */
export interface CanadiaKeptToken {
  token: string;
  expiresAt: number;
}

/**
 * Where a login's sign-in token (a JWT) is kept between calls, one per base URL and login. The
 * default keeps it in memory for the client's life; give one store to every client of the same
 * logins (a client made per request keeps its token this way), or keep it in your own cache (Redis,
 * a table). Each method may answer at once or with a Promise. The token is a credential: keep it
 * where the shop's secrets are kept. The PHP twin's interface has the same name and methods.
 */
export interface CanadiaTokenStore {
  get(key: string): CanadiaKeptToken | null | undefined | Promise<CanadiaKeptToken | null | undefined>;
  set(key: string, token: string, expiresAt: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Tokens in memory. The default `CanadiaTokenStore`. */
export class CanadiaMemoryTokenStore implements CanadiaTokenStore {
  private readonly tokens = new Map<string, CanadiaKeptToken>();

  get(key: string): CanadiaKeptToken | null {
    return this.tokens.get(key) ?? null;
  }

  set(key: string, token: string, expiresAt: number): void {
    this.tokens.set(key, { token, expiresAt });
  }

  delete(key: string): void {
    this.tokens.delete(key);
  }
}

/** The sign-ins on their way, per store and key, so two calls at once (even of two clients) share one. */
const signingIn = new WeakMap<CanadiaTokenStore, Map<string, Promise<string>>>();

export type CanadiaLogLevel = 'info' | 'warn' | 'error';

export interface CanadiaConfig {
  /** The merchant's login. */
  username: string;
  password: string;
  /** The merchant's hash key: what every request's `hash` is made with. */
  apiKey: string;
  /** Canadia's sandbox: calls go to `CANADIA_SANDBOX_URL`, paid with test money. */
  sandbox?: boolean;
  /** Another base URL than Canadia's own (a proxy, a test server). Wins over `sandbox`. */
  baseUrl?: string;
  /** Your `fetch`, for a test or a runtime without a global one. Read at each call otherwise. */
  fetch?: typeof fetch;
  /** How long one call may take, in milliseconds. 8 seconds unless given. */
  timeoutMs?: number;
  /** The clock: timestamps and token lifetimes read it. The system's unless given. */
  now?: () => Date;
  /** Where sign-in tokens are kept. A memory store of the client's own unless given. */
  tokens?: CanadiaTokenStore;
  /** Minor units in a major unit, per money. Riel 0 and dollars 2 unless given. */
  decimals?: (currency: string) => number;
  /** Told what happened, without a secret in it. Silent unless given. */
  log?: (level: CanadiaLogLevel, message: string) => void;
}

/** A KHQR made by Canadia for one amount. */
export interface CanadiaKhqr {
  /** Canadia's `paymentId`, kept beside your `externalId`. */
  paymentId: string;
  /** The KHQR text a bank app scans (`paymentQr`). */
  qr: string;
  /** Canadia's hosted KHQR page for it (`paymentKHQRLink`), when it gave one. */
  link?: string;
  /** When the QR stops taking payment (`paymentTimeoutMillis`, read as epoch ms). */
  expiresAt: Date;
  /** With `format: 'image'`: the QR drawn from `qr`, as a `data:` URL (Canadia sends no image). */
  image?: string;
}

/** What Canadia says about one payment, asked by your `externalId`. Amount and currency are null when it gave none. */
export interface CanadiaPayment {
  status: CanadiaStatus;
  /** Canadia's bank transaction id (`refNumber`): what a refund names. Null until it has one. */
  refNumber: string | null;
  /** Minor units. */
  amount: number | null;
  currency: string | null;
}

/** A refund Canadia made: its own reference, and the money given back in minor units (null when it gave none). */
export interface CanadiaRefund {
  refundRef: string;
  amount: number | null;
  currency: string;
  /** Canadia's `refundTrxnDate`, as it sent it. */
  at: string;
}

export interface CanadiaKhqrParams {
  /** Your reference for the payment: unique per merchant (Canadia refuses a second one as `duplicate`). */
  externalId: string;
  /** Integer minor units: riel whole, dollars in cents. */
  amount: number;
  currency: string;
  customerName?: string;
  /** Where Canadia posts when the payment moves. */
  callbackUrl?: string;
  /** `string` (the default): the KHQR text. `image`: the text and an image drawn from it. */
  format?: 'string' | 'image';
  /** How to draw the image (`@basilbook/khqr/image`). */
  image?: KhqrImageOptions;
}

/** What one call got back: the body's status and its data. */
interface Answer {
  code: number;
  errorCode: string | null;
  data: Record<string, unknown> | undefined;
}

/**
 * One merchant login on Canadia Bank's KHQR gateway. A login's JWT is kept until shortly before its
 * `exp`, then fetched again; a body code `PG_UNAUTHORIZED` drops the token and retries once. Every
 * refusal is a typed error (`CanadiaRefusedError`, `CanadiaUnreachableError`).
 */
export class CanadiaClient {
  private readonly tokens: CanadiaTokenStore;

  constructor(private readonly config: CanadiaConfig) {
    this.tokens = config.tokens ?? new CanadiaMemoryTokenStore();
  }

  /** The base URL this client talks to. */
  get baseUrl(): string {
    return (this.config.baseUrl ?? (this.config.sandbox ? CANADIA_SANDBOX_URL : CANADIA_URL)).replace(/\/$/, '');
  }

  /** Minor units to the decimal Canadia takes: 450 cents → 4.5, 20900 riel → 20900. */
  private major(minor: number, currency: string): number {
    const d = this.decimals(currency);
    return Number((minor / 10 ** d).toFixed(d));
  }

  /** Canadia's decimal back to minor units. */
  private minor(amount: number, currency: string): number {
    return Math.round(amount * 10 ** this.decimals(currency));
  }

  /** Make a KHQR for one amount. Throws `CanadiaInputError` (nothing sent) for a format other than `string` or `image`. */
  async createKhqr(params: CanadiaKhqrParams): Promise<CanadiaKhqr> {
    const format = params.format ?? 'string';
    if (format !== 'string' && format !== 'image') throw new CanadiaInputError('format', `A QR is asked as 'string' or 'image', not '${String(format)}'`);
    const amount = this.major(params.amount, params.currency);
    const data = await this.send(CANADIA_PATHS.init, (ts) =>
      this.signed(
        ts,
        {
          amount,
          ccy: params.currency,
          externalId: params.externalId,
          paymentType: 'KHQR',
          ...(params.customerName ? { customerName: params.customerName } : {}),
          ...(params.callbackUrl ? { callbackUrl: params.callbackUrl } : {}),
        },
        [String(amount), params.externalId, params.currency],
      ),
    );
    const qr = typeof data.paymentQr === 'string' ? data.paymentQr : '';
    const expiresAt = numeric(data.paymentTimeoutMillis);
    if (!qr || expiresAt === null) throw new CanadiaRefusedError('unknown', 'NO_QR');
    return {
      paymentId: String(data.paymentId ?? ''),
      qr,
      ...(typeof data.paymentKHQRLink === 'string' ? { link: data.paymentKHQRLink } : {}),
      expiresAt: new Date(expiresAt),
      ...(format === 'image' ? { image: await khqrImage(qr, { ...params.image, as: 'dataUrl' }) } : {}),
    };
  }

  /** Where one payment stands, by your `externalId`. An expired QR is `expired`, not an error. */
  async status(externalId: string): Promise<CanadiaPayment> {
    try {
      const data = await this.send(CANADIA_PATHS.status, (ts) => this.signed(ts, { type: 'EXTERNAL_ID', externalId }, [externalId]));
      const status = STATUSES.get(String(data.status));
      if (!status) this.log('warn', `Canadia status ${String(data.status)} is not known: read as pending`);
      const hasAmount = typeof data.amount === 'number' && typeof data.ccy === 'string';
      return {
        status: status ?? 'pending',
        refNumber: typeof data.refNumber === 'string' ? data.refNumber : null,
        amount: hasAmount ? this.minor(data.amount as number, data.ccy as string) : null,
        currency: hasAmount ? (data.ccy as string) : null,
      };
    } catch (e) {
      if (e instanceof CanadiaRefusedError && e.reason === 'expired') {
        return { status: 'expired', refNumber: null, amount: null, currency: null };
      }
      throw e;
    }
  }

  /**
   * Give money back on a payment, by Canadia's `refNumber`. Without `amount` it refunds the whole
   * payment; with it (minor units, and its currency), a partial refund. Several partial refunds may
   * add up to the payment, never more.
   */
  async refund(params: { refNumber: string; reason: string; amount?: number; currency?: string }): Promise<CanadiaRefund> {
    const partial = params.amount !== undefined;
    if (partial && (!params.currency || !Number.isInteger(params.amount) || (params.amount as number) <= 0)) {
      throw new CanadiaInputError('amount', 'A partial refund needs a whole amount above zero and its currency.');
    }
    const amount = partial ? this.major(params.amount as number, params.currency as string) : undefined;
    const data = await this.send(CANADIA_PATHS.refund, (ts) =>
      partial
        ? this.signed(ts, { refNumber: params.refNumber, amount, ccy: params.currency, reason: params.reason }, [
            params.reason,
            params.refNumber,
            String(amount),
            params.currency as string,
          ])
        : this.signed(ts, { refNumber: params.refNumber, reason: params.reason }, [params.reason, params.refNumber]),
    );
    const currency = String(data.refundCcy ?? params.currency ?? '');
    const refunded = numeric(data.refundAmount);
    return {
      refundRef: String(data.refundTrxnRef ?? ''),
      amount: refunded === null ? null : this.minor(refunded, currency),
      currency,
      at: String(data.refundTrxnDate ?? ''),
    };
  }

  /** A body with its `timestamp` and `hash`; the hash covers `hashed` in order, as the portal lists them. */
  private signed(timestampMs: number, fields: Record<string, unknown>, hashed: string[]): Record<string, unknown> {
    return { ...fields, timestamp: String(timestampMs), hash: canadiaHash(this.config.apiKey, hashed, timestampMs) };
  }

  /** Sends one signed call with the login's token. A `PG_UNAUTHORIZED` gets one fresh token and one more try. */
  private async send(path: string, build: (timestampMs: number) => Record<string, unknown>): Promise<Record<string, unknown>> {
    let answer = await this.post(path, build(this.now()), await this.token());
    if (answer.errorCode === 'PG_UNAUTHORIZED') {
      await this.tokens.delete(this.key());
      answer = await this.post(path, build(this.now()), await this.token());
    }
    if (answer.code !== OK) {
      this.log('warn', `Canadia ${path} refused: ${answer.errorCode ?? 'no code'}`);
      throw this.refused(answer.errorCode);
    }
    return answer.data ?? {};
  }

  /** The login's token: the kept one while it lasts, else one sign-in (shared by calls at once). */
  private async token(): Promise<string> {
    const key = this.key();
    const kept = await this.tokens.get(key);
    if (kept && this.now() < kept.expiresAt) return kept.token;
    let mine = signingIn.get(this.tokens);
    if (!mine) signingIn.set(this.tokens, (mine = new Map()));
    const pending = mine.get(key);
    if (pending) return pending;
    const shared = mine;
    const next = this.authenticate(key).finally(() => shared.delete(key));
    shared.set(key, next);
    return next;
  }

  private async authenticate(key: string): Promise<string> {
    const ts = this.now();
    const answer = await this.post(
      CANADIA_PATHS.authenticate,
      this.signed(ts, { username: this.config.username, password: this.config.password }, [this.config.username, this.config.password]),
    );
    if (answer.code !== OK) {
      this.log('warn', `Canadia sign-in refused: ${answer.errorCode ?? 'no code'}`);
      throw this.refused(answer.errorCode);
    }
    const token = typeof answer.data?.token === 'string' ? answer.data.token : '';
    if (!token) throw new CanadiaRefusedError('unknown', 'NO_TOKEN');
    const exp = jwtExpiresAt(token);
    const expiresAt = exp !== null ? exp - TOKEN_SLACK_MS : this.now() + TOKEN_FALLBACK_MS;
    await this.tokens.set(key, token, expiresAt);
    return token;
  }

  /** One POST. The body's status is read whatever the HTTP status: Canadia answers refusals as 200 or 401. */
  private async post(path: string, body: Record<string, unknown>, token?: string): Promise<Answer> {
    const send = this.config.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await send(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      this.log('warn', `Canadia ${path} did not answer: ${e instanceof Error ? e.message : String(e)}`);
      throw new CanadiaUnreachableError();
    }
    const json = (await res.json().catch(() => null)) as {
      status?: { code?: unknown; errorCode?: unknown };
      data?: Record<string, unknown>;
    } | null;
    if (typeof json?.status?.code !== 'number') {
      this.log('warn', `Canadia ${path} answered ${res.status} with no status`);
      throw new CanadiaUnreachableError(res.status);
    }
    return {
      code: json.status.code,
      errorCode: typeof json.status.errorCode === 'string' ? json.status.errorCode : null,
      data: json.data,
    };
  }

  private refused(errorCode: string | null): CanadiaRefusedError {
    const reason = (errorCode && CANADIA_REFUSALS.get(errorCode)) || 'unknown';
    return new CanadiaRefusedError(reason, errorCode ?? 'NONE');
  }

  private key(): string {
    return `${this.baseUrl}|${this.config.username}`;
  }

  private now(): number {
    return (this.config.now?.() ?? new Date()).getTime();
  }

  private decimals(currency: string): number {
    return this.config.decimals?.(currency) ?? DECIMALS[currency] ?? 2;
  }

  private log(level: CanadiaLogLevel, message: string): void {
    this.config.log?.(level, message);
  }
}
