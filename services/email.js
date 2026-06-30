// services/email.js — Transactional email via Postmark
// Owns: sending confirmation emails
// Does NOT own: email template rendering (EJS lives in views/)

const POSTMARK_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const FROM_EMAIL = process.env.POSTMARK_FROM_EMAIL || 'hello@shurgetapp.com';

async function sendConfirmationEmail(order) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping email');
    return;
  }

  // DB rows use snake_case; callers may also pass camelCase objects — normalize both
  const normalized = {
    id:             order.id,
    customerName:   order.customer_name  ?? order.customerName  ?? null,
    customerEmail:  order.customer_email ?? order.customerEmail ?? null,
    itemType:       order.item_type      ?? order.itemType      ?? '',
    pickupAddress:  order.pickup_address ?? order.pickupAddress ?? '',
    dropoffAddress: order.dropoff_address ?? order.dropoffAddress ?? '',
    distanceMiles:  order.distance_miles ?? order.distanceMiles ?? null,
    etaMinutes:     order.eta_minutes    ?? order.etaMinutes    ?? null,
    priceTotal:     order.price_total    ?? order.priceTotal    ?? 0,
    driverName:     order.driver_name    ?? order.driverName    ?? null,
    driverPhone:    order.driver_phone   ?? order.driverPhone   ?? null,
  };

  if (!normalized.customerEmail) {
    console.warn('[email] No customerEmail on order — skipping');
    return;
  }

  const html = buildConfirmationHtml(normalized);

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Your Shurget delivery is confirmed — Order #${normalized.id}`,
      HtmlBody: html,
      TextBody: buildConfirmationText(normalized),
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Postmark error:', res.status, err);
  } else {
    console.log(`[email] Confirmation sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

function buildConfirmationHtml(order) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #222;">
  <div style="background: #1a1a2e; color: #fff; padding: 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin:0; font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0; opacity:.8;">Your delivery is confirmed</p>
  </div>
  <div style="border:1px solid #e5e7eb; border-top:none; padding: 24px; border-radius: 0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${order.customerName ? ` ${order.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 20px;">Your pickup is booked. A driver is on the way.</p>

    <div style="background:#f9fafb; border-radius:6px; padding:16px; margin-bottom:20px;">
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Order ID</div>
        <div style="font-weight:bold; font-size:16px;">#${order.id}</div>
      </div>
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Item</div>
        <div style="font-size:15px;">${capitalize(order.itemType)}</div>
      </div>
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Pickup</div>
        <div style="font-size:15px;">${order.pickupAddress}</div>
      </div>
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Dropoff</div>
        <div style="font-size:15px;">${order.dropoffAddress}</div>
      </div>
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Distance</div>
        <div style="font-size:15px;">${order.distanceMiles} miles</div>
      </div>
      <div style="margin-bottom:12px; border-bottom:1px solid #e5e7eb; padding-bottom:12px;">
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Driver ETA</div>
        <div style="font-size:15px; color:#16a34a; font-weight:bold;">~${order.etaMinutes} minutes</div>
      </div>
      <div>
        <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px;">Total</div>
        <div style="font-size:18px; font-weight:bold;">$${Number(order.priceTotal).toFixed(2)}</div>
      </div>
    </div>

    ${order.driverName ? `<div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:16px; margin-bottom:20px;">
      <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">Your Driver</div>
      <div style="font-weight:bold; font-size:15px;">${order.driverName}</div>
      <div style="color:#6b7280; font-size:13px;">${order.driverPhone}</div>
    </div>` : ''}

    <p style="color:#6b7280; font-size:13px; margin:0;">Track your order at <a href="https://shurget-5..app/confirmation/${order.id}">shurget-5..app</a></p>
    <p style="color:#6b7280; font-size:13px; margin:8px 0 0;">Questions? <a href="https://shurget-5..app/help" style="color:#ea580c;">Help Center →</a></p>
  </div>
</body>
</html>`;
}

function buildConfirmationText(order) {
  return `Shurget — Order Confirmed #${order.id}

Hi${order.customerName ? ` ${order.customerName.split(' ')[0]}` : ''},

Your pickup is booked. Here are the details:

Item: ${capitalize(order.itemType)}
Pickup: ${order.pickupAddress}
Dropoff: ${order.dropoffAddress}
Distance: ${order.distanceMiles} miles
Driver ETA: ~${order.etaMinutes} minutes
Total: $${Number(order.priceTotal).toFixed(2)}
${order.driverName ? `\nDriver: ${order.driverName} (${order.driverPhone})` : ''}

Track your order: https://shurget-5..app/confirmation/${order.id}
`;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function sendQuoteRequestEmail(request) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping quote request email');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">New Quote Request</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <div style="margin-bottom:16px;">
      <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Request ID</div>
      <div style="font-weight:bold;font-size:16px;">#${request.id}</div>
    </div>
    <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Name</div>
        <div style="font-size:15px;">${escapeHtml(request.name)}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Email</div>
        <div style="font-size:15px;"><a href="mailto:${request.email}">${escapeHtml(request.email)}</a></div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Phone</div>
        <div style="font-size:15px;">${request.phone ? escapeHtml(request.phone) : 'Not provided'}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Item Description</div>
        <div style="font-size:15px;">${request.item_description ? escapeHtml(request.item_description) : 'Not provided'}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Pickup Address</div>
        <div style="font-size:15px;">${request.pickup_address ? escapeHtml(request.pickup_address) : 'Not provided'}</div>
      </div>
      <div>
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Dropoff Address</div>
        <div style="font-size:15px;">${request.dropoff_address ? escapeHtml(request.dropoff_address) : 'Not provided'}</div>
      </div>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Received: ${new Date(request.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: FROM_EMAIL,
      Subject: `Shurget Quote Request #${request.id} — ${request.name} <${request.email}>`,
      HtmlBody: html,
      TextBody: `New quote request #${request.id} from ${request.name} (${request.email}, ${request.phone || 'no phone'}). Item: ${request.item_description || 'N/A'}. Pickup: ${request.pickup_address || 'N/A'}. Dropoff: ${request.dropoff_address || 'N/A'}.`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Quote request notification error:', res.status, err);
  } else {
    console.log(`[email] Quote request notification sent for #${request.id}`);
  }
}

async function sendDriverApplicationConfirmation({ name, email, applicationId }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping driver application confirmation');
    return;
  }

  if (!email) {
    console.warn('[email] Missing driver application email — skipping confirmation');
    return;
  }

  const firstName = name ? String(name).trim().split(' ')[0] : 'there';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Driver Application Received</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 12px;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 16px;">Thanks for applying to drive with Shurget. We received your application and our team is reviewing it now.</p>
    ${applicationId ? `<p style="margin:0 0 16px;color:#6b7280;font-size:14px;">Application ID: <strong>#${applicationId}</strong></p>` : ''}
    <p style="margin:0 0 8px;">What happens next:</p>
    <p style="margin:0 0 6px;">1. We review your details and market availability.</p>
    <p style="margin:0 0 6px;">2. If approved, we send onboarding and payout setup instructions.</p>
    <p style="margin:0;">3. You can start claiming jobs from your driver portal.</p>
  </div>
</body>
</html>`;

  const text = `Shurget — Driver Application Received\n\nHi ${firstName},\n\nThanks for applying to drive with Shurget. We received your application and our team is reviewing it now.${applicationId ? `\n\nApplication ID: #${applicationId}` : ''}\n\nWhat happens next:\n1. We review your details and market availability.\n2. If approved, we send onboarding and payout setup instructions.\n3. You can start claiming jobs from your driver portal.`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: email,
      Subject: 'We received your Shurget driver application',
      HtmlBody: html,
      TextBody: text,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Driver application confirmation error:', res.status, err);
  } else {
    console.log(`[email] Driver application confirmation sent to ${email}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendDriverAssignedEmail(order) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping driver assigned email');
    return;
  }

  const normalized = {
    id:            order.id,
    customerName:  order.customer_name  ?? order.customerName  ?? null,
    customerEmail: order.customer_email ?? order.customerEmail ?? null,
    itemType:      order.item_type      ?? order.itemType      ?? '',
    pickupAddress: order.pickup_address ?? order.pickupAddress ?? '',
    dropoffAddress:order.dropoff_address ?? order.dropoffAddress ?? '',
    etaMinutes:    order.eta_minutes    ?? order.etaMinutes    ?? null,
    driverName:    order.driver_name    ?? order.driverName    ?? null,
    driverPhone:   order.driver_phone   ?? order.driverPhone   ?? null,
  };

  if (!normalized.customerEmail) {
    console.warn('[email] No customerEmail on order — skipping driver assigned email');
    return;
  }

  const html = buildDriverAssignedHtml(normalized);

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Your Shurget driver is on the way — Order #${normalized.id}`,
      HtmlBody: html,
      TextBody: buildDriverAssignedText(normalized),
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Postmark driver-assigned error:', res.status, err);
  } else {
    console.log(`[email] Driver assigned email sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

function buildDriverAssignedHtml(order) {
  const etaDisplay = order.etaMinutes
    ? `~${order.etaMinutes} minutes`
    : 'Arriving soon';
  const trackUrl = `https://shurget-5..app/track/${order.id}`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Your driver is on the way</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${order.customerName ? ` ${order.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 20px;">Your driver has been assigned and is heading to pick up your ${capitalize(order.itemType)}.</p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:20px;margin-bottom:20px;">
      <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Your Driver</div>
      <div style="font-weight:bold;font-size:18px;margin-bottom:4px;">${escapeHtml(order.driverName || 'Assigned Driver')}</div>
      <div style="font-size:15px;color:#374151;">${escapeHtml(order.driverPhone || '')}</div>
    </div>

    <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Order ID</div>
        <div style="font-weight:bold;font-size:16px;">#${order.id}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Pickup</div>
        <div style="font-size:15px;">${escapeHtml(order.pickupAddress)}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Dropoff</div>
        <div style="font-size:15px;">${escapeHtml(order.dropoffAddress)}</div>
      </div>
      <div>
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Estimated Arrival</div>
        <div style="font-size:15px;color:#16a34a;font-weight:bold;">${etaDisplay}</div>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${trackUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold;font-size:16px;">Track Your Order Live</a>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Or open directly: <a href="${trackUrl}">${trackUrl}</a></p>
  </div>
</body>
</html>`;
}

function buildDriverAssignedText(order) {
  const etaDisplay = order.etaMinutes ? `~${order.etaMinutes} minutes` : 'Arriving soon';
  const trackUrl = `https://shurget-5..app/track/${order.id}`;

  return `Shurget — Your Driver Is On The Way #${order.id}

Hi${order.customerName ? ` ${order.customerName.split(' ')[0]}` : ''},

Your driver has been assigned and is heading to pick up your ${capitalize(order.itemType)}.

DRIVER: ${order.driverName || 'Assigned Driver'}
PHONE: ${order.driverPhone || 'N/A'}
ETA: ${etaDisplay}

Pickup: ${order.pickupAddress}
Dropoff: ${order.dropoffAddress}

Track your order live: ${trackUrl}
`;
}

async function sendPartnerLeadEmail(lead) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping partner lead email');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">New Partner Pilot Request 🤝</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:12px 16px;margin-bottom:20px;">
      <strong style="color:#c2410c;">Retail Partner Lead — Review within 1 business day</strong>
    </div>
    <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Company</div>
        <div style="font-size:16px;font-weight:bold;">${escapeHtml(lead.company_name || 'Not provided')}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Contact</div>
        <div style="font-size:15px;">${escapeHtml(lead.name)} — <a href="mailto:${lead.email}">${escapeHtml(lead.email)}</a>${lead.phone ? ` — ${escapeHtml(lead.phone)}` : ''}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Monthly Volume Estimate</div>
        <div style="font-size:15px;font-weight:bold;color:#ea580c;">${escapeHtml(lead.monthly_volume || 'Not provided')}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">ZIP Codes Served</div>
        <div style="font-size:15px;">${escapeHtml(lead.zip_codes_served || 'Not provided')}</div>
      </div>
      <div>
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;">Items They Ship</div>
        <div style="font-size:15px;">${lead.item_description ? escapeHtml(lead.item_description) : 'Not provided'}</div>
      </div>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Received: ${new Date(lead.created_at).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET — Lead ID #${lead.id}</p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: FROM_EMAIL,
      Subject: `Partner Pilot Request #${lead.id} — ${lead.company_name || lead.name} (${lead.monthly_volume || '?'}/mo)`,
      HtmlBody: html,
      TextBody: `New partner pilot request #${lead.id}. Company: ${lead.company_name || 'N/A'}. Contact: ${lead.name} (${lead.email}${lead.phone ? ', ' + lead.phone : ''}). Volume: ${lead.monthly_volume || 'N/A'}. ZIPs: ${lead.zip_codes_served || 'N/A'}. Items: ${lead.item_description || 'N/A'}.`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Partner lead notification error:', res.status, err);
  } else {
    console.log(`[email] Partner lead notification sent for #${lead.id}`);
  }
}

/**
 * Send referral code email to a customer after their first completed order.
 * Lets them know they have a code to share for $20 off.
 */
async function sendReferralCodeEmail({ email, name, code }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping referral code email');
    return;
  }

  const shareUrl = `https://shurgetit.com/book?ref=${code}&utm_source=referral&utm_medium=email&utm_campaign=customer_referral`;
  const firstName = name ? name.split(' ')[0] : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Share Shurget, earn $20 credit</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${firstName ? ` ${firstName}` : ''},</p>
    <p style="margin:0 0 20px;">Thanks for your order! Here's your personal referral code — share it with friends and you both get <strong>$20 off</strong> your next haul.</p>

    <div style="background:#fff7ed;border:2px solid #ea580c;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="color:#9a3412;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your Referral Code</div>
      <div style="font-size:32px;font-weight:bold;letter-spacing:4px;color:#1a1a2e;">${code}</div>
    </div>

    <p style="margin:0 0 12px;font-size:14px;color:#374151;">Or share your link:</p>
    <div style="background:#f9fafb;border-radius:6px;padding:12px;margin-bottom:20px;word-break:break-all;">
      <a href="${shareUrl}" style="color:#ea580c;font-weight:bold;">${shareUrl}</a>
    </div>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="font-weight:bold;margin-bottom:8px;">How it works</div>
      <ol style="margin:0;padding-left:20px;font-size:14px;color:#374151;line-height:1.8;">
        <li>Share your code or link with a friend</li>
        <li>They use it at checkout — they get <strong>$20 off</strong></li>
        <li>You get a <strong>$20 credit code</strong> emailed to you after their first delivery completes</li>
      </ol>
    </div>

    <p style="color:#6b7280;font-size:13px;margin:0;">Book your next haul at <a href="https://shurgetit.com/book" style="color:#ea580c;">shurgetit.com/book</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: email,
      Subject: `Your Shurget referral code: ${code} — share for $20 off`,
      HtmlBody: html,
      TextBody: `Hi${firstName ? ` ${firstName}` : ''},\n\nThanks for your order! Here's your referral code: ${code}\n\nShare this link: ${shareUrl}\n\nWhen a friend books using your code, they get $20 off. After their delivery completes, you get a $20 credit emailed to you.\n\nBook at shurgetit.com/book`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Referral code email error:', res.status, err);
  } else {
    console.log(`[email] Referral code email sent to ${email} with code ${code}`);
  }
}

