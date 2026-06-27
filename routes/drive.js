const express = require('express');
const router = express.Router();
const {
  createDriverApplication,
  getDriverApplicationByEmail,
} = require('../db/drivers');

function wantsJson(req) {
  const accept = req.get('accept') || '';
  return req.is('application/json') || accept.includes('application/json');
}

router.get('/', async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.render('drive', { application: null });
    }

    const application = await getDriverApplicationByEmail(email);
    return res.render('drive', { application: application || null });
  } catch (err) {
    console.error(err);
    return res.render('drive', { application: null });
  }
});

router.post('/', async (req, res) => {
  const expectsJson = wantsJson(req);

  try {
    const {
      name,
      email,
      phone,
      vehicleType,
      city,
      vehicleInsuranceDoc,
      driverLicenseDoc,
      vehicleRegistrationDoc,
      backgroundCheckConsent,
      utmSource,
      utmMedium,
      utmCampaign,
    } = req.body;

    const normalizedEmail = (email || '').trim().toLowerCase();

    if (!name || !normalizedEmail || !phone || !vehicleType || !city) {
      if (expectsJson) {
        return res.status(400).json({ error: 'Please fill out all required fields.' });
      }
      return res.status(400).send('<h2 style="color:red">Please fill out all required fields.</h2>');
    }

    const application = await createDriverApplication({
      name,
      email: normalizedEmail,
      phone,
      vehicleType,
      city,
      vehicleInsuranceDoc,
      driverLicenseDoc,
      vehicleRegistrationDoc,
      backgroundCheckConsent,
      utmSource,
      utmMedium,
      utmCampaign,
    });

    if (expectsJson) {
      return res.status(201).json({
        success: true,
        message: 'Thanks for Applying. Reviewing Application',
        application,
      });
    }

    return res.redirect('/drive?email=' + encodeURIComponent(normalizedEmail));

  } catch (err) {
    const isDuplicateEmail = err && err.code === '23505' && err.constraint === 'driver_applications_email_key';

    if (isDuplicateEmail) {
      const normalizedEmail = (req.body.email || '').trim().toLowerCase();
      const existing = await getDriverApplicationByEmail(normalizedEmail);

      if (expectsJson) {
        if (existing) {
          return res.status(200).json({
            success: true,
            alreadyExists: true,
            message: 'Thanks for Applying. Reviewing Application',
            application: existing,
          });
        }
        return res.status(409).json({ error: 'An application with this email already exists.' });
      }

      if (existing) {
        return res.redirect('/drive?email=' + encodeURIComponent(normalizedEmail));
      }
      return res.status(409).send('<h2 style="color:red">An application with this email already exists.</h2>');
    }

    console.error(err);

    if (expectsJson) {
      return res.status(500).json({ error: 'Error submitting application. Please try again.' });
    }

    return res.status(500).send('<h2 style="color:red">Error submitting application. Please try again.</h2>');
  }
});

module.exports = router;
