const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('<h1>Shurget - On Demand Pickup Trucks</h1><p>Welcome. App is live.</p><a href="/book">Book a Haul</a>');
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// Routes
app.use('/admin', require('./routes/admin'));
app.use('/book', require('./routes/booking'));

app.listen(port, () => {
  console.log(`✅ Shurget server running on port ${port}`);
});
