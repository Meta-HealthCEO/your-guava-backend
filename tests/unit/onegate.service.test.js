const oneGate = require('../../src/services/onegate.service');

describe('OneGate runtime configuration', () => {
  let nodeEnv;

  beforeEach(() => {
    nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    if (nodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  });

  it('accepts only the credential-free official HTTPS origin in production', () => {
    expect(oneGate.cleanBaseUrl('https://payments.onegate.co.za/'))
      .toBe('https://payments.onegate.co.za');
    expect(() => oneGate.cleanBaseUrl('http://payments.onegate.co.za'))
      .toThrow(/HTTPS/i);
    expect(() => oneGate.cleanBaseUrl('https://payments.attacker.example'))
      .toThrow(/official OneGate/i);
    expect(() => oneGate.cleanBaseUrl('https://user:secret@payments.onegate.co.za'))
      .toThrow(/credentials/i);
  });
});
