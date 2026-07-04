// db/orders.js — Order CRUD, pricing, and payout tracking
// Owns: orders table reads/writes, price calculation, payout status/transfer logging.
// Does NOT own: Stripe API calls (services/stripe-connect.js), driver matching (services/driver.js).

const db = require('./index');

// Category base prices in dollars (matches booking form itemType categories)
const BASE_PRICES = {
  furniture:    89,
  mattress:     79,
  appliance:    119,
  building:     99,
  landscaping:  79,
  moving:       59,
  marketplace:  69,
  retail:       69,
  other:        59,
};

const FEE_RATE = 0.20;
const HELPER_PRICES = { 0: 0, 1: 25, 2: 45 };

/**
 * Calculate order pricing.
 * @param {string} itemType
 * @param {number} distanceMiles
 * @param {number} helpers
 * @param {number} [surgeMultiplier=1.00] - 1.25 = 25% surge
 * @param {string} [surgeLabel=null]      - shown to customer
 * @param {string} [applianceAddon='none'] - 'second_appliance' adds half base rate
 */
function calculatePrice(itemType, distanceMiles, helpers, surgeMultiplier, surgeLabel, applianceAddon) {
  if (helpers === undefined) helpers = 0;
  if (surgeMultiplier === undefined) surgeMultiplier = 1.00;
  if (applianceAddon === undefined) applianceAddon = 'none';
  const baseRate       = BASE_PRICES[itemType] ?? 59;
  const distanceCharge = Math.round(distanceMiles * 1.50 * 100) / 100;
  const helperFee      = HELPER_PRICES[helpers] ?? 0;
  // Second appliance add-on: half the appliance base rate ($119/2 = $59.50)
  const addonFee       = (itemType === 'appliance' && applianceAddon === 'second_appliance') ? 59.50 : 0;
  const subtotal       = baseRate + distanceCharge + helperFee + addonFee;
  const multiplier     = Math.max(1.00, Math.min(2.00, parseFloat(surgeMultiplier) || 1.00));
  const surgedSubtotal = Math.round(subtotal * multiplier * 100) / 100;
  const fee            = Math.round(surgedSubtotal * FEE_RATE * 100) / 100;
  return {
    priceBaseRate:    baseRate,
    priceDistance:    distanceCharge,
    priceHelpers:     helperFee,
    priceAddon:       addonFee,
    priceBase:        surgedSubtotal,
    priceSubtotalPre: Math.round(subtotal * 100) / 100,
    priceFee:         fee,
    priceTotal:       Math.round((surgedSubtotal + fee) * 100) / 100,
    surgeMultiplier:  multiplier,
    surgeLabel:       multiplier > 1.00 ? (surgeLabel || 'High Demand') : null,
    surgeApplied:     multiplier > 1.00,
  };
}

/** Insert a new order. Returns the created order row. */
async function createOrder(data) {
  let surgeMultiplier = 1.00;
  let surgeLabel = null;
  try {
    const { getSurgeConfig } = require('./surge');
    const surge = await getSurgeConfig();
    if (surge.active) { surgeMultiplier = surge.multiplier; surgeLabel = surge.label; }
  } catch (_) {}
  const pricing = calculatePrice(data.itemType, data.distanceMiles || 5, data.helpers || 0, surgeMultiplier, surgeLabel, data.applianceAddon || 'none');
  // Apply referral discount: reduce price_total by discount amount (floor at 0)
  const referralDiscount = data.referralDiscountCents || 0;
  const discountDollars  = referralDiscount / 100;
  const adjustedTotal    = Math.max(0, pricing.priceTotal - discountDollars);

  const sql = `
    INSERT INTO orders (
      item_type, pickup_address, pickup_lat, pickup_lng,
      dropoff_address, dropoff_lat, dropoff_lng,
      distance_miles, customer_name, customer_phone, customer_email,
      price_base, price_fee, price_total, status, eta_minutes,
      driver_name, driver_phone, driver_id,
      referral_code_used, referral_discount_cents, partner_slug,
      sms_consent,
      utm_source_first, utm_medium_first, utm_campaign_first,
      utm_source_last,  utm_medium_last,  utm_campaign_last,
      surge_multiplier, surge_label, tip_amount_cents
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
      $20, $21, $22, $23,
      $24, $25, $26, $27, $28, $29
    )
    RETURNING *
  `;
  const { rows } = await db.query(sql, [
    data.itemType,
    data.pickupAddress,
    data.pickupLat  || null,
    data.pickupLng  || null,
    data.dropoffAddress,
    data.dropoffLat || null,
    data.dropoffLng || null,
    data.distanceMiles || null,
    data.customerName  || null,
    data.customerPhone || null,
    data.customerEmail || null,
    pricing.priceBase,
    pricing.priceFee,
    adjustedTotal,
    data.status || 'pending',
    data.etaMinutes || null,
    data.driverName || null,
    data.driverPhone || null,
    data.driverId   || null,
    data.referralCodeUsed || null,
    referralDiscount,
    data.partnerSlug || null,
    data.smsConsent || false,
    data.utmSourceFirst   || null,
    data.utmMediumFirst   || null,
    data.utmCampaignFirst || null,
    data.utmSourceLast    || null,
    data.utmMediumLast    || null,
    data.utmCampaignLast  || null,
  ]);
  return rows[0];
}

