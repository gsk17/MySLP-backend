import nodemailer from 'nodemailer';
import { config } from '../config.js';


let transporter = null;
let verified = false;
export function mailMode() {
  return config.smtp.host ? 'smtp' : 'console';
}
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    // Only sent when SMTP_NAME is configured; otherwise nodemailer's default applies. See config.smtp.name.
    ...(config.smtp.name ? { name: config.smtp.name } : {}),
    // Port 465 is implicit TLS; 587 and 2525 upgrade with STARTTLS.
    secure: config.smtp.port === 465,
    auth: config.smtp.user
      ? {
          user: config.smtp.user,
          pass: config.smtp.pass,
        }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  return transporter;
}

//Checks the SMTP credentials once at startup so failures surface early.
export async function verifyMailer() {
  if (mailMode() === 'console') return false;
  if (verified) return true;
  try {
    await getTransporter().verify();
    verified = true;
    return true;
  } catch (err) {
    console.error('[myslp] SMTP verification failed:', err.message);
    return false;
  }
}
async function send(to, subject, html, text) {
  if (mailMode() === 'console') {
    console.warn(
      '\n' +
        '  ┌───────────────────────────────────────────────────────────────┐\n' +
        '  │  EMAIL NOT SENT — no SMTP_HOST configured. Printing instead.  │\n' +
        '  └───────────────────────────────────────────────────────────────┘\n' +
        `  To:      ${to}\n` +
        `  Subject: ${subject}\n\n` +
        text.replace(/^/gm, '  ') +
        '\n',
    );
    return {
      mode: 'console',
    };
  }
  const info = await getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    html,
  });
  const preview = nodemailer.getTestMessageUrl(info);
  return {
    mode: 'smtp',
    messageId: info.messageId,
    previewUrl: typeof preview === 'string' ? preview : undefined,
  };
}

//Templates

const ACCENT = '#E3F64B';
const INK = '#0A0A0B';
const SURFACE = '#1A1A1D';
const MUTED = '#9A9AA2';

