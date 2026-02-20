/**
 * Send email via SendGrid.
 * Uses config.sendgrid (apiKey, fromEmail, fromName).
 */

const sgMail = require("@sendgrid/mail");
const config = require("../config");
const logger = require("./logger");

const COMPANY_NAME = "Clara Confirms";

let initialized = false;

function init() {
  if (initialized) return !!config.sendgrid.apiKey;
  if (!config.sendgrid.apiKey) {
    logger.warn("SendGrid API key not configured");
    return false;
  }
  sgMail.setApiKey(config.sendgrid.apiKey);
  initialized = true;
  return true;
}

/**
 * Escape HTML for safe use in templates
 */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a branded HTML email with greeting and content in a box
 * @param {Object} opts - { userName, companyName?, title, bodyHtml, buttonText?, buttonUrl?, footerText? }
 * @returns {string} HTML
 */
function buildEmailTemplate({
  userName,
  companyName = COMPANY_NAME,
  title,
  bodyHtml,
  buttonText,
  buttonUrl,
  footerText,
}) {
  const greeting = userName ? `Hey ${escapeHtml(userName)}!` : "Hey!";
  const safeTitle = escapeHtml(title);
  const safeCompany = escapeHtml(companyName);

  let buttonBlock = "";
  if (buttonText && buttonUrl) {
    buttonBlock = `
    <p style="margin: 24px 0 0 0;">
      <a href="${escapeHtml(buttonUrl)}" style="display: inline-block; padding: 12px 24px; background-color: #0f172a; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 14px;">${escapeHtml(buttonText)}</a>
    </p>`;
  }

  const footer = footerText ? `<p style="margin: 20px 0 0 0; font-size: 12px; color: #64748b;">${escapeHtml(footerText)}</p>` : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f1f5f9; line-height: 1.5;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 480px;">
          <tr>
            <td style="padding-bottom: 24px;">
              <p style="margin: 0; font-size: 18px; font-weight: 700; color: #0f172a;">${safeCompany}</p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
              <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #0f172a;">${greeting}</p>
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155;">${safeTitle}</p>
              <div style="font-size: 14px; color: #475569;">
                ${bodyHtml}
                ${buttonBlock}
                ${footer}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; font-size: 12px; color: #94a3b8;" align="center">
              This email was sent by ${safeCompany}.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send a single email
 * @param {Object} opts - { to, subject, text, html }
 * @returns {Promise<boolean>}
 */
async function sendMail({ to, subject, text, html }) {
  if (!init()) {
    logger.info("Email skipped (SendGrid not configured)", { to: to?.substring(0, 6) + "***", subject });
    return true;
  }
  const from = {
    email: config.sendgrid.fromEmail,
    name: config.sendgrid.fromName,
  };
  try {
    await sgMail.send({
      to,
      from,
      subject,
      text: text || (html && html.replace(/<[^>]*>/g, "")) || "",
      html: html || undefined,
    });
    logger.info("Email sent", { to: to?.substring(0, 6) + "***", subject });
    return true;
  } catch (err) {
    logger.error("SendGrid error", { error: err.message, subject });
    throw err;
  }
}

module.exports = { sendMail, init, buildEmailTemplate, COMPANY_NAME };
