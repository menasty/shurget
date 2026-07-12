// services/sms.js — Twilio SMS notifications
// Owns: sending SMS to customers and drivers on order lifecycle events
// Does NOT own: email (services/email.js), notification preferences (stored in orders table)
// SMS sending is fire-and-forget; failures never break the order flow.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_FROM  = process.env.TWILIO_PHONE_FROM;
const ADMIN_PHONE        = process.env.ADMIN_PHONE;
const APP_URL = process.env.APP_URL || 'https://shurgetapp.com';

// ─── Low-level send ──────────────────────────────────────────────────────────

function toE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.startsWith('+')) return digits;
  return null;
}

function authHeader() {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${creds}`;
}

async function sendSms(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_FROM) {
    console.warn('[sms] Twilio not configured — skipping SMS to', to);
    return;
  }
  const e164 = toE164(to);
  if (!e164) {
    console.warn('[sms] Invalid phone number — skipping:', to);
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: TWILIO_PHONE_FROM, To: e164, Body: body }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[sms] Twilio error:', res.status, err);
  } else {
    console.log(`[sms] Sent to ${e164}: ${body.substring(0, 40)}…`);
  }
}

// ─── Customer SMS: order lifecycle ────────────────────────────────────────────

async function sendCustomerSms(order, body) {
  if (!order) return;
  if (!order.sms_consent) {
    console.log(`[sms] sms_consent=false for order ${order.id} — skipping customer SMS`);
    return;
  }
  if (order.sms_unsubscribed) {
    console.log(`[sms] Unsubscribed for order ${order.id} — skipping customer SMS`);
    return;
  }
  const phone = order.customer_phone || order.customerPhone;
  if (!phone) {
    console.warn('[sms] No customer phone for order', order.id, '— skipping');
    return;
  }
  await sendSms(phone, body);
}

/** Order confirmed / payment successful */
async function sendOrderConfirmedSms(order) {
  await sendCustomerSms(order,
    `Your haul is booked! Order #${order.id}. Track: ${APP_URL}/track/${order.id}`
  );
}

/** Driver assigned to order */
async function sendDriverAssignedSms(order) {
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  const driverName = order.driver_name || order.driverName || 'Your driver';
  const eta = order.eta_minutes || order.etaMinutes;
  const etaText = eta ? ` ETA: ~${eta} min.` : '';
  await sendCustomerSms(order,
    `${greeting} — ${driverName} has been assigned to your Shurget delivery.${etaText} Track: ${APP_URL}/track/${order.id}`
  );
}

/** Driver en route / in progress */
async function sendInTransitSms(order) {
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  await sendCustomerSms(order,
    `${greeting} — your haul is on the way! Track live: ${APP_URL}/track/${order.id}`
  );
}

/** Order delivered */
async function sendDeliveredSms(order) {
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  await sendCustomerSms(order,
    `${greeting} — your haul is complete! Rate your driver: ${APP_URL}/rate/${order.id}`
  );
}

/** Payment failed on Stripe Checkout */
async function sendPaymentFailedSms(order) {
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  await sendCustomerSms(order,
    `${greeting} — payment for your Shurget order failed. Please update your card and retry: ${APP_URL}/book`
  );
}

// ─── Driver dispatch SMS (existing, kept for compatibility) ──────────────────

async function sendDriverDispatchedSms(order) {
  const phone = order.customer_phone || order.customerPhone;
  if (!phone) {
    console.warn('[sms] No customer phone for order', order.id, '— skipping dispatch SMS');
    return;
  }
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  const driverName = order.driver_name || order.driverName || 'Your driver';
  const eta = order.eta_minutes || order.etaMinutes || '';
  const etaText = eta ? `ETA: ~${eta} min. ` : '';

  await sendSms(phone,
    `${greeting} — ${driverName} has been assigned to your Shurget delivery. ${etaText}Track: ${APP_URL}/track/${order.id}`
  );
}

async function sendDriverEnRouteSms(order) {
  const phone = order.customer_phone || order.customerPhone;
  if (!phone) {
    console.warn('[sms] No customer phone for order', order.id, '— skipping en-route SMS');
    return;
  }
  const name = order.customer_name || order.customerName || '';
  const firstName = name ? name.split(' ')[0] : '';
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  const driverName = order.driver_name || order.driverName || 'Your driver';
  const eta = order.eta_minutes || order.etaMinutes || '';
  const etaText = eta ? ` ETA: ~${eta} min.` : '';

  await sendSms(phone,
    `${greeting} — ${driverName} is heading to pick you up now.${etaText} Track live: ${APP_URL}/track/${order.id}`
  );
}

// ─── Admin SMS alerts ─────────────────────────────────────────────────────────

async function sendAdminPaymentFailureSms(orderId) {
  if (!ADMIN_PHONE) {
    console.warn('[sms] ADMIN_PHONE not set — skipping admin payment failure SMS');
    return;
  }
  await sendSms(ADMIN_PHONE,
    `[Shurget] Payment failed for order #${orderId}. Check Stripe dashboard.`
  );
}

async function sendAdminNewDriverSignupSms(driverName, driverEmail) {
  if (!ADMIN_PHONE) return;
  await sendSms(ADMIN_PHONE,
    `[Shurget] New driver signup: ${driverName} (${driverEmail}). Review at: ${APP_URL}/admin/drivers`
  );
}

// ─── STOP / opt-out handling ──────────────────────────────────────────────────

/**
 * Handle incoming STOP opt-out from customer reply.
 * Marks the customer's phone as unsubscribed so no future SMS are sent.
 * Supports: individual order records (matched by phone) and a
 * customers table (if added later). Currently marks all matching orders.
 *
 * In a production system you'd have a dedicated sms_subscriptions table
 * keyed by phone. Here we flip the flag on any order with that customer phone.
 * Note: this means a customer who used different emails still gets unsubscribed.
 */
async function handleSmsOptOut(phone) {
  const { updateUnsubscribeByPhone } = require('../db/orders');
  await updateUnsubscribeByPhone(phone);
  console.log(`[sms] Opt-out processed for ${phone}`);
}

// ─── Rate limiting: driver SMS per order ──────────────────────────────────────
// Currently implemented as the caller being responsible for calling only once
// per event. In future: add a driver_notification_log table with
// (driver_id, order_id, event_type, sent_at) and a unique constraint to
// enforce "1 SMS per driver per order per event type" at the DB level.

module.exports = {
  // Low-level
  sendSms,
  // Customer lifecycle (opt-in gated)
  sendOrderConfirmedSms,
  sendDriverAssignedSms,
  sendInTransitSms,
  sendDeliveredSms,
  sendPaymentFailedSms,
  // Driver dispatch (legacy — kept for route compatibility)
  sendDriverDispatchedSms,
  sendDriverEnRouteSms,
  // Admin alerts
  sendAdminPaymentFailureSms,
  sendAdminNewDriverSignupSms,
  // Opt-out
  handleSmsOptOut,
};