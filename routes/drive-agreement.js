// routes/drive-agreement.js — Driver Independent Contractor Agreement
// GET  /drive/agreement?email=:email   — render agreement page (pre-fill name/email if found)
// POST /drive/agreement                — record electronic signature

const express = require('express');
const router  = express.Router();
const { getDriverApplicationByEmail, recordAgreementSignature } = require('../db/drivers');

// ── GET /drive/agreement ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) {
    return res.render('driver-agreement', {
      prefillName:  '',
      prefillEmail: '',
      applicationId: '',
      alreadySigned: false,
      error: null,
    });
  }

  try {
    const app = await getDriverApplicationByEmail(email);
    if (app && app.agreement_signed_at) {
      const signedAt = new Date(app.agreement_signed_at).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      return res.render('driver-agreement', {
        alreadySigned:  true,
        signedAt,
        prefillName:    app.name  || '',
        prefillEmail:   app.email || '',
        applicationId:  app.id   || '',
        error: null,
      });
    }
    return res.render('driver-agreement', {
      prefillName:   app ? (app.name  || '') : '',
      prefillEmail:  app ? (app.email || '') : email,
      applicationId: app ? (app.id   || '') : '',
      alreadySigned: false,
      error: null,
    });
  } catch (err) {
    console.error('[drive-agreement GET]', err.message);
    return res.render('driver-agreement', {
      prefillName: '', prefillEmail: email, applicationId: '',
      alreadySigned: false, error: null,
    });
  }
});

// ── POST /drive/agreement ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    signatureName,
    email,
    applicationId,
    chkContractor,
    chkTax,
    chkLiability,
    chkInsurance,
    chkArbitration,
    chkFull,
  } = req.body;

  const name  = (signatureName || '').trim();
  const emailN = (email || '').trim().toLowerCase();

  // Server-side validation
  if (!name || name.split(' ').length < 2) {
    return res.render('driver-agreement', {
      prefillName: name, prefillEmail: emailN, applicationId: applicationId || '',
      alreadySigned: false,
      error: 'Please enter your full legal name (first and last).',
    });
  }
  if (!emailN || !emailN.includes('@')) {
    return res.render('driver-agreement', {
      prefillName: name, prefillEmail: emailN, applicationId: applicationId || '',
      alreadySigned: false,
      error: 'Please enter a valid email address.',
    });
  }

  const allBoxes = [chkContractor, chkTax, chkLiability, chkInsurance, chkArbitration, chkFull];
  if (!allBoxes.every(v => v === 'on')) {
    return res.render('driver-agreement', {
      prefillName: name, prefillEmail: emailN, applicationId: applicationId || '',
      alreadySigned: false,
      error: 'All boxes must be checked before submitting.',
    });
  }

  // Capture IP (supports X-Forwarded-For from Render proxy)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    // Look up application by email — email is the authoritative key
    let app = await getDriverApplicationByEmail(emailN);

    if (!app) {
      return res.render('driver-agreement', {
        prefillName: name, prefillEmail: emailN, applicationId: '',
        alreadySigned: false,
        error: 'No driver application found for that email. Please apply to drive first.',
      });
    }

    if (app.agreement_signed_at) {
      // Already signed — show confirmation
      const signedAt = new Date(app.agreement_signed_at).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
      return res.render('driver-agreement', {
        alreadySigned: true, signedAt,
        prefillName: app.name || name, prefillEmail: app.email,
        applicationId: app.id, error: null,
      });
    }

    // Record signature
    await recordAgreementSignature(app.id, name, ip);

    // Redirect to confirmation
    return res.redirect('/drive/agreement/confirmed?email=' + encodeURIComponent(emailN));
  } catch (err) {
    console.error('[drive-agreement POST]', err.message);
    return res.render('driver-agreement', {
      prefillName: name, prefillEmail: emailN, applicationId: applicationId || '',
      alreadySigned: false,
      error: 'Something went wrong. Please try again or contact support@shurget.com.',
    });
  }
});

// ── GET /drive/agreement/confirmed ───────────────────────────────────────────
router.get('/confirmed', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  let signedAt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  if (email) {
    try {
      const app = await getDriverApplicationByEmail(email);
      if (app && app.agreement_signed_at) {
        signedAt = new Date(app.agreement_signed_at).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        });
      }
    } catch (_) {}
  }
  return res.render('driver-agreement', {
    alreadySigned: true, signedAt,
    prefillName: '', prefillEmail: email, applicationId: '',
    error: null,
  });
});

module.exports = router;