function verificationTemplate(name, code, minutes) {
  const spaced = code.split('').join('&nbsp;&nbsp;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <tr><td style="padding-bottom:24px;">
          <span style="font:700 22px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
            <span style="color:${ACCENT};"></span>
          </span>
        </td></tr>

        <tr><td style="background:${SURFACE};border-radius:20px;padding:32px;">
          <p style="margin:0 0 6px;font:400 15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            Hello ${escapeHtml(name)},
          </p>
          <h1 style="margin:0 0 18px;font:400 24px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
            Confirm your email address
          </h1>
          <p style="margin:0 0 26px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            Enter this code in MySLP to finish creating your energy account.
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr><td align="center" style="background:${ACCENT};border-radius:16px;padding:20px 12px;">
              <span style="font:700 34px/1 'SFMono-Regular',Consolas,Menlo,monospace;letter-spacing:4px;color:${INK};">
                ${spaced}
              </span>
            </td></tr>
          </table>

          <p style="margin:24px 0 0;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            The code expires in ${minutes} minutes. If you did not request it, you can ignore
            this email — no account will be created without it.
          </p>
        </td></tr>

        <tr><td style="padding-top:20px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#636369;">
          Shangri-La Power — a publicly owned energy company.<br>
          This is an automated message; replies are not monitored.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function codeTemplate({ name, heading, intro, code, minutes, footnote }) {
  const spaced = code.split('').join('&nbsp;&nbsp;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <tr><td style="padding-bottom:24px;">
          <img src="${config.mailLogo.url}" alt="MySLP"
               width="${config.mailLogo.width}" height="${config.mailLogo.height}"
               style="display:block;border:0;outline:none;text-decoration:none;width:${config.mailLogo.width}px;height:${config.mailLogo.height}px;">
        </td></tr>

        <tr><td style="background:${SURFACE};border-radius:20px;padding:32px;">
          <p style="margin:0 0 6px;font:400 15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            Hello ${escapeHtml(name)},
          </p>
          <h1 style="margin:0 0 18px;font:400 24px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
            ${heading}
          </h1>
          <p style="margin:0 0 26px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            ${intro}
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            <tr><td align="center" style="background:${ACCENT};border-radius:16px;padding:20px 12px;">
              <span style="font:700 34px/1 'SFMono-Regular',Consolas,Menlo,monospace;letter-spacing:4px;color:${INK};">
                ${spaced}
              </span>
            </td></tr>
          </table>

          <p style="margin:24px 0 0;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            The code expires in ${minutes} minutes. ${footnote}
          </p>
        </td></tr>

        <tr><td style="padding-top:20px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#636369;">
          Shangri-La Power — a publicly owned energy company.<br>
          This is an automated message; replies are not monitored.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function sendPasswordResetEmail(to, name, code, minutes) {
  const text =
    `Hello ${name},\n\n` +
    `Your MySLP password reset code is: ${code}\n\n` +
    `Enter it in the app to choose a new password.\n` +
    `The code expires in ${minutes} minutes.\n\n` +
    `If you did not ask to reset your password, ignore this email — your ` +
    `current password still works and nothing has changed.\n\n` +
    `Shangri-La Power`;

  const html = codeTemplate({
    name,
    heading: 'Reset your password',
    intro: 'Enter this code in MySLP to choose a new password.',
    code,
    minutes,
    footnote:
      'If you did not ask to reset your password, ignore this email — your current ' +
      'password still works and nothing has changed.',
  });

  return send(to, `${code} is your MySLP password reset code`, html, text);
}

export function sendVerificationEmail(to, name, code, minutes) {
  const text =
    `Hello ${name},\n\n` +
    `Your MySLP verification code is: ${code}\n\n` +
    `Enter it in the app to finish creating your energy account.\n` +
    `The code expires in ${minutes} minutes.\n\n` +
    `If you did not request this, ignore this email — no account will be created without it.\n\n` +
    `Shangri-La Power`;
  return send(
    to,
    `${code} is your MySLP verification code`,
    verificationTemplate(name, code, minutes),
    text,
  );
}


function noticeTemplate({ name, heading, intro, rows = [], footnote = '' }) {
  const table = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:4px 0 8px;">
         ${rows
           .map(
             (r, i) => `<tr>
             <td style="padding:12px 0;border-top:${i === 0 ? 'none' : '1px solid #2C2C31'};font:400 14px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">${escapeHtml(r.label)}</td>
             <td align="right" style="padding:12px 0;border-top:${i === 0 ? 'none' : '1px solid #2C2C31'};font:600 15px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">${escapeHtml(r.value)}</td>
           </tr>`,
           )
           .join('')}
       </table>`
    : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <tr><td style="padding-bottom:24px;">
          <img src="${config.mailLogo.url}" alt="MySLP"
               width="${config.mailLogo.width}" height="${config.mailLogo.height}"
               style="display:block;border:0;outline:none;text-decoration:none;width:${config.mailLogo.width}px;height:${config.mailLogo.height}px;">
        </td></tr>

        <tr><td style="background:${SURFACE};border-radius:20px;padding:32px;">
          <p style="margin:0 0 6px;font:400 15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            Hello ${escapeHtml(name)},
          </p>
          <h1 style="margin:0 0 18px;font:400 24px/1.25 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">
            ${escapeHtml(heading)}
          </h1>
          <p style="margin:0 0 20px;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">
            ${escapeHtml(intro)}
          </p>
          ${table}
          ${
            footnote
              ? `<p style="margin:20px 0 0;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${MUTED};">${escapeHtml(footnote)}</p>`
              : ''
          }
        </td></tr>

        <tr><td style="padding-top:20px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#636369;">
          Shangri-La Power — a publicly owned energy company.<br>
          You can turn these emails off under Account → Notifications in the MySLP app.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

//Sends a notice email. Returns false in console mode or on failure. 
export async function sendNoticeEmail(to, subject, parts) {
  const text =
    `Hello ${parts.name},\n\n${parts.heading}\n\n${parts.intro}\n\n` +
    parts.rows.map((r) => `${r.label}: ${r.value}`).join('\n') +
    (parts.footnote ? `\n\n${parts.footnote}` : '') +
    `\n\nShangri-La Power\nTurn these emails off under Account -> Notifications in the MySLP app.`;
  try {
    await send(to, subject, noticeTemplate(parts), text);
    return mailMode() === 'smtp';
  } catch (err) {
    // A notification must never break the action that triggered it.
    console.error('[myslp] notice email failed:', err.message);
    return false;
  }
}
