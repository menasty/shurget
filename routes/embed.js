// routes/embed.js — Embeddable widget iframe endpoint
// Owns: GET /embed/quote (iframe view), POST /api/embed/calculate (price calculation for widget)
// Does NOT own: pricing logic (db/orders.js), geocoding (services/maps.js)

const express = require('express');
const router = express.Router();

// Allow cross-origin calls from any retailer domain (widget embeds on external sites)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function applyCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}
const { calculatePrice } = require('../db/orders');
const { calculateDistance } = require('../services/maps');

/**
 * GET /embed/quote
 * Renders the widget iframe content.
 * Query params: item, weight, origin_zip, partner
 */
router.get('/quote', (req, res) => {
  const { item = 'other', weight = 'standard', origin_zip = '', partner = '' } = req.query;
  res.render('embed-quote', { item, weight, originZip: origin_zip, partner });
});

/**
 * OPTIONS /api/embed/calculate
 * Preflight for cross-origin requests from retailer embed pages.
 */
router.options('/calculate', (req, res) => {
  applyCors(res);
  res.sendStatus(204);
});

/**
 * POST /api/embed/calculate
 * Given item type + origin ZIP + destination ZIP, return price breakdown.
 * Used by the embed iframe to show live pricing.
 */
router.post('/calculate', async (req, res) => {
  applyCors(res);
  try {
    const { item, originZip, destZip } = req.body;
    if (!originZip || !destZip) {
      return res.status(400).json({ error: 'originZip and destZip are required' });
    }

    const itemType = item || 'other';
    const pickupAddress  = originZip + ', TX';
    const dropoffAddress = destZip   + ', TX';

    const distanceResult = await calculateDistance(pickupAddress, dropoffAddress);
    const distanceMiles  = distanceResult?.distanceMiles ?? 5;
    const pricing        = calculatePrice(itemType, distanceMiles, 0);

    return res.json({
      success: true,
      distanceMiles,
      pricing,
      itemType,
    });
  } catch (err) {
    console.error('[embed/calculate]', err);
    return res.status(500).json({ error: 'Failed to calculate price' });
  }
});

module.exports = router;