/**
 * Send a $20 credit code to the referrer after their referee completes a delivery.
 */
async function sendReferrerCreditEmail({ email, name, creditCode }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping referrer credit email');
    return;
  }

  const firstName = name ? name.split(' ')[0] : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">You earned $20 credit! 🎉</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${firstName ? ` ${firstName}` : ''},</p>
    <p style="margin:0 0 20px;">Your referral paid off! Someone used your code and completed their delivery. Here's your <strong>$20 credit code</strong> for your next haul:</p>

    <div style="background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="color:#166534;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your $20 Credit Code</div>
      <div style="font-size:28px;font-weight:bold;letter-spacing:3px;color:#1a1a2e;">${creditCode}</div>
      <div style="color:#166534;font-size:13px;margin-top:8px;">Single-use — apply at checkout</div>
    </div>

    <p style="color:#6b7280;font-size:13px;margin:0;">Book your next haul at <a href="https://shurgetit.com/book" style="color:#ea580c;">shurgetit.com/book</a> and enter the code above.</p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: email,
      Subject: `You earned $20 credit — your Shurget referral code: ${creditCode}`,
      HtmlBody: html,
      TextBody: `Hi${firstName ? ` ${firstName}` : ''},\n\nYour referral paid off! Here's your $20 credit code: ${creditCode}\n\nApply it at checkout on your next haul at shurgetit.com/book`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Referrer credit email error:', res.status, err);
  } else {
    console.log(`[email] Referrer credit email sent to ${email} with code ${creditCode}`);
  }
}