/** Fetch order by id. */
async function getOrderById(id) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Fetch all orders for a customer email, ordered newest first. */
async function getOrdersByEmail(email) {
  const { rows } = await db.query(
    `SELECT id, item_type, pickup_address, dropoff_address, price_total,
            status, created_at, driver_name, eta_minutes
     FROM orders
     WHERE customer_email = $1
     ORDER BY created_at DESC`,
    [email]
  );
  return rows;
}

/** Set the Stripe session ID on an order (called after session created). */
async function setStripeSession(id, stripeSessionId) {
  const { rows } = await db.query(
    'UPDATE orders SET stripe_session_id = $2 WHERE id = $1 RETURNING *',
    [id, stripeSessionId]
  );
  return rows[0] || null;
}

/** Mark an order as paid (called after successful Stripe redirect). */
async function markOrderPaid(id, paidAt) {
  const { rows } = await db.query(
    'UPDATE orders SET status = $2, paid_at = $3 WHERE id = $1 RETURNING *',
    [id, 'paid', paidAt || new Date()]
  );
  return rows[0] || null;
}

/**
 * Idempotent webhook handler: insert the Stripe event, then update the order.
 * If the event_id is already in stripe_webhook_events, it's a duplicate — skip update.
 * This prevents double-charges and duplicate status updates.
 */
