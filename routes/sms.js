// routes/sms.js — Inbound SMS handling
// Owns: Twilio inbound webhook (opt-out via STOP), any other inbound SMS events.
// Does NOT own: outbound SMS sending (services/sms.js).

const express = require('express');
const router = express.Router();
const { handleSmsOptOut } = require('../services/sms');

/**
 * POST /api/sms/inbound
 * Receives Twilio inbound SMS webhooks.
 * Used for: STOP opt-out handling, any future inbound commands.
 *
 * Twilio POSTs: From, Body, To, MessageSid, AccountSid, etc.
 * Only handles STOP opt-out at this time (TCPA compliance).
 */
router.post('/inbound', async (req, res) => {
  const { From, Body } = req.body || {};
  const body = (Body || '').trim().toUpperCase();

  // Handle STOP opt-out: mark this phone as unsubscribed
  if (body === 'STOP' || body === 'UNSUBSCRIBE' || body === 'STOPALL') {
    if (From) {
      try {
        await handleSmsOptOut(From);
      } catch (err) {
        console.error('[sms/inbound] Error processing opt-out:', err.message);
        // Still respond 200 to Twilio — we don't want retry storms
      }
    }
  }

  // Always respond 200 to Twilio (Twilio will retry otherwise)
  res.status(200).send('OK');
});

module.exports = router;