/**
 * Notify a driver referrer that their $50 bounty has been paid out.
 * Fired after the referred driver completes their 3rd haul.
 */
async function sendDriverReferralBountyEmail({ referrerEmail, referrerName, referredDriverName, transferAmount }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping driver referral bounty email');
    return;
  }

  const firstName = referrerName ? referrerName.split(' ')[0] : '';
  const amount = (transferAmount / 100).toFixed(2);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">You earned a $50 driver referral bounty! 🎉</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${firstName ? ` ${firstName}` : ''},</p>
    <p style="margin:0 0 20px;">
      <strong>${escapeHtml(referredDriverName || 'The driver you referred')}</strong> just completed their 3rd haul on Shurget.
      Your <strong>$${amount} referral bounty</strong> has been sent to your connected bank account via Stripe.
    </p>

    <div style="background:#f0fdf4;border:2px solid #22c55e;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="color:#166534;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Bounty Paid</div>
      <div style="font-size:36px;font-weight:bold;color:#1a1a2e;">$${amount}</div>
      <div style="color:#166534;font-size:13px;margin-top:8px;">Transferred to your bank account</div>
    </div>

    <p style="margin:0 0 12px;font-size:14px;color:#374151;">
      Keep sharing your referral link — every driver you refer who completes 3 hauls earns you another $50.
    </p>
    <p style="color:#6b7280;font-size:13px;margin:0;">
      View your earnings at <a href="https://shurgetit.com/driver/earnings" style="color:#ea580c;">shurgetit.com/driver/earnings</a>
    </p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: referrerEmail,
      Subject: `You earned $${amount} — your Shurget driver referral bounty`,
      HtmlBody: html,
      TextBody: `Hi${firstName ? ` ${firstName}` : ''},\n\n${referredDriverName || 'The driver you referred'} just completed their 3rd haul. Your $${amount} referral bounty has been sent to your bank account.\n\nKeep sharing your referral link to earn more.\n\nView earnings: https://shurgetit.com/driver/earnings`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Driver referral bounty email error:', res.status, err);
  } else {
    console.log(`[email] Driver referral bounty email sent to ${referrerEmail}`);
  }
}

