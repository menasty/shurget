const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('booking', {
    title: "Book a Haul - Shurget",
    description: "Get an instant quote for same-day pickup truck delivery."
  });
});

// Basic POST handler (we'll expand this next)
router.post('/', (req, res) => {
  console.log('Booking submitted:', req.body);
  res.send(`
    <h1>Thank you!</h1>
    <p>Your booking request has been received.</p>
    <p><a href="/book">Book Another Haul</a></p>
    <p><a href="/">← Back to Home</a></p>
  `);
});

module.exports = router;
