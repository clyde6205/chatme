import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@chatme/contracts/constants';
import { createTranslator } from '@chatme/i18n';
import { getCatalog } from '@chatme/i18n/catalogs';

/**
 * Localized transactional email templates. Copy comes from the shared i18n
 * catalogs (`email.*`), so every template ships in all supported locales and
 * passes the same validator as the app UI. Output is small, table-free HTML
 * with inline styles plus a plain-text part for clients that prefer it.
 */
export type EmailTemplate =
  | { kind: 'verify_email'; name: string; link: string }
  | { kind: 'reset_password'; name: string; link: string }
  | { kind: 'new_sign_in'; name: string; device: string; resetLink: string }
  | { kind: 'password_changed'; name: string; resetLink: string }
  | { kind: 'account_deleted'; name: string };

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Display names are user input: strip control and bidi-override characters before putting them in mail. */
function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 64);
}

interface Block {
  heading: string;
  paragraphs: string[];
  button?: { label: string; href: string };
  fine: string[];
}

function toLocale(locale: string): Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale) ? (locale as Locale) : DEFAULT_LOCALE;
}

export function renderEmail(template: EmailTemplate, localeInput: string): RenderedEmail {
  const locale = toLocale(localeInput);
  const tr = createTranslator(locale, getCatalog(locale));
  const t = tr.t;
  const name = cleanName(template.name);
  let subject: string;
  let block: Block;

  switch (template.kind) {
    case 'verify_email':
      subject = t('email.verifySubject');
      block = {
        heading: t('email.verifyHeading'),
        paragraphs: [t('email.verifyBody', { name })],
        button: { label: t('email.verifyButton'), href: template.link },
        fine: [t('email.verifyExpiry'), t('email.verifyIgnore')],
      };
      break;
    case 'reset_password':
      subject = t('email.resetSubject');
      block = {
        heading: t('email.resetHeading'),
        paragraphs: [t('email.resetBody', { name })],
        button: { label: t('email.resetButton'), href: template.link },
        fine: [t('email.resetExpiry'), t('email.resetIgnore')],
      };
      break;
    case 'new_sign_in':
      subject = t('email.newSignInSubject');
      block = {
        heading: subject,
        paragraphs: [t('email.newSignInBody', { name, device: cleanName(template.device) }), t('email.newSignInAction')],
        button: { label: t('email.resetButton'), href: template.resetLink },
        fine: [],
      };
      break;
    case 'password_changed':
      subject = t('email.passwordChangedSubject');
      block = {
        heading: subject,
        paragraphs: [t('email.passwordChangedBody', { name }), t('email.passwordChangedAction')],
        button: { label: t('email.resetButton'), href: template.resetLink },
        fine: [],
      };
      break;
    case 'account_deleted':
      subject = t('email.accountDeletedSubject');
      block = { heading: subject, paragraphs: [t('email.accountDeletedBody', { name })], fine: [] };
      break;
  }

  const footer = t('email.footer');
  return { subject, html: html(locale, tr.dir, subject, block, footer), text: text(block, footer) };
}

function html(locale: Locale, dir: 'ltr' | 'rtl', subject: string, b: Block, footer: string): string {
  const align = dir === 'rtl' ? 'right' : 'left';
  const p = (s: string, style = 'margin:0 0 16px;font-size:16px;line-height:1.5;color:#1f2933') =>
    `<p style="${style}">${escapeHtml(s)}</p>`;
  const button = b.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(b.button.href)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:12px 20px;border-radius:8px">${escapeHtml(b.button.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#52606d;word-break:break-all">${escapeHtml(b.button.href)}</p>`
    : '';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f5f7fa"><div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif;text-align:${align}" dir="${dir}">` +
    `<p style="margin:0 0 24px;font-weight:700;font-size:18px;color:#2f5bea">CHATme</p>` +
    `<div style="background:#ffffff;border-radius:12px;padding:24px">` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1f2933">${escapeHtml(b.heading)}</h1>` +
    b.paragraphs.map((s) => p(s)).join('') +
    button +
    b.fine.map((s) => p(s, 'margin:0 0 8px;font-size:13px;line-height:1.5;color:#52606d')).join('') +
    `</div>` +
    p(footer, 'margin:16px 0 0;font-size:12px;line-height:1.5;color:#7b8794') +
    `</div></body></html>`;
}

function text(b: Block, footer: string): string {
  const parts = [b.heading, '', ...b.paragraphs.flatMap((s) => [s, ''])];
  if (b.button) parts.push(`${b.button.label}: ${b.button.href}`, '');
  parts.push(...b.fine, ...(b.fine.length ? [''] : []), '--', footer);
  return parts.join('\n');
}