/**
 * Send the post-delivery review + referral email 2 hours after delivery.
 * Merge vars: customerFirstName, driverFirstName, itemCategory, orderId, ratingLink, referralCode, referralShareLink
 */
async function sendPostDeliveryReviewEmail({ order, driverFirstName, ratingLink, referralCode, referralShareLink }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping review email');
    return;
  }

  const customerEmail = order.customer_email ?? order.customerEmail;
  if (!customerEmail) {
    console.warn('[email] No customerEmail on order — skipping review email');
    return;
  }

  const customerName  = order.customer_name ?? order.customerName ?? null;
  const firstName     = customerName ? customerName.split(' ')[0] : 'there';
  const driverFirst   = driverFirstName || 'your driver';
  const itemLabel     = capitalize(order.item_type ?? order.itemType ?? 'item');
  const orderId       = order.id;
  const appUrl        = 'https://shurgetit.com';

  const html = buildReviewEmailHtml({ firstName, driverFirst, itemLabel, orderId, ratingLink, referralCode, referralShareLink, appUrl });
  const text = buildReviewEmailText({ firstName, driverFirst, itemLabel, orderId, ratingLink, referralCode, referralShareLink, appUrl });

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: customerEmail,
      Subject: `How was your haul? Plus $20 to share.`,
      HtmlBody: html,
      TextBody: text,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Review email Postmark error:', res.status, err);
  } else {
    console.log(`[email] Review email sent to ${customerEmail} for order #${orderId}`);
  }
}

