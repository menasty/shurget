const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('booking', {
    title: "Book a Haul - Shurget",
    description: "Get an instant quote for same-day pickup truck delivery."
  });
});

module.exports = router;
