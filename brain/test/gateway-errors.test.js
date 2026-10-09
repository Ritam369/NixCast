import { test, expect, describe } from 'bun:test';
import { explainGatewayError } from '../src/modules/jev/gateway.js';

/**
 * These branches are the ones users actually hit, and the whole point of the
 * function is that it does not blame the wrong thing. The first case is the
 * exact response this machine received from a valid key.
 */
describe('gateway error explanations', () => {
  const verification = JSON.stringify({
    error: {
      message:
        'AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=… to add a card and unlock your free credits.',
      type: 'customer_verification_required',
    },
  });

  test('an unverified account is not reported as a bad key', () => {
    const out = explainGatewayError({ status: 403, body: verification });
    expect(out.message).toMatch(/verified/i);
    expect(out.message).toMatch(/credit card/i);
    expect(out.message).not.toMatch(/API key/i);
    expect(out.hint).toMatch(/payment method/i);
    expect(out.retryable).toBe(false);
  });

  test('a real auth failure does point at the key', () => {
    const body = JSON.stringify({ error: { message: 'Authentication failed.', type: 'authentication_error' } });
    const out = explainGatewayError({ status: 403, body });
    expect(out.message).toMatch(/rejected this API key/i);
    expect(out.hint).toMatch(/jev\.apiKey/);
  });

  test('a bare 401 is treated as an auth failure', () => {
    const out = explainGatewayError({ status: 401, body: '{}' });
    expect(out.message).toMatch(/rejected this API key/i);
  });

  test('an unexplained 403 still quotes the gateway and warns against assuming the key', () => {
    const body = JSON.stringify({ error: { message: 'Spend limit exceeded for this key.', type: 'spend_limit' } });
    const out = explainGatewayError({ status: 403, body });
    expect(out.message).toMatch(/Spend limit exceeded/);
    expect(out.hint).toMatch(/before suspecting the key/i);
  });

  test('a plan limit that mentions ZDR points at the setting we control', () => {
    // This is the exact class of failure this machine hit: a valid key, valid
    // model, and a 403 caused by an option this project sends itself.
    const body = JSON.stringify({
      error: {
        message: 'Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. Current plan: hobby.',
        type: 'permission_denied',
      },
    });
    const out = explainGatewayError({ status: 403, body });
    expect(out.message).toMatch(/Zero Data Retention/);
    expect(out.hint).toMatch(/jev\.zeroDataRetention to false/);
    expect(out.retryable).toBe(false);
  });

  test('a long body is still understood — the caller must pass it unclipped', () => {
    // Regression: the body was sliced at 500 characters before parsing, which
    // cut the JSON mid-string and reduced a precise explanation to "no detail".
    const body = JSON.stringify({
      error: {
        message: `Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. ${'x'.repeat(400)}`,
        type: 'permission_denied',
      },
    });
    expect(body.length).toBeGreaterThan(500);
    const out = explainGatewayError({ status: 403, body });
    expect(out.message).toMatch(/Zero Data Retention/);
    expect(out.hint).toMatch(/zeroDataRetention/);
  });

  test('a wrong model id names the model field', () => {
    const out = explainGatewayError({ status: 404, body: '{}' });
    expect(out.message).toMatch(/does not know this model/i);
    expect(out.hint).toMatch(/jev\.model/);
  });

  test('rate limiting is the one retryable case and says how to slow down', () => {
    const out = explainGatewayError({ status: 429, body: '{}' });
    expect(out.retryable).toBe(true);
    expect(out.hint).toMatch(/debounceMs/);
  });

  test('server errors are retryable', () => {
    expect(explainGatewayError({ status: 500, body: '{}' }).retryable).toBe(true);
    expect(explainGatewayError({ status: 503, body: '{}' }).retryable).toBe(true);
  });

  test('a non-JSON body falls back to the original message', () => {
    const out = explainGatewayError({ status: 502, body: '<html>bad gateway</html>', fallback: 'socket hang up' });
    expect(out.message).toBe('socket hang up');
    expect(out.retryable).toBe(true);
  });

  test('no status and no body degrades to something honest', () => {
    const out = explainGatewayError({});
    expect(out.message).toMatch(/no status/);
    expect(out.retryable).toBe(false);
  });

  test('a truncated body does not throw', () => {
    // bodyOf() slices for display, so a parse failure must be survivable.
    expect(() => explainGatewayError({ status: 403, body: '{"error":{"message":"AI Gate' })).not.toThrow();
  });
});