function buildReviewEmailHtml({ firstName, driverFirst, itemLabel, orderId, ratingLink, referralCode, referralShareLink, appUrl }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">How'd it go?</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 8px;font-size:16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 24px;font-size:15px;color:#374151;">${escapeHtml(driverFirst)} just dropped off your ${escapeHtml(itemLabel)}. Tell us how it went.</p>

    <!-- Primary CTA: Rate driver -->
    <div style="text-align:center;margin-bottom:28px;">
      <a href="${escapeHtml(ratingLink)}"
         style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:16px 36px;border-radius:8px;font-weight:bold;font-size:17px;letter-spacing:.3px;">
        ⭐ Rate ${escapeHtml(driverFirst)}
      </a>
    </div>

    <!-- Divider -->
    <div style="border-top:1px solid #e5e7eb;margin:24px 0;"></div>

    <!-- Secondary: Referral -->
    <p style="margin:0 0 12px;font-size:15px;font-weight:bold;color:#1a1a2e;">Loved it? Send a friend $20 off — you get $20 too.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#6b7280;">Share your code. When they book, they save $20. After their delivery, you get $20 credit.</p>

    <div style="background:#fff7ed;border:2px solid #ea580c;border-radius:8px;padding:16px;text-align:center;margin-bottom:16px;">
      <div style="color:#9a3412;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Your Referral Code</div>
      <div style="font-family:monospace;font-size:26px;font-weight:bold;letter-spacing:4px;color:#1a1a2e;">${escapeHtml(referralCode)}</div>
    </div>

    <div style="background:#f9fafb;border-radius:6px;padding:12px;margin-bottom:16px;word-break:break-all;text-align:center;">
      <a href="${escapeHtml(referralShareLink)}" style="color:#ea580c;font-size:14px;font-weight:bold;">${escapeHtml(referralShareLink)}</a>
    </div>

    <!-- Share buttons -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="padding:4px;">
          <a href="sms:?body=Get%20%2420%20off%20your%20first%20Shurget%20delivery%3A%20${encodeURIComponent(referralShareLink)}"
             style="display:block;text-align:center;background:#22c55e;color:#fff;text-decoration:none;padding:10px 0;border-radius:6px;font-weight:bold;font-size:13px;">
            📱 Share via SMS
          </a>
        </td>
        <td style="padding:4px;">
          <a href="mailto:?subject=Get%20%2420%20off%20Shurget&body=Use%20my%20code%20${encodeURIComponent(referralCode)}%20or%20book%20here%3A%20${encodeURIComponent(referralShareLink)}"
             style="display:block;text-align:center;background:#3b82f6;color:#fff;text-decoration:none;padding:10px 0;border-radius:6px;font-weight:bold;font-size:13px;">
            ✉️ Share via Email
          </a>
        </td>
      </tr>
    </table>

    <!-- Divider -->
    <div style="border-top:1px solid #e5e7eb;margin:24px 0;"></div>

    <p style="color:#9ca3af;font-size:12px;margin:0;text-align:center;">
      Something went sideways with order #${orderId}?
      <a href="mailto:hello@shurgetapp.com?subject=Order%20%23${orderId}%20issue" style="color:#ea580c;">Reply to this email</a> and we'll sort it out.
    </p>
  </div>
</body>
</html>`;
}

function buildReviewEmailText({ firstName, driverFirst, itemLabel, orderId, ratingLink, referralCode, referralShareLink }) {
  return `Hi ${firstName},

${driverFirst} just dropped off your ${itemLabel}. Tell us how it went.

Rate your driver: ${ratingLink}

---

Loved it? Send a friend $20 off — you get $20 too.

Your referral code: ${referralCode}
Share link: ${referralShareLink}

---

Something went wrong with order #${orderId}? Reply to this email and we'll sort it out.
`;
}

/** Auto-reply to a partner application — "We'll be in touch within 48 hours." */
async function sendPartnerApplicationReceived(application) {
  const postmark = require('postmark');
  const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN);

  const body = `
Hi ${application.contact_name || 'there'},

We've received your partnership application for ${application.store_name || 'your store'}. Here's what happens next:

1. Our team reviews your application (typically within 48 hours)
2. If approved, you'll get a partner dashboard + Stripe setup link
3. We run a 5–10 delivery pilot to validate the integration for your use case

If you have questions in the meantime, reply to this email or contact partners@shurgetit.com.

— The Shurget Team
`.trim();

  await client.sendEmail({
    From: 'partners@shurgetit.com',
    To: application.contact_email,
    ReplyTo: 'partners@shurgetit.com',
    Subject: `We received your application — Shurget Partnership`,
    HtmlBody: body.replace(/\n/g, '<br>'),
    TextBody: body,
    Tag: 'partner-application',
  });
}

/** Magic link email for partner dashboard login. */
async function sendPartnerMagicLink(partner, magicLink) {
  const postmark = require('postmark');
  const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN);

  const body = `
Hi,

Click the link below to access your ${partner.store_name} partner dashboard on Shurget. This link expires in 24 hours.

${magicLink}

If you didn't request this link, you can safely ignore this email.

— Shurget Partners
`.trim();

  await client.sendEmail({
    From: 'partners@shurgetit.com',
    To: partner.contact_email,
    Subject: `Your Shurget Partner Dashboard — ${partner.store_name}`,
    HtmlBody: body.replace(/\n/g, '<br>'),
    TextBody: body,
    Tag: 'partner-magic-link',
  });
}

/**
 * Send in-transit email — driver has left and is heading to dropoff.
 */
async function sendInTransitEmail(order) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping in-transit email');
    return;
  }

  const normalized = {
    id:            order.id,
    customerName:  order.customer_name  ?? order.customerName  ?? null,
    customerEmail: order.customer_email ?? order.customerEmail ?? null,
    itemType:      order.item_type      ?? order.itemType      ?? '',
    pickupAddress: order.pickup_address ?? order.pickupAddress ?? '',
    dropoffAddress:order.dropoff_address ?? order.dropoffAddress ?? '',
    driverName:    order.driver_name    ?? order.driverName    ?? null,
    etaMinutes:    order.eta_minutes   ?? order.etaMinutes   ?? null,
  };

  if (!normalized.customerEmail) return;

  const trackUrl = `https://shurget-5..app/track/${normalized.id}`;
  const etaDisplay = normalized.etaMinutes ? `~${normalized.etaMinutes} min` : 'Soon';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Your haul is en route</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 20px;">Your ${capitalize(normalized.itemType)} is on its way. ETA: <strong>${etaDisplay}</strong>.</p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:20px;margin-bottom:20px;text-align:center;">
      <div style="font-size:14px;color:#166534;margin-bottom:8px;">Driver</div>
      <div style="font-weight:bold;font-size:18px;color:#1a1a2e;">${escapeHtml(normalized.driverName || 'Your driver')}</div>
      <div style="margin-top:8px;font-size:14px;color:#166534;">Heading to: ${escapeHtml(normalized.dropoffAddress)}</div>
    </div>

    <div style="text-align:center;margin-bottom:20px;">
      <a href="${trackUrl}" style="display:inline-block;background:#1a1a2e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold;font-size:16px;">Track Live →</a>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Or open directly: <a href="${trackUrl}">${trackUrl}</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Your Shurget delivery is en route — ETA ${etaDisplay}`,
      HtmlBody: html,
      TextBody: `Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},\n\nYour ${capitalize(normalized.itemType)} is on its way. ETA: ${etaDisplay}.\n\nDriver: ${normalized.driverName || 'Your driver'}\nHeading to: ${normalized.dropoffAddress}\n\nTrack live: ${trackUrl}`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] In-transit email error:', res.status, err);
  } else {
    console.log(`[email] In-transit email sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

