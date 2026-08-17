/**
 * Email delivery abstraction. There is no SMTP configured in this
 * environment — this file implements the production INTERFACE
 * (emailService.sendPasswordReset) plus a development adapter that is safe
 * to use for automated tests, but explicitly documents that real email
 * delivery requires SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM
 * to be configured and a real transport (e.g. nodemailer) wired in here.
 *
 * Nothing in this file ever logs the raw reset token when NODE_ENV=production.
 */

export interface EmailAdapter {
  sendPasswordReset(to: string, resetUrl: string, name: string): Promise<void>;
}

/** Captures the last few "sent" emails in memory for tests to assert against,
 * without ever touching stdout/logs — deliberately not the same thing as
 * "logging the token," since this is an in-memory array a test can read
 * directly, not a persisted or printed log line. */
class DevEmailAdapter implements EmailAdapter {
  public sentEmails: { to: string; resetUrl: string; name: string; sentAt: Date }[] = [];

  async sendPasswordReset(to: string, resetUrl: string, name: string): Promise<void> {
    this.sentEmails.push({ to, resetUrl, name, sentAt: new Date() });
    if (process.env.NODE_ENV === 'production') {
      // Should never happen — production must configure SMTP and use a real
      // adapter — but if it does, never print the token/URL to logs.
      // eslint-disable-next-line no-console
      console.error('DevEmailAdapter is active in production — SMTP is not configured. Password reset emails are NOT being delivered.');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[dev email adapter] Password reset link generated for ${to} (not printed — see emailService.getLastSentTo() in tests).`);
  }
}

/** Placeholder for a real SMTP adapter. Wire in nodemailer (or your
 * provider's SDK) here once SMTP_HOST/PORT/USER/PASSWORD/FROM are set. */
class SmtpEmailAdapter implements EmailAdapter {
  async sendPasswordReset(_to: string, _resetUrl: string, _name: string): Promise<void> {
    throw new Error(
      'SMTP is not configured in this environment. Set SMTP_HOST, SMTP_PORT, SMTP_USER, ' +
      'SMTP_PASSWORD, and SMTP_FROM, and implement SmtpEmailAdapter using a real mail library ' +
      '(e.g. nodemailer) before enabling production password-reset email delivery.'
    );
  }
}

const devAdapter = new DevEmailAdapter();

function selectAdapter(): EmailAdapter {
  const hasSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  if (hasSmtp) return new SmtpEmailAdapter();
  return devAdapter;
}

export const emailService = {
  sendPasswordReset: (to: string, resetUrl: string, name: string) => selectAdapter().sendPasswordReset(to, resetUrl, name),
  /** Test-only accessor — never used by application logic, only by test code
   * that needs to verify an email "was sent" without a real mail server. */
  _devAdapterForTests: devAdapter
};
