// routes/orders.js — Order status API endpoints
// GET /api/orders/:id — return order status, addresses, fare, timestamps
// POST /api/orders/:id/location — driver updates their location

const express = require('express');
const router = express.Router();
const { getOrderById, updateDriverLocation, dispatchOrder, completeOrder, cancelOrderByCustomer, cancelOrderUnprepared } = require('../db/orders');
const { sendConfirmationEmail } = require('../services/email');

/**
 * GET /api/orders/:id
 * Returns order status, addresses, fare breakdown, and timestamps.
 * Returns 404 if order not found.
 */
router.get('/:id', async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      id: order.id,
      status: order.status,
      itemType: order.item_type,
      pickup: {
        address: order.pickup_address,
        lat: order.pickup_lat,
        lng: order.pickup_lng,
      },
      dropoff: {
        address: order.dropoff_address,
        lat: order.dropoff_lat,
        lng: order.dropoff_lng,
      },
      distanceMiles: order.distance_miles,
      fare: {
        base: parseFloat(order.price_base),
        fee: parseFloat(order.price_fee),
        total: parseFloat(order.price_total),
        currency: 'USD',
      },
      driver: order.driver_name
        ? {
            name: order.driver_name,
            phone: order.driver_phone,
            etaMinutes: order.eta_minutes,
            location: (order.driver_lat && order.driver_lng)
              ? { lat: order.driver_lat, lng: order.driver_lng, updatedAt: order.driver_location_updated_at }
              : null,
          }
        : null,
      timestamps: {
        created: order.created_at,
        confirmed: order.confirmed_at,
        paid: order.paid_at,
      },
    });
  } catch (err) {
    console.error('[/api/orders/:id]', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * POST /api/orders/:id/location
 * Driver updates their current location (lat/lng).
 * Lightweight — no auth in MVP (driver app would add auth in production).
 */
router.post('/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat and lng must be numbers' });
    }
    const order = await updateDriverLocation(req.params.id, lat, lng);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ ok: true, updatedAt: order.driver_location_updated_at });
  } catch (err) {
    console.error('[/api/orders/:id/location]', err);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

/**
 * POST /api/orders/:id/dispatch
 * Assigns a driver to a paid/assigned order. Call this after Stripe confirms payment.
 * Body: { driverName, driverPhone, etaMinutes, driverId }
 */
router.post('/:id/dispatch', async (req, res) => {
  try {
    const { driverName, driverPhone, etaMinutes, driverId } = req.body;
    if (!driverName || !driverPhone || !etaMinutes) {
      return res.status(400).json({ error: 'driverName, driverPhone, and etaMinutes are required' });
    }

    const order = await dispatchOrder(req.params.id, driverName, driverPhone, etaMinutes, driverId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found or not in a dispatchable state (must be paid or assigned)' });
    }

    // Send driver dispatch confirmation to customer
    await sendConfirmationEmail(order);

    res.json({ success: true, order: { id: order.id, status: order.status, driverName: order.driver_name, driverPhone: order.driver_phone, etaMinutes: order.eta_minutes } });
  } catch (err) {
    console.error('[/api/orders/:id/dispatch]', err);
    res.status(500).json({ error: 'Failed to dispatch order' });
  }
});

/**
 * POST /api/orders/:id/complete
 * Admin/internal: marks order status = 'delivered'.
 * Drivers should use POST /driver/jobs/:id/complete (session-authenticated).
 * This endpoint is admin-scoped — requires admin session cookie.
 */
router.post('/:id/complete', async (req, res) => {
  try {
    // Verify admin session (same cookie pattern as admin routes)
    const adminSession = req.cookies && req.cookies['adm_session'];
    if (!adminSession) {
      return res.status(401).json({ error: 'Unauthorized. Use /driver/jobs/:id/complete for driver-initiated completions.' });
    }
    const order = await completeOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) {
    console.error('[/api/orders/:id/complete]', err);
    res.status(500).json({ error: 'Failed to complete order' });
  }
});

// Admin dispatch actions — assign, start, deliver, cancel, payment-failure alert
const {
  assignDriverToOrder,
  markDelivered,
  cancelOrder,
  markJobStarted,
  markStatusEmailSent,
} = require('../db/orders');
const {
  sendInTransitEmail,
  sendDeliveredEmail,
  sendCancelledEmail,
  sendPaymentFailureEmail,
} = require('../services/email');
const { sendAdminPaymentFailureSms } = require('../services/sms');

/**
 * POST /api/orders/:id/assign — admin assigns driver, triggers in-transit email.
 * Body: { driverId, driverName, driverPhone, etaMinutes }
 */
router.post('/:id/assign', async (req, res, next) => {
  try {
    const { driverId, driverName, driverPhone, etaMinutes } = req.body;
    if (!driverId || !driverName) {
      return res.status(400).json({ error: 'driverId and driverName are required' });
    }
    const order = await assignDriverToOrder(
      req.params.id,
      parseInt(driverId, 10),
      driverName,
      driverPhone || '',
      parseInt(etaMinutes, 10) || 15,
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found or cannot be dispatched.' });
    }
    // Idempotent: send driver-assigned email only once
    markStatusEmailSent(order.id, 'driver_assigned').then(first => {
      if (first) sendInTransitEmail(order).catch(err => {
        console.error('[email] In-transit email failed for order', req.params.id, err.message);
      });
    }).catch(() => {});
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/:id/start — admin marks job in-progress (driver left for pickup).
 */
router.post('/:id/start', async (req, res, next) => {
  try {
    const order = await markJobStarted(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found or not yet assigned.' });
    }
    // Idempotent: send en-route email only once
    markStatusEmailSent(order.id, 'en_route').then(first => {
      if (first) sendInTransitEmail(order).catch(err => {
        console.error('[email] In-transit email failed for order', req.params.id, err.message);
      });
    }).catch(() => {});
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/:id/delivered — admin marks order delivered, triggers delivered email.
 */
router.post('/:id/delivered', async (req, res, next) => {
  try {
    const order = await markDelivered(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    // Idempotent: send delivered email only once
    markStatusEmailSent(order.id, 'delivered').then(first => {
      if (first) {
        const ratingLink = `https://shurget-5..app/rate/${order.id}`;
        sendDeliveredEmail(order, ratingLink).catch(err => {
          console.error('[email] Delivered email failed for order', req.params.id, err.message);
        });
      }
    }).catch(() => {});
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/:id/cancel-order — admin cancels order, triggers cancellation email.
 */
router.post('/:id/cancel-order', async (req, res, next) => {
  try {
    const order = await cancelOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    // Idempotent: send cancelled email only once
    markStatusEmailSent(order.id, 'cancelled').then(first => {
      if (first) sendCancelledEmail(order).catch(err => {
        console.error('[email] Cancelled email failed for order', req.params.id, err.message);
      });
    }).catch(() => {});
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) { next(err); }
});

/**
 * POST /api/orders/payment-failure — handle Stripe charge failure.
 * Body: { orderId, reason }
 */
router.post('/payment-failure', async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    sendPaymentFailureEmail(order, reason).catch(err => {
      console.error('[email] Payment failure email failed for order', orderId, err.message);
    });
    sendAdminPaymentFailureSms(orderId).catch(err => {
      console.error('[sms] Admin payment failure SMS failed for order', orderId, err.message);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[api/orders/payment-failure]', err);
    res.status(500).json({ error: 'Failed to send payment failure notification' });
  }
});

/**
 * POST /api/orders/:id/cancel
 * Customer-initiated cancel + refund.
 *   - status 'paid' (no driver yet)  → 100% refund
 *   - status 'assigned' (driver assigned, not en-route) → 50% refund + driver lost-time compensation
 *   - any other status → 400, direct customer to support
 * Public endpoint — access is gated by knowledge of the order id (same trust model as /track/:id).
 */
router.post('/:id/cancel', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

    const result = await cancelOrderByCustomer(orderId);
    if (!result) return res.status(404).json({ error: 'Order not found' });

    if (result.notCancellable) {
      return res.status(400).json({ error: 'Order cannot be cancelled at this stage. Contact support.' });
    }

    res.json({ success: true, refundAmount: result.refundAmount, message: result.message });
  } catch (err) {
    console.error('[cancel order]', err);
    res.status(500).json({ error: 'Cancel failed. Please try again.' });
  }
});

/**
 * POST /api/orders/:id/cancel-unprepared
 * Customer-initiated cancellation for a driver who arrived without proper
 * equipment (dollies, straps, moving blankets, etc).
 *   - Only allowed while status === 'assigned'.
 *   - Always a full refund (customer is not at fault).
 *   - Applies a $15 penalty against the driver (driver_adjustments) and
 *     increments their unprepared-cancellation strike counter; auto-flags
 *     the driver for equipment review at 3+ incidents.
 * Public endpoint — same trust model as /:id/cancel and /track/:id.
 */
router.post('/:id/cancel-unprepared', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

    const result = await cancelOrderUnprepared(orderId);
    if (!result) return res.status(404).json({ error: 'Order not found' });

    if (result.notCancellable) {
      return res.status(400).json({ error: 'Only assigned orders can use this cancellation.' });
    }

    res.json({ success: true, refundAmount: result.refundAmount, message: result.message });
  } catch (err) {
    console.error('[cancel-unprepared]', err);
    res.status(500).json({ error: 'Cancellation failed.' });
  }
});

module.exports = router;