// routes/referral.js — Referral code validation and stats API
// Owns: POST /api/referral/validate, GET /api/referral/stats
// Does NOT own: code generation (triggered by webhook), Stripe discount (handled in booking route)

const express = require('express');
const router = express.Router();
const { getReferralCodeByCode, getReferralStats } = require('../db/referrals');

const REFERRAL_DISCOUNT_CENTS = 2000; // $20

/**
 * POST /api/referral/validate
 * Body: { code, bookerEmail }
 * Returns: { valid, discount_cents, discount_display, message }
 * Rejects self-referral (owner_email === bookerEmail).
 */
router.post('/validate', async (req, res) => {
  try {
    const { code, bookerEmail } = req.body;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, message: 'Code is required.' });
    }

    const row = await getReferralCodeByCode(code.trim());
    if (!row) {
      return res.json({ valid: false, message: 'Code not found.' });
    }

    // Check max_uses
    if (row.max_uses !== null && row.uses_count >= row.max_uses) {
      return res.json({ valid: false, message: 'This code has reached its usage limit.' });
    }

    // No self-referral
    if (bookerEmail && row.owner_email === bookerEmail.toLowerCase().trim()) {
      return res.json({ valid: false, message: 'You cannot use your own referral code.' });
    }

    return res.json({
      valid: true,
      discount_cents: REFERRAL_DISCOUNT_CENTS,
      discount_display: `$${(REFERRAL_DISCOUNT_CENTS / 100).toFixed(0)} off`,
      code: row.code,
      message: `Code applied — $${(REFERRAL_DISCOUNT_CENTS / 100).toFixed(0)} off your order!`,
    });
  } catch (err) {
    console.error('[referral/validate]', err);
    res.status(500).json({ valid: false, message: 'Could not validate code.' });
  }
});

/**
 * GET /api/referral/stats?email=...
 * Returns the customer's referral code + stats (referred count, credits earned).
 */
router.get('/stats', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const stats = await getReferralStats(email);
    res.json(stats);
  } catch (err) {
    console.error('[referral/stats]', err);
    res.status(500).json({ error: 'Could not fetch referral stats' });
  }
});

module.exports = router;
