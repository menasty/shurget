// routes/booking.js — Booking API endpoints
// POST /api/booking/calculate — calculate price from item + addresses
// POST /api/booking/create-session — create order + Stripe Checkout session, return URL
// GET  /api/booking/success     — verify Stripe session and mark order paid

const express = require('express');
const router = express.Router();
const { calculatePrice, setStripeSession, markOrderPaid } = require('../db/orders');
const { calculateDistance } = require('../services/maps');
const { matchDriver } = require('../services/driver');
const { sendConfirmationEmail } = require('../services/email');
const { createCheckoutSession, getSessionStatus } = require('../services/stripe');
const { getReferralCodeByCode } = require('../db/referrals');

const REFERRAL_DISCOUNT_CENTS = 2000; // $20

router.post('/calculate', async (req, res) => {
  try {
    const { itemType, customItem, pickupAddress, dropoffAddress, helpers } = req.body;
    if (!itemType || !pickupAddress || !dropoffAddress) {
      return res.status(400).json({ error: 'itemType, pickupAddress, and dropoffAddress are required' });
    }

    // "Other" with custom text → store custom text as the item_type for display
    const effectiveItemType = (itemType === 'other' && customItem) ? customItem : itemType;

    const distanceResult = await calculateDistance(pickupAddress, dropoffAddress);
    const distanceMiles = distanceResult?.distanceMiles ?? 5;

    const helperCount = Number.isInteger(helpers) && helpers >= 0 ? Math.min(helpers, 2) : 0;
    const pricing = calculatePrice(itemType, distanceMiles, helperCount);
    const driver = await matchDriver();

    // Flag when we're using a fallback driver (no real drivers in pool)
    const noDriverAvailable = driver.driverId === null;

    res.json({
      pricing,
      itemType: effectiveItemType,
      distanceMiles,
      pickupCoords: distanceResult?.pickupCoords ?? null,
      dropoffCoords: distanceResult?.dropoffCoords ?? null,
      driver,
      noDriverAvailable,
    });
  } catch (err) {
    console.error('[/api/booking/calculate]', err);
    res.status(500).json({ error: 'Failed to calculate price' });
  }
});

/**
 * POST /api/booking/create-session
 * Creates a pending order and a Stripe Checkout session.
 * Returns { checkoutUrl } so the frontend can redirect to Stripe.
 */
