const express = require('express');
const supertest = require('supertest');
const { parseTrustProxyHops, configureTrustProxy } = require('../../src/config/proxy');
const validateEnv = require('../../src/config/validateEnv');

describe('TRUST_PROXY_HOPS', () => {
  const original = process.env.TRUST_PROXY_HOPS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = original;
  });

  it('defaults to one hop and reads whole numbers from 0 to 5', () => {
    expect(parseTrustProxyHops(undefined)).toEqual({ hops: 1, error: null });
    expect(parseTrustProxyHops('0')).toEqual({ hops: 0, error: null });
    expect(parseTrustProxyHops(' 2 ')).toEqual({ hops: 2, error: null });
    expect(parseTrustProxyHops('abc').error).toMatch(/whole number from 0 to 5/);
    expect(parseTrustProxyHops('9').error).toMatch(/whole number from 0 to 5/);
    expect(parseTrustProxyHops('-1').error).toMatch(/whole number from 0 to 5/);
  });

  it('decides which X-Forwarded-For entry becomes req.ip', async () => {
    const ipFor = async (hops) => {
      process.env.TRUST_PROXY_HOPS = String(hops);
      const app = configureTrustProxy(express());
      app.get('/ip', (req, res) => res.json({ ip: req.ip }));
      return (await supertest(app).get('/ip').set('X-Forwarded-For', '203.0.113.9, 198.51.100.7')).body.ip;
    };
    expect(await ipFor(0)).not.toMatch(/203\.0\.113\.9|198\.51\.100\.7/);
    expect(await ipFor(1)).toBe('198.51.100.7');
    expect(await ipFor(2)).toBe('203.0.113.9');
  });

  it('refuses to boot with an invalid value', () => {
    process.env.TRUST_PROXY_HOPS = 'lots';
    expect(() => validateEnv()).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('is what the app uses', () => {
    delete process.env.TRUST_PROXY_HOPS;
    const app = require('../../src/app');
    expect(app.get('trust proxy')).toBe(1);
  });
});
