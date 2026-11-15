import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanadiaClient,
  CanadiaInputError,
  CanadiaRefusedError,
  CanadiaMemoryTokenStore,
  type CanadiaKeptToken,
  type CanadiaTokenStore,
  CanadiaUnreachableError,
  canadiaHash,
  jwtExpiresAt,
  type CanadiaConfig,
} from '../src/index';

/** A fake Canadia gateway on a local port. It checks each request's hash and token the way the portal describes. */
const API_KEY = 'fake-api-key-for-spec-only';
const USERNAME = 'shop-login-spec';
const PASSWORD = 'fake-password-spec';

/** A token that lives `seconds` from now, as a JWT with an `exp` claim. */
const jwt = (seconds: number | null) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = seconds === null ? {} : { exp: Math.floor(Date.now() / 1000) + seconds };
  return `${b64({ alg: 'HS512' })}.${b64(claims)}.sig`;
};

type Handler = (body: Record<string, unknown>) => { status?: number; json: unknown };
const routes = new Map<string, Handler>();
const seen: { path: string; body: Record<string, unknown>; auth: string | undefined }[] = [];
let tokenLife: number | null = 3600;
let issued = 0;
let currentToken = '';
let server: Server;
let base = '';

const ok = (data: unknown) => ({ json: { status: { code: 0, message: null, errorCode: null }, data } });
const refuse = (errorCode: string, status = 200) => ({ status, json: { status: { code: 1, message: errorCode, errorCode } } });

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse((await read(req)) || '{}') as Record<string, unknown>;
    const path = req.url ?? '';
    seen.push({ path, body, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (path === '/api/authenticate') {
      const expected = canadiaHash(API_KEY, [String(body.username), String(body.password)], Number(body.timestamp));
      if (body.username !== USERNAME || body.password !== PASSWORD || body.hash !== expected) {
        return res.end(JSON.stringify(refuse('PG_UNAUTHORIZED').json));
      }
      issued += 1;
      currentToken = jwt(tokenLife);
      return res.end(JSON.stringify(ok({ token: currentToken }).json));
    }
    // Every other call: a valid bearer token is needed.
    if (req.headers.authorization !== `Bearer ${currentToken}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify(refuse('PG_UNAUTHORIZED', 401).json));
    }
    const answer = routes.get(path)?.(body) ?? refuse('PG_INVALID_REQUEST');
    res.statusCode = answer.status ?? 200;
    res.end(JSON.stringify(answer.json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  routes.clear();
  seen.length = 0;
  issued = 0;
  tokenLife = 3600;
});

afterEach(() => vi.useRealTimers());

const client = (extra: Partial<CanadiaConfig> = {}) => new CanadiaClient({ username: USERNAME, password: PASSWORD, apiKey: API_KEY, baseUrl: base, ...extra });
const initOk = () => ok({ paymentId: 'p1', paymentQr: '000201', paymentTimeoutMillis: Date.now() + 300000 });

describe('canadiaHash', () => {
  it('runs the values together, then the timestamp, then the key, as SHA-256 hex', () => {
    const expected = createHash('sha256').update('100order_1KHR' + '1700000000000' + 'key').digest('hex');
    expect(canadiaHash('key', ['100', 'order_1', 'KHR'], 1700000000000)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is what the gateway checks: a request signed with another key is refused', async () => {
    await expect(client({ apiKey: 'wrong-key' }).createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' })).rejects.toMatchObject({ reason: 'unauthorized' });
  });
});

describe('the kept token', () => {
  it('signs in once and reuses the token across calls', async () => {
    routes.set('/tps/api/payment/init', initOk);
    const c = client();
    await c.createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' });
    await c.createKhqr({ externalId: 'o2', amount: 100, currency: 'USD' });
    expect(issued).toBe(1);
  });

  it('shares a token between clients given one store, and one sign-in between calls at once', async () => {
    routes.set('/tps/api/payment/init', initOk);
    const tokens = new CanadiaMemoryTokenStore();
    await client({ tokens }).createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' });
    await client({ tokens }).createKhqr({ externalId: 'o2', amount: 100, currency: 'USD' });
    expect(issued).toBe(1);
    const fresh = new CanadiaMemoryTokenStore();
    await Promise.all([client({ tokens: fresh }).createKhqr({ externalId: 'o3', amount: 100, currency: 'USD' }), client({ tokens: fresh }).createKhqr({ externalId: 'o4', amount: 100, currency: 'USD' })]);
    expect(issued).toBe(2);
  });

  it('keeps the token in a store of your own, which may answer with a Promise', async () => {
    routes.set('/tps/api/payment/init', initOk);
    const kept = new Map<string, CanadiaKeptToken>();
    const tokens: CanadiaTokenStore = {
      get: async (key) => kept.get(key),
      set: async (key, token, expiresAt) => void kept.set(key, { token, expiresAt }),
      delete: async (key) => void kept.delete(key),
    };
    await client({ tokens }).createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' });
    await client({ tokens }).createKhqr({ externalId: 'o2', amount: 100, currency: 'USD' });
    expect(issued).toBe(1);
    expect([...kept.keys()]).toEqual([`${base}|${USERNAME}`]);
  });

  it('signs in again once the token is near its exp', async () => {
    routes.set('/tps/api/payment/init', initOk);
    tokenLife = 600;
    let now = Date.parse('2030-01-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const c = client({ now: () => new Date(now) });
    await c.createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' });
    now = Date.parse('2030-01-01T00:09:30Z'); // 9.5 minutes of a 10-minute token: inside the 60-second slack
    await c.createKhqr({ externalId: 'o2', amount: 100, currency: 'USD' });
    expect(issued).toBe(2);
  });

  it('reads a JWT’s exp, or none', () => {
    expect(jwtExpiresAt(jwt(null))).toBeNull();
    expect(jwtExpiresAt(jwt(60))).toBeGreaterThan(Date.now());
    expect(jwtExpiresAt('not-a-jwt')).toBeNull();
  });

  it('signs in again and retries once when the gateway says the token is no good', async () => {
    routes.set('/tps/api/payment/init', initOk);
    const c = client();
    await c.createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' });
    currentToken = 'stale';
    await c.createKhqr({ externalId: 'o2', amount: 100, currency: 'USD' });
    expect(issued).toBe(2);
  });
});

describe('body codes to typed errors', () => {
  const cases: [string, string][] = [
    ['PG_INVALID_REQUEST', 'invalid_request'],
    ['PG_EXTERNAL_ID_EXIST', 'duplicate'],
    ['PYM_NOT_FOUND', 'not_found'],
    ['PG_GENERATE_DEEPLINK_FAILED', 'deeplink'],
    ['PG_MERCHANT_INACTIVE', 'merchant_inactive'],
    ['PG_MERCHANT_NOT_EXIST', 'merchant_unknown'],
    ['PG_MERCHANT_UNAUTHORIZED', 'merchant_unauthorized'],
    ['PG_SYSTEM_UNDER_MAINTENANCE', 'maintenance'],
    ['SOMETHING_NEW', 'unknown'],
  ];
  it.each(cases)('maps %s to %s', async (code, reason) => {
    routes.set('/tps/api/payment/init', () => refuse(code));
    const err = await client().createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanadiaRefusedError);
    expect(err).toMatchObject({ reason, canadiaCode: code });
  });

  it('is unreachable when no status comes back', async () => {
    const fetch = (async () => new Response('<html>down</html>', { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(client({ fetch }).createKhqr({ externalId: 'o1', amount: 100, currency: 'USD' })).rejects.toBeInstanceOf(CanadiaUnreachableError);
  });
});

describe('status', () => {
  const statusOf = (s: string) => {
    routes.set('/tps/api/payment/status', () => ok({ externalId: 'o1', status: s, refNumber: 'FT1', amount: 4.5, ccy: 'USD' }));
    return client().status('o1');
  };

  it.each([
    ['PENDING', 'pending'],
    ['SUCCESS', 'paid'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
  ])('reads %s as %s, with the amount in minor units', async (raw, status) => {
    expect(await statusOf(raw)).toEqual({ status, refNumber: 'FT1', amount: 450, currency: 'USD' });
  });

  it('reads a status it does not know as pending, and says so', async () => {
    routes.set('/tps/api/payment/status', () => ok({ status: 'WHATEVER' }));
    const logged: string[] = [];
    expect((await client({ log: (_l, m) => logged.push(m) }).status('o1')).status).toBe('pending');
    expect(logged).toEqual(['Canadia status WHATEVER is not known: read as pending']);
  });

  it('reads an expired QR (PG_GET_STATUS_FAILED) as expired, not as an error', async () => {
    routes.set('/tps/api/payment/status', () => refuse('PG_GET_STATUS_FAILED'));
    expect(await client().status('o1')).toEqual({ status: 'expired', refNumber: null, amount: null, currency: null });
  });

  it('signs the status call by externalId, timestamp and key', async () => {
    routes.set('/tps/api/payment/status', () => ok({ status: 'PENDING' }));
    await client().status('o1');
    const call = seen.find((c) => c.path === '/tps/api/payment/status')!;
    expect(call.body).toMatchObject({ type: 'EXTERNAL_ID', externalId: 'o1' });
    expect(call.body.hash).toBe(canadiaHash(API_KEY, ['o1'], Number(call.body.timestamp)));
  });
});

describe('refunds', () => {
  const refundOK = () => ok({ refundTrxnRef: 'FT9', refundTrxnDate: '20261114 10:00:00', refundAmount: 9.9, refundCcy: 'USD' });

  it('refunds a whole payment by its refNumber, with the reason, no amount', async () => {
    routes.set('/tps/api/payment/refund', refundOK);
    expect(await client().refund({ refNumber: 'FT1', reason: 'Customer cancelled order' })).toEqual({ refundRef: 'FT9', amount: 990, currency: 'USD', at: '20261114 10:00:00' });
    const call = seen.find((c) => c.path === '/tps/api/payment/refund')!;
    expect(call.body).not.toHaveProperty('amount');
    expect(call.body.hash).toBe(canadiaHash(API_KEY, ['Customer cancelled order', 'FT1'], Number(call.body.timestamp)));
  });

  it('refunds part of a payment: amount and currency go in and into the hash', async () => {
    routes.set('/tps/api/payment/refund', refundOK);
    await client().refund({ refNumber: 'FT1', reason: 'Customer dispute', amount: 990, currency: 'USD' });
    const call = seen.find((c) => c.path === '/tps/api/payment/refund')!;
    expect(call.body).toMatchObject({ refNumber: 'FT1', amount: 9.9, ccy: 'USD', reason: 'Customer dispute' });
    expect(call.body.hash).toBe(canadiaHash(API_KEY, ['Customer dispute', 'FT1', '9.9', 'USD'], Number(call.body.timestamp)));
  });

  it('refuses a partial refund with no currency or no amount above zero before sending anything', async () => {
    await expect(client().refund({ refNumber: 'FT1', reason: 'x', amount: 100 })).rejects.toBeInstanceOf(CanadiaInputError);
    await expect(client().refund({ refNumber: 'FT1', reason: 'x', amount: 100 })).rejects.toMatchObject({ problem: 'amount' });
    await expect(client().refund({ refNumber: 'FT1', reason: 'x', amount: 0, currency: 'USD' })).rejects.toBeInstanceOf(CanadiaInputError);
    expect(seen).toHaveLength(0);
  });
});

describe('createKhqr', () => {
  it('returns the KHQR string and its expiry, and signs amount, externalId and currency', async () => {
    const expiry = Date.now() + 300000;
    routes.set('/tps/api/payment/init', () => ok({ paymentId: 'p1', paymentQr: '00020101021230', paymentKHQRLink: 'https://x', paymentTimeoutMillis: expiry }));
    const out = await client().createKhqr({ externalId: 'o1', amount: 450, currency: 'USD' });
    expect(out).toEqual({ paymentId: 'p1', qr: '00020101021230', link: 'https://x', expiresAt: new Date(expiry) });
    const call = seen.find((c) => c.path === '/tps/api/payment/init')!;
    expect(call.body).toMatchObject({ amount: 4.5, ccy: 'USD', externalId: 'o1', paymentType: 'KHQR' });
    expect(call.body.hash).toBe(canadiaHash(API_KEY, ['4.5', 'o1', 'USD'], Number(call.body.timestamp)));
    expect(call.auth).toMatch(/^Bearer /);
  });

  it('sends riel with no decimals', async () => {
    routes.set('/tps/api/payment/init', () => ok({ paymentId: 'p2', paymentQr: 'q', paymentTimeoutMillis: Date.now() + 1000 }));
    await client().createKhqr({ externalId: 'o2', amount: 20900, currency: 'KHR' });
    expect(seen.find((c) => c.path === '/tps/api/payment/init')!.body.amount).toBe(20900);
  });

  it('draws the image from the string with format image', async () => {
    routes.set('/tps/api/payment/init', initOk);
    const out = await client().createKhqr({ externalId: 'o3', amount: 100, currency: 'USD', format: 'image', image: { type: 'svg' } });
    expect(out.image).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(out.qr).toBe('000201');
  });

  it('refuses a success with no QR on it, or no time it runs out', async () => {
    routes.set('/tps/api/payment/init', () => ok({ paymentId: 'p1' }));
    await expect(client().createKhqr({ externalId: 'o4', amount: 100, currency: 'USD' })).rejects.toMatchObject({ reason: 'unknown', canadiaCode: 'NO_QR' });
    routes.set('/tps/api/payment/init', () => ok({ paymentId: 'p1', paymentQr: 'q', paymentTimeoutMillis: null }));
    await expect(client().createKhqr({ externalId: 'o5', amount: 100, currency: 'USD' })).rejects.toMatchObject({ reason: 'unknown', canadiaCode: 'NO_QR' });
    routes.set('/tps/api/payment/init', () => ok({ paymentId: 'p1', paymentQr: 'q', paymentTimeoutMillis: '1900000000000' }));
    expect((await client().createKhqr({ externalId: 'o6', amount: 100, currency: 'USD' })).expiresAt.getTime()).toBe(1900000000000);
  });

  it('refuses a format other than string or image before sending anything', async () => {
    await expect(client().createKhqr({ externalId: 'o7', amount: 100, currency: 'USD', format: 'gif' as 'image' })).rejects.toMatchObject({ problem: 'format' });
    expect(seen).toHaveLength(0);
  });
});

describe('credentials', () => {
  it('never reach the log', async () => {
    routes.set('/tps/api/payment/status', () => refuse('PG_MERCHANT_INACTIVE'));
    const logged: string[] = [];
    await client({ log: (_l, m) => logged.push(m) }).status('o1').catch(() => undefined);
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(API_KEY);
  });
});
