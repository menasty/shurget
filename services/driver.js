// services/driver.js — Driver matching
// Looks up active drivers from the DB and assigns one to a booking.
// Falls back to a random pool driver if no real drivers are available.

const { getActiveDrivers } = require('../db/drivers');

// Fallback pool used when no real drivers are available (dev / empty pool)
const FALLBACK_DRIVERS = [
  { name: 'Marcus T.', phone: '+1 (555) 010-4421' },
  { name: 'Diane R.',   phone: '+1 (555) 019-7735' },
  { name: 'Jon K.',    phone: '+1 (555) 027-5582' },
  { name: 'Pat W.',    phone: '+1 (555) 033-6619' },
  { name: 'Sam L.',    phone: '+1 (555) 041-2847' },
];

/**
 * Pick the best available driver for an order.
 * Prioritises real active drivers from DB; falls back to the hardcoded pool.
 * Returns { name, phone, eta, driverId }.
 */
async function matchDriver() {
  let drivers = [];
  try {
    drivers = await getActiveDrivers();
  } catch (err) {
    console.error('[driver-matching] Failed to query active drivers, using fallback pool:', err.message);
  }

  if (drivers.length === 0) {
    // No active drivers — use fallback so booking still works in dev
    const fallback = FALLBACK_DRIVERS[Math.floor(Math.random() * FALLBACK_DRIVERS.length)];
    return { ...fallback, eta: Math.floor(Math.random() * 15) + 5, driverId: null };
  }

  // Round-robin-style pick: pick the driver with the most recent reviewed_at
  // (or oldest if all reviewed_at is null — i.e., admin-activated from older applications)
  const driver = drivers.reduce((oldest, d) => {
    const dTime = d.reviewed_at ? new Date(d.reviewed_at) : new Date(0);
    const oTime = oldest.reviewed_at ? new Date(oldest.reviewed_at) : new Date(0);
    return dTime > oTime ? d : oldest;
  });

  return {
    name:     driver.name,
    phone:    driver.phone,
    eta:      Math.floor(Math.random() * 15) + 5,
    driverId: driver.id,
  };
}

/**
 * Notify all active drivers about a new available job.
 * Sends an email alert with job details and a direct claim link.
 * Fire-and-forget — never blocks order completion.
 */
async function notifyDriversOfNewJob(order) {
  try {
    const { getActiveDrivers } = require('../db/drivers');
    const { sendDriverNewJobAlert } = require('./email');

    const drivers = await getActiveDrivers();
    const claimBase = 'https://shurget.com/driver/jobs';

    await Promise.all(drivers.map(driver => {
      const claimUrl = `${claimBase}?email=${encodeURIComponent(driver.email)}`;
      return sendDriverNewJobAlert({
        driverEmail:    driver.email,
        driverName:     driver.name,
        orderId:        order.id,
        itemType:       order.item_type,
        pickupAddress:  order.pickup_address,
        dropoffAddress: order.dropoff_address,
        priceTotal:     order.price_total,
        claimUrl,
      }).catch(err => {
        console.error(`[driver-alert] Failed to notify ${driver.email} for order ${order.id}:`, err.message);
      });
    }));
  } catch (err) {
    console.error('[driver-alert] notifyDriversOfNewJob error:', err.message);
  }
}

module.exports = { matchDriver, notifyDriversOfNewJob };