/**
 * Send delivered email — haul complete, with rating link.
 */
async function sendDeliveredEmail(order, ratingLink) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping delivered email');
    return;
  }

  const normalized = {
    id:            order.id,
    customerName:  order.customer_name  ?? order.customerName  ?? null,
    customerEmail: order.customer_email ?? order.customerEmail ?? null,
    itemType:      order.item_type      ?? order.itemType      ?? '',
    dropoffAddress:order.dropoff_address ?? order.dropoffAddress ?? '',
    driverName:    order.driver_name    ?? order.driverName    ?? null,
  };

  if (!normalized.customerEmail) return;

  const ratingUrl = ratingLink || `https://shurget-5..app/rate/${normalized.id}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Your haul is complete! 🎉</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 20px;">Your ${capitalize(normalized.itemType)} has been delivered to ${escapeHtml(normalized.dropoffAddress)}. Thanks for using Shurget!</p>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${ratingUrl}" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold;font-size:16px;">⭐ Rate Your Driver</a>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;text-align:center;">Had an issue? <a href="mailto:hello@shurgetapp.com?subject=Order%20%23${normalized.id}" style="color:#ea580c;">Contact support</a> &nbsp;·&nbsp; <a href="https://shurget-5..app/help" style="color:#ea580c;">Help Center</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Your Shurget delivery is complete — rate your driver`,
      HtmlBody: html,
      TextBody: `Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},\n\nYour ${capitalize(normalized.itemType)} has been delivered. Thanks for using Shurget!\n\nRate your driver: ${ratingUrl}\n\nHad an issue? Reply to this email or contact hello@shurgetapp.com.`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Delivered email error:', res.status, err);
  } else {
    console.log(`[email] Delivered email sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

/**
 * Send cancelled order email to customer.
 */
async function sendCancelledEmail(order) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping cancelled email');
    return;
  }

  const normalized = {
    id:            order.id,
    customerName:  order.customer_name  ?? order.customerName  ?? null,
    customerEmail: order.customer_email ?? order.customerEmail ?? null,
    itemType:      order.item_type      ?? order.itemType      ?? '',
    priceTotal:    order.price_total    ?? order.priceTotal    ?? 0,
  };

  if (!normalized.customerEmail) return;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Order Cancelled</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 16px;">Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 20px;">Your Shurget order #${normalized.id} has been cancelled. If you were charged, a refund will be processed within 5–10 business days.</p>
    <div style="text-align:center;margin-bottom:20px;">
      <a href="https://shurgetit.com/book" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:bold;font-size:16px;">Book Again</a>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Questions? <a href="mailto:hello@shurgetapp.com" style="color:#ea580c;">Contact support</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Shurget Order #${normalized.id} Cancelled`,
      HtmlBody: html,
      TextBody: `Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},\n\nYour Shurget order #${normalized.id} has been cancelled.\n\nIf you were charged, a refund will be processed within 5–10 business days.\n\nBook again: https://shurgetit.com/book\nQuestions? Reply to this email or contact hello@shurgetapp.com.`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Cancelled email error:', res.status, err);
  } else {
    console.log(`[email] Cancelled email sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

/**
 * Send payment failure email to customer — Stripe charge failed.
 */
async function sendPaymentFailureEmail(order, failureReason) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping payment failure email');
    return;
  }

  const normalized = {
    id:            order.id,
    customerName:  order.customer_name  ?? order.customerName  ?? null,
    customerEmail: order.customer_email ?? order.customerEmail ?? null,
    itemType:      order.item_type      ?? order.itemType      ?? '',
    pickupAddress: order.pickup_address ?? order.pickupAddress ?? '',
    dropoffAddress:order.dropoff_address ?? order.dropoffAddress ?? '',
    priceTotal:    order.price_total    ?? order.priceTotal    ?? 0,
  };

  if (!normalized.customerEmail) return;

  const reason = failureReason || 'Your card was declined. Please check your card details or try a different card.';
  const retryUrl = `https://shurgetit.com/book`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#991b1b;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">Payment Failed — Action Required</p>
  </div>
  <div style="border:1px solid #fca5a5;border-top:none;padding:24px;border-radius:0 0 8px 8px;background:#fef2f2;">
    <p style="margin:0 0 16px;">Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},</p>
    <p style="margin:0 0 16px;">We couldn't charge the card on file for your Shurget order #${normalized.id}. <strong>Your order has not been confirmed.</strong></p>

    <div style="background:#fff;border:1.5px solid #fca5a5;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="color:#991b1b;font-size:12px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">What happened</div>
      <div style="color:#7f1d1d;font-size:14px;">${escapeHtml(reason)}</div>
    </div>

    <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;">
        <div style="color:#6b7280;font-size:11px;text-transform:uppercase;">Order ID</div>
        <div style="font-weight:bold;">#${normalized.id}</div>
      </div>
      <div style="margin-bottom:8px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;">
        <div style="color:#6b7280;font-size:11px;text-transform:uppercase;">Item</div>
        <div style="font-weight:600;">${capitalize(normalized.itemType)}</div>
      </div>
      <div>
        <div style="color:#6b7280;font-size:11px;text-transform:uppercase;">Total</div>
        <div style="font-weight:bold;font-size:1.1rem;color:#ea580c;">$${Number(normalized.priceTotal).toFixed(2)}</div>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:20px;">
      <a href="${retryUrl}" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:16px 36px;border-radius:6px;font-weight:bold;font-size:17px;">Update Card & Retry Payment</a>
    </div>
    <p style="color:#6b7280;font-size:13px;margin:0;">Need help? <a href="mailto:hello@shurgetapp.com?subject=Order%20%23${normalized.id}%20payment%20issue" style="color:#ea580c;">Contact support</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: normalized.customerEmail,
      Subject: `Shurget payment failed — please update your card to confirm order #${normalized.id}`,
      HtmlBody: html,
      TextBody: `Hi${normalized.customerName ? ` ${normalized.customerName.split(' ')[0]}` : ''},\n\nWe couldn't charge the card on file for your Shurget order #${normalized.id}. Your order has not been confirmed.\n\nWhat happened: ${reason}\n\nRetry payment: ${retryUrl}\n\nQuestions? Reply to this email or contact hello@shurgetapp.com.`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Payment failure email error:', res.status, err);
  } else {
    console.log(`[email] Payment failure email sent to ${normalized.customerEmail} for order #${normalized.id}`);
  }
}

