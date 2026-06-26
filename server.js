const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

const bodyLimit = process.env.BODY_LIMIT || '10mb';

app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.use('/book', require('./routes/booking'));
app.use('/confirmation', require('./routes/confirmation'));
app.use('/admin', require('./routes/admin'));
app.use('/drive', require('./routes/drive'));     // ← Added
app.use('/driver', require('./routes/driver'));

app.get('/', (req, res) => {
  res.render('layout', { title: 'Shurget - Pickup Truck Delivery' });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'Request payload is too large. Please reduce upload size and try again.'
    });
  }
  return next(err);
});

app.listen(port, () => {
  console.log(`✅ Shurget server running on port ${port}`);
});
