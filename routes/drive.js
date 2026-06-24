// routes/drive.js — Driver onboarding page, /drive/earn recruitment page, and application API
// GET  /drive/earn          — public driver recruitment landing page (indexable)
// GET  /drive               — render the onboarding wizard (optionally ?email= for status, ?ref=CODE for referral)
// GET  /api/drive/status    — return application status by email
// POST /api/drive           — submit the complete driver application

const express = require('express');
const router = express.Router();
const {
  createDriverApplication,
  getDriverApplicationByEmail,
  getDriverByReferralCode,
} = require('../db/drivers');

// GET /drive/earn — public recruitment landing page; accepts ?ref=CODE for driver referral tracking
router.get('/earn', async (req, res) => {
  const refCode = req.query.ref || null;
  let referrerName = null;
  if (refCode) {
    const referrer = await getDriverByReferralCode(refCode).catch(() => null);
    if (referrer) referrerName = referrer.name;
  }
  res.render('drive-earn', { refCode, referrerName });
});

// GET /drive
router.get('/', async (req, res) => {
  const { email } = req.query;
  let application = null;
  if (email) {
    application = await getDriverApplicationByEmail(email);
  }
  // ga4Id is available via res.locals (set in server.js middleware)
  res.render('drive', { application });
});

// GET /api/drive/status?email=...
router.get('/status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const app = await getDriverApplicationByEmail(email);
  if (!app) return res.status(404).json({ error: 'No application found for that email.' });
  res.json({ application: app });
});

// POST /api/drive — full onboarding submission
// Accepts optional field referredByCode (driver referral code from ?ref= param on /drive wizard)
// Accepts optional utmSource/utmMedium/utmCampaign for driver recruitment attribution
router.post('/', async (req, res) => {
  try {
    const {
      name, email, phone, vehicleType, city,
      vehicleInsuranceDoc, driverLicenseDoc, vehicleRegistrationDoc,
      backgroundCheckConsent, referredByCode,
      utmSource, utmMedium, utmCampaign,
    } = req.body;

    if (!name || !email || !phone || !vehicleType || !city) {
      return res.status(400).json({ error: 'Personal info (name, email, phone, vehicle, city) is required.' });
    }
    if (!backgroundCheckConsent) {
      return res.status(400).json({ error: 'You must consent to the background check to continue.' });
    }

    // Resolve referring driver ID and name from referral code, if provided
    let referredByDriverId = null;
    let referredByDriverName = null;
    if (referredByCode) {
      const referrer = await getDriverByReferralCode(referredByCode).catch(() => null);
      if (referrer) {
        referredByDriverId = referrer.id;
        referredByDriverName = referrer.name;
      }
    }

    const application = await createDriverApplication({
      name, email, phone, vehicleType, city,
      vehicleInsuranceDoc, driverLicenseDoc, vehicleRegistrationDoc,
      backgroundCheckConsent: !!backgroundCheckConsent,
      referredByDriverId,
      referredByDriverName,
      utmSource:   utmSource   || null,
      utmMedium:   utmMedium   || null,
      utmCampaign: utmCampaign || null,
    });

    res.json({ success: true, application: { id: application.id, email: application.email } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An application with that email already exists.' });
    }
    console.error('[/api/drive]', err);
    res.status(500).json({ error: 'Failed to submit application.' });
  }
});

module.exports = router;