/**
 * Alert a driver when a new job is posted within their service area.
 * Links directly to the claim page so they can accept immediately.
 */
async function sendDriverNewJobAlert({ driverEmail, driverName, orderId, itemType, pickupAddress, dropoffAddress, priceTotal, claimUrl }) {
  if (!POSTMARK_SERVER_TOKEN) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping driver new job alert');
    return;
  }
  const firstName = driverName ? driverName.split(' ')[0] : 'Driver';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222;">
  <div style="background:#1a1a2e;color:#fff;padding:24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:24px;">Shurget</h1>
    <p style="margin:4px 0 0;opacity:.8;">New Job Available — Claim It Now</p>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
    <p style="margin:0 0 8px;">Hi${firstName ? ` ${firstName}` : ''},</p>
    <p style="margin:0 0 20px;">A new delivery job just posted. First driver to claim it gets the job.</p>

    <div style="background:#f9fafb;border-radius:6px;padding:16px;margin-bottom:20px;">
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Item</div>
        <div style="font-weight:bold;font-size:16px;">${capitalize(itemType || 'Delivery')}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Pickup</div>
        <div style="font-size:15px;">${escapeHtml(pickupAddress || '—')}</div>
      </div>
      <div style="margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:12px;">
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Dropoff</div>
        <div style="font-size:15px;">${escapeHtml(dropoffAddress || '—')}</div>
      </div>
      <div>
        <div style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.5px;">Your Earnings</div>
        <div style="font-size:18px;font-weight:bold;color:#16a34a;">$${Number(priceTotal * 0.82).toFixed(2)} (82%)</div>
      </div>
    </div>

    <div style="text-align:center;margin-bottom:20px;">
      <a href="${escapeHtml(claimUrl)}"
         style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:16px 32px;border-radius:8px;font-weight:bold;font-size:17px;">
        Claim This Job →
      </a>
    </div>

    <p style="color:#6b7280;font-size:12px;margin:0;">Or open directly: <a href="${escapeHtml(claimUrl)}">${escapeHtml(claimUrl)}</a></p>
  </div>