async function markOrderPaidFromWebhook(orderId, paidAt, eventId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: record event only if not already present
    if (eventId) {
      await client.query(
        `INSERT INTO stripe_webhook_events (event_id, event_type, order_id, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, 'checkout.session.completed', orderId, JSON.stringify({ paidAt })]
      );
    }

    // Update order only if still pending_payment
    const { rows } = await client.query(
      `UPDATE orders
         SET status = 'paid', paid_at = COALESCE($2, NOW())
         WHERE id = $1 AND status = 'pending_payment'
         RETURNING *`,
      [orderId, paidAt]
    );

    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Update order status and confirmed_at */
async function confirmOrder(id, status, extras) {
  const sql = `
    UPDATE orders
    SET status = $2, confirmed_at = NOW()
    ${extras.driverName    ? ', driver_name = $3' : ''}
    ${extras.driverPhone   ? ', driver_phone = $4' : ''}
    ${extras.etaMinutes    ? ', eta_minutes = $5' : ''}
    ${extras.status        ? ', status = $6' : ''}
    WHERE id = $1
    RETURNING *
  `;
  const params = [id, status];
  if (extras.driverName) params.push(extras.driverName);
  if (extras.driverPhone) params.push(extras.driverPhone);
  if (extras.etaMinutes) params.push(extras.etaMinutes);
  if (extras.status) params.push(extras.status);
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

/** Assign a driver to a paid order — dispatch step. */
async function dispatchOrder(id, driverName, driverPhone, etaMinutes, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
     SET driver_name = $2, driver_phone = $3, eta_minutes = $4, driver_id = $5, status = 'assigned'
     WHERE id = $1 AND status IN ('paid', 'assigned')
     RETURNING *`,
    [id, driverName, driverPhone, etaMinutes, driverId || null]
  );
  return rows[0] || null;
}

/** Mark order as delivered — completes the delivery loop. */
async function completeOrder(id) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'delivered' WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

/** Update driver location on an order. */
async function updateDriverLocation(id, lat, lng) {
  const { rows } = await db.query(
    `UPDATE orders
     SET driver_lat = $2, driver_lng = $3, driver_location_updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, lat, lng]
  );
  return rows[0] || null;
}

/**
 * Get paid orders not yet claimed by any driver — visible as available jobs.
 * Excludes jobs under an active claim hold by another driver.
 */
async function getAvailableJobs() {
  const { rows } = await db.query(
    `SELECT id, item_type, pickup_address, dropoff_address,
            distance_miles, price_total, customer_name, eta_minutes,
            created_at, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
            claim_hold_expires_at, claim_hold_driver_id
     FROM orders
     WHERE status = 'paid'
       AND driver_id IS NULL
       AND (driver_status IS NULL OR driver_status != 'declined')
       AND (claim_hold_expires_at IS NULL OR claim_hold_expires_at < NOW())
     ORDER BY price_total DESC`
  );
  return rows;
}

/**
 * Soft-claim a job for a driver (60-second hold window).
 * Race-safe: UPDATE ... WHERE ensures only one driver gets the hold at a time.
 * Returns the order row if claim succeeded, null if already held or taken.
 */
async function claimJob(orderId, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET claim_hold_driver_id  = $2,
            claim_hold_expires_at = NOW() + INTERVAL '60 seconds'
      WHERE id = $1
        AND status = 'paid'
        AND driver_id IS NULL
        AND (driver_status IS NULL OR driver_status != 'declined')
        AND (claim_hold_expires_at IS NULL OR claim_hold_expires_at < NOW())
      RETURNING *`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

/**
 * Confirm a claim: convert the soft hold into a permanent assignment.
 * Only succeeds if the hold is still owned by this driver and hasn't expired.
 */
async function confirmClaim(orderId, driverId, driverName, driverPhone) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_id            = $2,
            driver_status        = 'accepted',
            status               = 'assigned',
            driver_name          = $3,
            driver_phone         = $4,
            confirmed_at         = NOW(),
            claim_hold_driver_id  = NULL,
            claim_hold_expires_at = NULL
      WHERE id = $1
        AND status = 'paid'
        AND driver_id IS NULL
        AND claim_hold_driver_id = $2
        AND claim_hold_expires_at > NOW()
      RETURNING *`,
    [orderId, driverId, driverName, driverPhone]
  );
  return rows[0] || null;
}

/**
 * Release expired claim holds — returns jobs to pool.
 * Called opportunistically before listing available jobs.
 */
async function releaseExpiredClaims() {
  await db.query(
    `UPDATE orders
        SET claim_hold_driver_id  = NULL,
            claim_hold_expires_at = NULL
      WHERE status = 'paid'
        AND driver_id IS NULL
        AND claim_hold_expires_at IS NOT NULL
        AND claim_hold_expires_at < NOW()`
  );
}

/**
 * Mark a job as arrived at pickup location.
 */
async function markJobArrived(orderId, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_status = 'arrived'
      WHERE id = $1 AND driver_id = $2
        AND status = 'assigned'
      RETURNING *`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

/**
 * Mark a job as loaded (item on truck).
 */
async function markJobLoaded(orderId, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_status = 'loaded',
            status        = 'in_progress'
      WHERE id = $1 AND driver_id = $2
        AND status IN ('assigned', 'in_progress')
        AND driver_status IN ('arrived', 'en_route', 'loaded')
      RETURNING *`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

/**
 * Mark a job as delivered by the driver.
 * Sets status='delivered', driver_status='completed'.
 */
async function markJobDelivered(orderId, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET status        = 'delivered',
            driver_status = 'completed'
      WHERE id = $1 AND driver_id = $2
        AND status = 'in_progress'
      RETURNING *`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

/**
 * Accept a job — record the driver's ID and mark status as assigned.
 * Idempotent: re-accepting is a no-op if already accepted.
 */
async function acceptJob(orderId, driverId, driverName, driverPhone) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_id = $2,
            driver_status = 'accepted',
            status = 'assigned',
            driver_name = $3,
            driver_phone = $4,
            confirmed_at = NOW()
      WHERE id = $1
        AND status = 'paid'
        AND driver_id IS NULL
      RETURNING *`,
    [orderId, driverId, driverName, driverPhone]
  );
  return rows[0] || null;
}

/**
 * Decline a job — record the driver's ID as a soft decline (prevents re-offers).
 */
async function declineJob(orderId, driverId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_status = 'declined'
      WHERE id = $1
        AND status = 'paid'
        AND (driver_id IS NULL OR driver_id = $2)
      RETURNING *`,
    [orderId, driverId]
  );
  return rows[0] || null;
}

/**
 * Get orders assigned to a specific driver (active and completed).
 */
async function getMyJobs(driverId) {
  const { rows } = await db.query(
    `SELECT id, item_type, pickup_address, dropoff_address,
            distance_miles, price_total, customer_name, customer_phone,
            eta_minutes, status, created_at, confirmed_at,
            driver_lat, driver_lng, driver_location_updated_at,
            pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
     FROM orders
     WHERE driver_id = $1
       AND driver_status = 'accepted'
     ORDER BY
       CASE WHEN status = 'assigned' THEN 0 ELSE 1 END,
       confirmed_at DESC`,
    [driverId]
  );
  return rows;
}

/**
 * Get pending dispatches: paid orders with no driver assigned yet.
 * Returns the orders ready to be assigned to a driver.
 */
async function getPendingDispatches() {
  const { rows } = await db.query(
    `SELECT o.*,
            json_agg(oi.description) FILTER (WHERE oi.description IS NOT NULL) AS item_descriptions,
            json_agg(oi.length_in) FILTER (WHERE oi.length_in IS NOT NULL) AS item_lengths,
            json_agg(oi.width_in)  FILTER (WHERE oi.width_in IS NOT NULL)  AS item_widths,
            json_agg(oi.height_in) FILTER (WHERE oi.height_in IS NOT NULL) AS item_heights
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status = 'paid' AND o.driver_id IS NULL
     GROUP BY o.id
     ORDER BY o.created_at ASC`
  );
  return rows;
}

/**
 * Get active dispatches: in-progress orders with an assigned driver.
 */
async function getActiveDispatches() {
  const { rows } = await db.query(
    `SELECT o.*,
            json_agg(oi.description) FILTER (WHERE oi.description IS NOT NULL) AS item_descriptions
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status IN ('assigned', 'in_progress') AND o.driver_id IS NOT NULL
     GROUP BY o.id
     ORDER BY o.confirmed_at ASC`
  );
  return rows;
}

/**
 * Get recently completed orders (last 10 delivered/cancelled).
 */
async function getRecentCompleted(limit = 10) {
  const { rows } = await db.query(
    `SELECT o.*,
            json_agg(oi.description) FILTER (WHERE oi.description IS NOT NULL) AS item_descriptions
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status IN ('delivered', 'cancelled')
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Assign a driver to an order (admin dispatch action).
 * Sets driver info, status to 'assigned', and confirmed_at.
 */
async function assignDriverToOrder(orderId, driverId, driverName, driverPhone, etaMinutes = 15) {
  const { rows } = await db.query(
    `UPDATE orders
        SET driver_id = $2,
            driver_name = $3,
            driver_phone = $4,
            eta_minutes = $5,
            status = 'assigned',
            confirmed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [orderId, driverId, driverName, driverPhone, etaMinutes]
  );
  return rows[0] || null;
}

/**
 * Mark an order as delivered (admin dispatch action).
 */
async function markDelivered(orderId) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'delivered', driver_status = 'completed' WHERE id = $1 RETURNING *`,
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Cancel an order and issue a Stripe refund.
 *
 * Refund policy:
 *   - status 'paid' or 'assigned' (driver not yet en-route) → full refund
 *   - status 'in_progress' (driver already en-route / on-site) → no refund (platform
 *     has incurred driver cost) — admin must handle manually via Stripe dashboard
 *   - status 'delivered' → no refund
 *
 * Returns the updated order row including refund details.
 */
async function cancelOrder(orderId) {
  // Fetch the order first so we have stripe_session_id and current status
  const { rows: fetchRows } = await db.query(
    `SELECT * FROM orders WHERE id = $1`,
    [orderId]
  );
  const order = fetchRows[0];
  if (!order) return null;

  // Determine refund eligibility
  const refundableStatuses = ['paid', 'assigned'];
  const isRefundable = refundableStatuses.includes(order.status);

  let refundId       = null;
  let refundCents    = 0;
  let refundedAt     = null;

  if (isRefundable && order.stripe_session_id) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

      // Retrieve the checkout session to get the payment_intent
      const session = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
      const paymentIntentId = session.payment_intent;

      if (paymentIntentId) {
        // Issue full refund against the payment intent
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          reason: 'requested_by_customer',
          metadata: { order_id: String(orderId), cancelled_by: 'admin' },
        });
        refundId    = refund.id;
        refundCents = refund.amount;  // in cents
        refundedAt  = new Date();
        console.log(`[cancelOrder] Stripe refund ${refundId} issued for order ${orderId} — $${(refundCents/100).toFixed(2)}`);
      }
    } catch (stripeErr) {
      // Log but don't block the cancel — admin can process refund manually
      console.error(`[cancelOrder] Stripe refund failed for order ${orderId}:`, stripeErr.message);
    }
  }

  // Update order in DB regardless of refund outcome
  const { rows } = await db.query(
    `UPDATE orders
        SET status         = 'cancelled',
            driver_status  = NULL,
            stripe_refund_id    = $2,
            refund_amount_cents = $3,
            refunded_at         = $4
      WHERE id = $1
      RETURNING *`,
    [orderId, refundId, refundCents, refundedAt]
  );
  return rows[0] || null;
}

/**
 * Mark a job as in_progress — driver has left for pickup (en-route ping).
 */
async function markJobStarted(orderId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET status = 'in_progress', driver_status = 'en_route'
      WHERE id = $1 AND status = 'assigned'
      RETURNING *`,
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Get all-time aggregate order metrics.
 */
async function getMetrics() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [totals, week, month] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*)                                      AS total_orders,
        COALESCE(SUM(price_total), 0)                 AS total_revenue,
        COALESCE(AVG(price_total), 0)                 AS avg_order_value,
        COUNT(*) FILTER (WHERE status = 'delivered') AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
      FROM orders
    `),
    db.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(price_total), 0) AS revenue
      FROM orders
      WHERE created_at >= $1
    `, [weekAgo]),
    db.query(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(price_total), 0) AS revenue
      FROM orders
      WHERE created_at >= $1
    `, [monthAgo]),
  ]);

  return {
    totals: totals.rows[0],
    week:   week.rows[0],
    month:  month.rows[0],
  };
}

/**
 * Orders by status breakdown.
 */
async function getOrdersByStatus() {
  const { rows } = await db.query(`
    SELECT status, COUNT(*) AS cnt
    FROM orders
    GROUP BY status
    ORDER BY cnt DESC
  `);
  return rows;
}

/**
 * Orders by size tier based on item_type.
 * small: price_base < 50, medium: 50–69, large: 70+
 */
async function getOrdersBySizeTier() {
  const { rows } = await db.query(`
    SELECT
      CASE
        WHEN price_base < 50  THEN 'small'
        WHEN price_base < 70  THEN 'medium'
        ELSE 'large'
      END AS tier,
      COUNT(*) AS cnt
    FROM orders
    GROUP BY 1
    ORDER BY MIN(
      CASE WHEN price_base < 50  THEN 1
           WHEN price_base < 70  THEN 2
           ELSE 3 END
    )
  `);
  return rows;
}

/**
 * Daily order volume for the last 30 days.
 */
async function getDailyOrderVolume() {
  const { rows } = await db.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*)          AS orders
    FROM orders
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  return rows;
}

/**
 * Get all orders with optional status filter, sort, and pagination.
 * Used by /admin/bookings.
 */
async function getAllOrders({ status, sort = 'created_at', dir = 'desc', limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status && status !== 'all') {
    conditions.push(`o.status = $${params.push(status)}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : 'WHERE 1=1';

  const allowedSorts = { created_at: 'o.created_at', price_total: 'o.price_total', status: 'o.status' };
  const sortCol = allowedSorts[sort] || 'o.created_at';
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';

  const limitIdx = params.push(limit);
  const offsetIdx = params.push(offset);
  const { rows } = await db.query(`
    SELECT o.*,
           COALESCE(
             (SELECT json_agg(json_build_object(
               'description', oi.description,
               'quantity', oi.quantity,
               'length_in', oi.length_in,
               'width_in', oi.width_in,
               'height_in', oi.height_in
             )) FILTER (WHERE oi.description IS NOT NULL)
             FROM order_items oi WHERE oi.order_id = o.id),
             '[]'
           ) AS items
    FROM orders o
    ${where}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, params);
  return rows;
}

/** Count total orders for pagination. */
async function countOrders(status) {
  const params = [];
  const where = status && status !== 'all' ? `WHERE status = $${params.push(status)}` : 'WHERE 1=1';
  const { rows } = await db.query(`SELECT COUNT(*) AS total FROM orders ${where}`, params);
  return parseInt(rows[0].total, 10);
}

/**
 * Top 5 most common pickup → dropoff routes (city-level).
 */
async function getTopRoutes() {
  const { rows } = await db.query(`
    SELECT
      regexp_replace(
        regexp_replace(
          lower(trim(SPLIT_PART(pickup_address,  ',', 2))),
          '[^a-z ]', '', 'g'
        ),
        '^\\s+|\/s+$', '', 'g'
      ) AS pickup_city,
      regexp_replace(
        regexp_replace(
          lower(trim(SPLIT_PART(dropoff_address, ',', 2))),
          '[^a-z ]', '', 'g'
        ),
        '^\/s+|\/s+$', '', 'g'
      ) AS dropoff_city,
      COUNT(*) AS cnt,
      COALESCE(SUM(price_total), 0) AS total_revenue
    FROM orders
    WHERE pickup_address  IS NOT NULL
      AND dropoff_address IS NOT NULL
    GROUP BY pickup_city, dropoff_city
    ORDER BY cnt DESC
    LIMIT 5
  `);
  return rows;
}

/**
 * Record a successful payout transfer on an order.
 * Called after Stripe transfer succeeds; marks payout_status='paid'.
 */
async function savePayoutTransfer(orderId, transferId, amountCents) {
  const { rows } = await db.query(
    `UPDATE orders
       SET stripe_transfer_id = $2,
           payout_status = 'paid'
       WHERE id = $1
       RETURNING *`,
    [orderId, transferId]
  );
  return rows[0] || null;
}

/**
 * Flag an order whose payout transfer failed.
 * payout_status='failed' surfaces in admin so manual intervention is possible.
 */
async function markPayoutFailed(orderId) {
  const { rows } = await db.query(
    `UPDATE orders SET payout_status = 'failed' WHERE id = $1 RETURNING *`,
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Delivered orders for a specific driver, used by /driver/earnings.
 * Returns rows ordered newest-first, includes payout status and transfer ID.
 */
async function getPayoutsByDriver(driverId) {
  const { rows } = await db.query(
    `SELECT id, item_type, pickup_address, dropoff_address,
            price_total, price_base, price_fee,
            stripe_transfer_id, payout_status,
            created_at, paid_at
     FROM orders
     WHERE driver_id = $1
       AND status = 'delivered'
     ORDER BY created_at DESC`,
    [driverId]
  );
  return rows;
}

/**
 * Earnings summary for /driver/earnings page.
 * Returns lifetime total, this-week total, count of delivered jobs.
 */
async function getDriverEarningsSummary(driverId) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)                                              AS total_jobs,
       COALESCE(SUM(price_total * 0.85), 0)                 AS lifetime_earnings,
       COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days'
                         THEN price_total * 0.85 ELSE 0 END), 0) AS week_earnings,
       COALESCE(SUM(CASE WHEN payout_status = 'pending'
                         THEN price_total * 0.85 ELSE 0 END), 0) AS pending_earnings
     FROM orders
     WHERE driver_id = $1
       AND status = 'delivered'`,
    [driverId]
  );
  return rows[0];
}