router.post('/create-session', async (req, res) => {
  try {
    const {
      itemType, customItem, pickupAddress, dropoffAddress, helpers,
      customerName, customerPhone, customerEmail,
      referralCode, partnerSlug, smsConsent,
      utmSourceFirst, utmMediumFirst, utmCampaignFirst,
      utmSourceLast,  utmMediumLast,  utmCampaignLast,
    } = req.body;
    if (!itemType || !pickupAddress || !dropoffAddress) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const effectiveItemType = (itemType === 'other' && customItem) ? customItem : itemType;

    const distanceResult = await calculateDistance(pickupAddress, dropoffAddress);
    const distanceMiles = distanceResult?.distanceMiles ?? 5;
    const pickupCoords  = distanceResult?.pickupCoords  ?? null;
    const dropoffCoords = distanceResult?.dropoffCoords ?? null;

    const { createOrder } = require('../db/orders');
    const helperCount = Number.isInteger(helpers) && helpers >= 0 ? Math.min(helpers, 2) : 0;
    const pricing = calculatePrice(itemType, distanceMiles, helperCount);
    const driver = await matchDriver();

    // Validate referral code if provided
    let validatedCode = null;
    let referralDiscountCents = 0;
    if (referralCode && typeof referralCode === 'string') {
      const codeRow = await getReferralCodeByCode(referralCode.trim());
      if (codeRow) {
        const isOwn = customerEmail && codeRow.owner_email === customerEmail.toLowerCase().trim();
        const atLimit = codeRow.max_uses !== null && codeRow.uses_count >= codeRow.max_uses;
        if (!isOwn && !atLimit) {
          validatedCode = codeRow.code;
          referralDiscountCents = REFERRAL_DISCOUNT_CENTS;
        }
      }
    }

    const discountedTotal = Math.max(0, pricing.priceTotal - referralDiscountCents / 100);

    // Create order in pending_payment state (not yet confirmed)
    const order = await createOrder({
      itemType: effectiveItemType,
      pickupAddress,
      dropoffAddress,
      pickupLat:   pickupCoords?.lat  || null,
      pickupLng:   pickupCoords?.lng  || null,
      dropoffLat:  dropoffCoords?.lat || null,
      dropoffLng:  dropoffCoords?.lng || null,
      distanceMiles,
      customerName,
      customerPhone,
      customerEmail,
      status: 'pending_payment',
      etaMinutes: driver.eta,
      driverName: driver.name,
      driverPhone: driver.phone,
      driverId: driver.driverId || null,
      referralCodeUsed: validatedCode,
      referralDiscountCents,
      partnerSlug: partnerSlug || null,
      smsConsent: !!smsConsent,
      utmSourceFirst:   utmSourceFirst   || null,
      utmMediumFirst:   utmMediumFirst   || null,
      utmCampaignFirst: utmCampaignFirst || null,
      utmSourceLast:    utmSourceLast    || null,
      utmMediumLast:    utmMediumLast    || null,
      utmCampaignLast:  utmCampaignLast  || null,
    });

    // Create Stripe Checkout session (with discount line item if referral applied)
    const session = await createCheckoutSession({
      orderId: order.id,
      amount: discountedTotal,
      itemType,
      customerEmail,
      referralDiscountCents,
      originalAmount: pricing.priceTotal,
    });

    // Persist the Stripe session ID on the order
    await setStripeSession(order.id, session.id);

    const effectivePricing = { ...pricing, priceTotal: discountedTotal, referralDiscountCents };

    res.json({
      success: true,
      checkoutUrl: session.url,
      orderId: order.id,
      pricing: effectivePricing,
    });
  } catch (err) {
    console.error('[/api/booking/create-session]', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/booking/waitlist
 * Captures customer interest when no drivers are available in their area.
 * Body: { email, pickupZip, dropoffZip, itemType }
 */
router.post('/waitlist', async (req, res) => {
  try {
    const { email, pickupZip, dropoffZip, itemType } = req.body;
    if (!email || !pickupZip) {
      return res.status(400).json({ error: 'email and pickupZip are required' });
    }

    const { addToWaitlist } = require('../db/waitlist');
    const entry = await addToWaitlist({ email, pickupZip, dropoffZip, itemType });

    res.json({
      success: true,
      message: entry
        ? "You're on the list! We'll email you when a driver is available in your area."
        : "You're already on the list — we'll be in touch.",
    });
  } catch (err) {
    console.error('[/api/booking/waitlist]', err);
    res.status(500).json({ error: 'Failed to add to waitlist' });
  }
});

/**
 * GET /api/booking/success?session_id=...&order_id=...
 * Called by the confirmation page after redirect from Stripe.
 * Verifies the session is paid and promotes order to 'paid' status.
 */
router.get('/success', async (req, res) => {
  try {
    const { session_id, order_id } = req.query;
    if (!session_id || !order_id) {
      return res.status(400).json({ error: 'session_id and order_id are required' });
    }

    const statusResult = await getSessionStatus(session_id);
    if (!statusResult) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (statusResult.paymentStatus === 'paid') {
      const order = await markOrderPaid(order_id, new Date());
      return res.json({ success: true, order, paymentStatus: 'paid' });
    }

    // Stripe session exists but not yet paid (e.g. cancelled)
    return res.json({ success: false, paymentStatus: statusResult.paymentStatus });
  } catch (err) {
    console.error('[/api/booking/success]', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

module.exports = router;