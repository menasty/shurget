// SEO landing pages — Austin local search targeting.
// Owns: /austin-furniture-delivery, /sofa-delivery-austin,
//       /mattress-delivery-austin, /marketplace-pickup-austin
// Does NOT own: booking API, pricing logic, or driver matching.

const express = require('express');
const router = express.Router();

router.get('/austin-furniture-delivery', (_req, res) => {
  res.render('austin-furniture-delivery');
});

router.get('/sofa-delivery-austin', (_req, res) => {
  res.render('sofa-delivery-austin');
});

router.get('/mattress-delivery-austin', (_req, res) => {
  res.render('mattress-delivery-austin');
});

router.get('/marketplace-pickup-austin', (_req, res) => {
  res.render('marketplace-pickup-austin');
});

module.exports = router;