/**
 * Schedule the post-delivery review email for +2hr after delivery.
 * Idempotent: only sets the field if it hasn't been set yet.
 */
async function scheduleReviewEmail(orderId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET scheduled_review_email_at = NOW() + INTERVAL '2 hours'
      WHERE id = $1
        AND scheduled_review_email_at IS NULL
      RETURNING *`,
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Find orders whose review email is due and not yet sent.
 * Returns up to 50 rows for the worker to process.
 */
async function getPendingReviewEmails(limit = 50) {
  const { rows } = await db.query(
    `SELECT o.*,
            da.name AS driver_first_name_full,
            da.email AS driver_email
     FROM orders o
     LEFT JOIN driver_applications da ON da.id = o.driver_id
     WHERE o.scheduled_review_email_at IS NOT NULL
       AND o.scheduled_review_email_at <= NOW()
       AND o.review_email_sent_at IS NULL
       AND o.status = 'delivered'
       AND o.customer_email IS NOT NULL
     ORDER BY o.scheduled_review_email_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Mark the review email as sent for an order (idempotency guard).
 */
async function markReviewEmailSent(orderId) {
  const { rows } = await db.query(
    `UPDATE orders
        SET review_email_sent_at = NOW()
      WHERE id = $1
        AND review_email_sent_at IS NULL
      RETURNING id`,
    [orderId]
  );
  return rows[0] || null;
}

/** Set the partner_slug on an order (called from embed deep-link flow). */
async function setPartnerSlug(id, partnerSlug) {
  const { rows } = await db.query(
    'UPDATE orders SET partner_slug = $2 WHERE id = $1 RETURNING *',
    [id, partnerSlug || null]
  );
  return rows[0] || null;
}

/**
 * Process an SMS opt-out (STOP reply).
 * Marks ALL orders with a matching customer_phone as unsubscribed.
 * Idempotent: re-calling is a no-op for already-unsubscribed numbers.
 */
async function updateUnsubscribeByPhone(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (!digits) return;
  const { rows } = await db.query(
    `UPDATE orders SET sms_unsubscribed = true
     WHERE customer_phone = $1 AND sms_unsubscribed = false
     RETURNING id`,
    [`+1${digits}`]
  );
  return rows.length;
}
async function getOrdersByPartner(partnerSlug) {
  const { rows } = await db.query(
    `SELECT o.*,
            p.commission_rate,
            ROUND(o.price_total_cents * 0.15 * p.commission_rate) AS partner_commission_cents
     FROM orders o
     LEFT JOIN partners p ON p.slug = o.partner_slug
     WHERE o.partner_slug = $1
     ORDER BY o.created_at DESC
     LIMIT 50`,
    [partnerSlug]
  );
  return rows;
}

/**
 * Mark a lifecycle email as sent for an order (idempotency guard).
 * key: one of 'driver_assigned' | 'en_route' | 'delivered' | 'cancelled' | 'payment_failed'
 * Returns true if this was the first time (i.e. the row was updated), false if already sent.
 */
async function markStatusEmailSent(orderId, key) {
  const { rows } = await db.query(
    `UPDATE orders
        SET status_emails_sent = status_emails_sent || $2::jsonb
      WHERE id = $1
        AND NOT (status_emails_sent ? $3)
      RETURNING id`,
    [orderId, JSON.stringify({ [key]: true }), key]
  );
  return rows.length > 0;
}

/**
 * Check whether a lifecycle email has already been sent for an order.
 * Returns true if already sent (caller should skip sending).
 */
async function wasStatusEmailSent(orderId, key) {
  const { rows } = await db.query(
    `SELECT (status_emails_sent ? $2) AS sent FROM orders WHERE id = $1`,
    [orderId, key]
  );
  return rows[0]?.sent === true;
}

/**
 * Attribution dashboard queries.
 * dateRange: '7d' | '30d' | 'all'
 */
function dateFilter(dateRange) {
  if (dateRange === '7d')  return `AND created_at >= NOW() - INTERVAL '7 days'`;
  if (dateRange === '30d') return `AND created_at >= NOW() - INTERVAL '30 days'`;
  return '';
}

async function getBookingsBySource(dateRange = 'all') {
  const df = dateFilter(dateRange);
  const { rows } = await db.query(`
    SELECT
      COALESCE(utm_source_last, utm_source_first, 'direct') AS source,
      COALESCE(utm_medium_last, utm_medium_first, '(none)') AS medium,
      COALESCE(utm_campaign_last, utm_campaign_first, '(none)') AS campaign,
      COUNT(*)::int                         AS bookings,
      SUM(price_total)::numeric             AS gross_revenue,
      SUM(price_fee)::numeric               AS net_fee,
      ROUND(AVG(price_total)::numeric, 2)   AS avg_order_value
    FROM orders
    WHERE status NOT IN ('pending_payment', 'cancelled') ${df}
    GROUP BY 1, 2, 3
    ORDER BY bookings DESC
    LIMIT 100
  `);
  return rows;
}

async function getDriverSignupsBySource(dateRange = 'all') {
  const df = dateFilter(dateRange);
  const { rows } = await db.query(`
    SELECT
      COALESCE(utm_source, 'direct')   AS source,
      COALESCE(utm_medium, '(none)')   AS medium,
      COALESCE(utm_campaign, '(none)') AS campaign,
      COUNT(*)::int AS signups
    FROM driver_applications
    WHERE 1=1 ${df.replace('created_at', 'created_at')}
    GROUP BY 1, 2, 3
    ORDER BY signups DESC
    LIMIT 100
  `);
  return rows;
}

async function getReferralFunnel(dateRange = 'all') {
  // Codes issued, first-time redemptions, and paid (delivered) orders using a code
  const df = dateFilter(dateRange);
  const { rows } = await db.query(`
    SELECT
      rc.code,
      rc.owner_email,
      rc.uses_count AS redemptions,
      COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered') AS paid_orders,
      SUM(o.referral_discount_cents) FILTER (WHERE o.status = 'delivered') AS discount_paid_cents
    FROM referral_codes rc
    LEFT JOIN referral_redemptions rr ON rr.code_id = rc.id
    LEFT JOIN orders o ON o.id = rr.order_id ${df.replace('AND created_at', 'AND rc.created_at')}
    GROUP BY rc.code, rc.owner_email, rc.uses_count
    ORDER BY redemptions DESC NULLS LAST
    LIMIT 100
  `);
  return rows;
}


/**
 * Add a tip to a delivered order (one-time, cannot overwrite existing tip).
 * tipAmountDollars: number (e.g. 5, 10, 15, 20)
 */
async function addTipToOrder(orderId, tipAmountDollars) {
  const tipCents = Math.round(Math.max(0, parseFloat(tipAmountDollars) || 0) * 100);
  const { rows } = await db.query(
    `UPDATE orders
       SET tip_amount_cents = $2, updated_at = NOW()
     WHERE id = $1
       AND status IN ('delivered', 'paid', 'confirmed')
       AND (tip_amount_cents IS NULL OR tip_amount_cents = 0)
     RETURNING *`,
    [orderId, tipCents]
  );
  return rows[0] || null;
}

function tipDollars(order) {
  return ((order.tip_amount_cents || 0) / 100).toFixed(2);
}

module.exports = {
  BASE_PRICES,
  calculatePrice,
  createOrder,
  getOrderById,
  getOrdersByEmail,
  confirmOrder,
  setStripeSession,
  markOrderPaid,
  markOrderPaidFromWebhook,
  dispatchOrder,
  completeOrder,
  updateDriverLocation,
  getAvailableJobs,
  claimJob,
  confirmClaim,
  releaseExpiredClaims,
  markJobArrived,
  markJobLoaded,
  markJobDelivered,
  acceptJob,
  declineJob,
  getMyJobs,
  getPendingDispatches,
  getActiveDispatches,
  getRecentCompleted,
  assignDriverToOrder,
  markDelivered,
  cancelOrder,
  markJobStarted,
  getMetrics,
  getOrdersByStatus,
  getOrdersBySizeTier,
  getDailyOrderVolume,
  getTopRoutes,
  getAllOrders,
  countOrders,
  setPartnerSlug,
  getOrdersByPartner,
  updateUnsubscribeByPhone,
  savePayoutTransfer,
  markPayoutFailed,
  getPayoutsByDriver,
  getDriverEarningsSummary,
  scheduleReviewEmail,
  getPendingReviewEmails,
  markReviewEmailSent,
  markStatusEmailSent,
  wasStatusEmailSent,
  getBookingsBySource,
  getDriverSignupsBySource,
  getReferralFunnel,
};