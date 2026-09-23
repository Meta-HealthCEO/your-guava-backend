const emailService = require('../../src/services/email.service');

const KEYS = ['NODE_ENV', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'EMAIL_CONSOLE_LINKS', 'EMAIL_DEV_CONSOLE'];
const message = { to: 'owner@cafe.co.za', subject: 'Reset', text: 'Reset: https://app.example/reset-password#token=secret-abc' };

describe('console email transport', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.EMAIL_DEV_CONSOLE;
    emailService._resetClient();
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
  });

  it('reports sent:false and withholds the link unless EMAIL_CONSOLE_LINKS=true', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.EMAIL_CONSOLE_LINKS;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(emailService.sendEmail(message)).resolves.toEqual({ sent: false, transport: 'console', linkLogged: false });
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain('secret-abc');
    expect(logged).toMatch(/withheld/);
    expect(emailService.deliveryCapability()).toEqual(expect.objectContaining({ ok: true, mode: 'console', linksLogged: false }));
  });

  it('prints the link only when EMAIL_CONSOLE_LINKS=true, still reporting sent:false', async () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_CONSOLE_LINKS = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(emailService.sendEmail(message)).resolves.toEqual({ sent: false, transport: 'console', linkLogged: true });
    expect(warn.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('#token=secret-abc');
  });

  it.each(['production', 'staging', ''])('refuses the console transport when NODE_ENV=%p, whatever the flags say', async (value) => {
    process.env.NODE_ENV = value;
    process.env.EMAIL_CONSOLE_LINKS = 'true';
    process.env.EMAIL_DEV_CONSOLE = 'true';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(emailService.sendEmail(message)).resolves.toEqual({ skipped: true, reason: 'resend_not_configured' });
    expect(warn).not.toHaveBeenCalled();
    expect(emailService.deliveryCapability()).toEqual(expect.objectContaining({ ok: false, mode: 'none' }));
    expect(emailService.deliveryMode()).toBe('none');
  });

  it('treats a console delivery as accepted but not sent', () => {
    expect(emailService.deliveryAccepted({ sent: false, transport: 'console' })).toBe(true);
    expect(emailService.deliveryAccepted({ sent: true })).toBe(true);
    expect(emailService.deliveryAccepted({ skipped: true, reason: 'resend_not_configured' })).toBe(false);
    expect(emailService.deliveryAccepted({ sent: false, error: new Error('x') })).toBe(false);
  });
});
