import { test, expect, describe } from 'bun:test';
import { isLikelyPage, isLikelyVisit } from '../src/modules/index/browser-history.js';

/**
 * The first fixture is the exact URL that leaked into "open all the links I
 * visited today" on this machine — a Stripe 3-D Secure notify endpoint that
 * Chromium recorded as a visit with no title.
 */
describe('history candidate filtering', () => {
  const stripeNotify =
    'https://hooks.stripe.com/3d_secure_2/notify/acct_188ZXFGIpdKFUmPY/tds2_endrUUVmakRrSG9yemV2TlNGaGZEUzZiV0FFSGZuQlhCNVFwWDdUY0g1NCMSFwoVYWNjdF8xODhaWEZHSXBkS0ZVbVBZ';

  test('the Stripe 3-D Secure notify URL is rejected', () => {
    expect(isLikelyPage(stripeNotify)).toBe(false);
  });

  test('OAuth callbacks, redirects and subresources are rejected', () => {
    expect(isLikelyPage('https://auth.example.com/oauth/callback?code=abc')).toBe(false);
    expect(isLikelyPage('https://x.test/callback?state=1')).toBe(false);
    expect(isLikelyPage('https://cdn.test/app.js')).toBe(false);
    expect(isLikelyPage('https://cdn.test/logo.png?cache=1')).toBe(false);
  });

  test('absurdly long URLs are rejected', () => {
    expect(isLikelyPage(`https://example.com/${'a'.repeat(200)}`)).toBe(false);
  });

  test('ordinary pages survive', () => {
    expect(isLikelyPage('https://vercel.com/docs/ai-gateway')).toBe(true);
    expect(isLikelyPage('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isLikelyPage('https://github.com/Ritam369/men-backend')).toBe(true);
  });

  test('an untitled visit is not a candidate even when the URL is fine', () => {
    const url = 'https://api.test/v1/things';
    expect(isLikelyVisit({ url, title: url })).toBe(false);
    expect(isLikelyVisit({ url, title: '' })).toBe(false);
    expect(isLikelyVisit({ url: 'https://vercel.com/docs', title: 'Docs – Vercel' })).toBe(true);
  });

  test('the URL rules still apply inside the row-level check', () => {
    expect(isLikelyVisit({ url: stripeNotify, title: 'Some title' })).toBe(false);
  });
});
