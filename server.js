const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
  res.send('<h1>Shurget - On Demand Pickup Trucks</h1><p>Welcome. <a href="/book">Book a Haul</a></p>');
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// Routes
app.use('/admin', require('./routes/admin'));
app.use('/book', require('./routes/booking'));

app.listen(port, () => {
  console.log(`✅ Shurget server running on port ${port}`);
});
