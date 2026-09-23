const {
  safeEmailText,
  buildTeamInviteEmail,
  buildVerificationEmail,
  buildSecurityNoticeEmail,
} = require('../../src/services/email.service');

describe('free text in transactional emails', () => {
  it('strips links, domain-like words, control and direction characters, and caps the length', () => {
    expect(safeEmailText('URGENT verify payout at https://evil.example/pay now')).toBe('URGENT verify payout at [link removed] now');
    expect(safeEmailText('Visit evil.example today')).toBe('Visit evil .example today');
    expect(safeEmailText('www.evil.example')).toBe('[link removed]');
    expect(safeEmailText("St. John's Café")).toBe("St. John's Café");
    expect(safeEmailText(`Line${String.fromCharCode(10)}break${String.fromCharCode(0x202e)}evil`)).toBe('Line break evil');
    expect(safeEmailText('a'.repeat(200))).toHaveLength(60);
    expect(safeEmailText(null)).toBe('');
  });

  it('keeps attacker text out of both parts of an invitation while the real link survives', () => {
    const email = buildTeamInviteEmail({
      invitation: { email: 'target@cafe.co.za', name: 'Target', expiresAt: new Date('2026-10-01T10:00:00Z') },
      owner: { name: 'Payroll https://evil.example/pay' },
      cafes: [{ name: 'Verify at evil.example' }],
      invitationToken: 'a'.repeat(43),
    });
    expect(email.text).not.toMatch(/evil\.example/);
    expect(email.html).not.toMatch(/evil\.example/);
    expect(email.text.match(/https?:\/\//g)).toHaveLength(1);
    expect(email.text).toContain('/accept-invite#token=');
  });

  it('cleans the registrant name in the verification email', () => {
    const email = buildVerificationEmail({
      registration: { email: 'x@cafe.co.za', name: 'Claim prize at www.evil.example' },
      verificationToken: 'b'.repeat(43),
    });
    expect(`${email.text}\n${email.html}`).not.toMatch(/evil\.example/);
  });

  it('builds a security notice that says what happened and what to do', () => {
    const email = buildSecurityNoticeEmail({ kind: 'password_changed', user: { email: 'o@cafe.co.za', name: 'Owner' } });
    expect(email.to).toBe('o@cafe.co.za');
    expect(email.subject).toMatch(/password was changed/i);
    expect(email.text).toMatch(/if this was not you/i);
    expect(email.text).toContain('/forgot-password');
    expect(() => buildSecurityNoticeEmail({ kind: 'unknown', user: { email: 'o@cafe.co.za' } })).toThrow(/Unknown security notice/);
  });
});