</body>
</html>`;

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: driverEmail,
      Subject: `🚚 New Shurget Job Available — Claim it before someone else does`,
      HtmlBody: html,
      TextBody: `Hi${firstName ? ` ${firstName}` : ''},\n\nA new delivery job is available on Shurget.\n\nItem: ${capitalize(itemType)}\nPickup: ${pickupAddress}\nDropoff: ${dropoffAddress}\nYour Earnings: $${Number(priceTotal * 0.82).toFixed(2)}\n\nClaim it now: ${claimUrl}`,
      MessageStream: 'outbound',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] Driver new job alert error:', res.status, err);
  } else {
    console.log(`[email] New job alert sent to ${driverEmail} for order #${orderId}`);
  }
}

module.exports = {
  sendConfirmationEmail,
  sendQuoteRequestEmail,
  sendDriverApplicationConfirmation,
  sendDriverAssignedEmail,
  sendInTransitEmail,
  sendDeliveredEmail,
  sendCancelledEmail,
  sendPaymentFailureEmail,
  sendPartnerLeadEmail,
  sendReferralCodeEmail,
  sendReferrerCreditEmail,
  sendDriverReferralBountyEmail,
  sendPostDeliveryReviewEmail,
  sendPartnerApplicationReceived,
  sendPartnerMagicLink,
  sendDriverNewJobAlert,
};