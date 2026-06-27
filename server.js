const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.use('/book', require('./routes/booking'));
app.use('/confirmation', require('./routes/confirmation'));
app.use('/admin', require('./routes/admin'));
app.use('/drive', require('./routes/drive'));
app.use('/driver', require('./routes/driver'));

app.get('/', (req, res) => {
  res.render('layout', { title: 'Shurget - Pickup Truck Delivery' });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

app.listen(port, () => {
  console.log(`✅ Shurget server running on port ${port}`);
});
