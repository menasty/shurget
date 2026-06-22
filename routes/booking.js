const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send(`
    <h1>Book a Haul - Shurget</h1>
    <p>Customer booking form coming soon.</p>
    <p><a href="/">← Back to Home</a></p>
  `);
});

module.exports = router;
