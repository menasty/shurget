// db/drivers.js — Driver application CRUD, Stripe Connect, and driver referral management
// Owns: driver_applications table reads/writes, stripe_account_id + referral_code persistence.
// Does NOT own: Stripe API calls (services/stripe-connect.js), order matching (services/driver.js).

const db = require('./index');

/** Insert a driver application with all onboarding fields. Returns the created row. */
async function createDriverApplication(data) {
  const sql = `
    INSERT INTO driver_applications
      (name, email, phone, vehicle_type, city,
       vehicle_insurance_doc, driver_license_doc, vehicle_registration_doc,
       background_check_consent, referred_by_driver_id, referred_by_driver_name,
       utm_source, utm_medium, utm_campaign)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `;
  const { rows } = await db.query(sql, [
    data.name,
    data.email,
    data.phone,
    data.vehicleType,
    data.city,
    data.vehicleInsuranceDoc     || null,
    data.driverLicenseDoc         || null,
    data.vehicleRegistrationDoc   || null,
    data.backgroundCheckConsent   || false,
    data.referredByDriverId       || null,
    data.referredByDriverName     || null,
    data.utmSource   || null,
    data.utmMedium   || null,
    data.utmCampaign || null,
  ]);
  return rows[0];
}

/** Get application status by email — used for the onboarding status screen. */
async function getDriverApplicationByEmail(email) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, phone, vehicle_type, city,
              status, background_check_consent,
              vehicle_insurance_doc, driver_license_doc, vehicle_registration_doc,
              created_at, reviewed_at
       FROM driver_applications
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === '42703') {
      const { rows } = await db.query(
        `SELECT id, name, email, phone, vehicle_type, city,
                status, background_check_consent,
                vehicle_insurance_doc, driver_license_doc, vehicle_registration_doc,
                created_at, NULL::timestamptz AS reviewed_at
         FROM driver_applications
         WHERE email = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [email]
      );
      return rows[0] || null;
    }
    throw err;
  }
}

/** Fetch an approved driver by email — used for the driver jobs portal. */
async function getDriverByEmail(email) {
  const { rows } = await db.query(
    `SELECT * FROM driver_applications
     WHERE email = $1 AND status = 'active'
     LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/** List all applications, newest first, with referrer name (denormalized at submission time). */
async function getDriverApplications(filters = {}) {
  let sql = `
    SELECT d.*
    FROM driver_applications d
    WHERE 1=1
  `;
  const params = [];
  if (filters.status) {
    params.push(filters.status);
    sql += ` AND d.status = $${params.length}`;
  }
  if (filters.city) {
    params.push(filters.city);
    sql += ` AND d.city ILIKE $${params.length}`;
  }
  sql += ' ORDER BY d.created_at DESC';
  if (filters.limit) {
    params.push(filters.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await db.query(sql, params);
  return rows;
}

/** Activate a driver so they appear in the matching pool, and auto-assign a referral code. */
async function activateDriver(id) {
  let driver;
  try {
    const { rows } = await db.query(
      `UPDATE driver_applications
         SET status = 'active', reviewed_at = NOW()
         WHERE id = $1
         RETURNING *`,
      [id]
    );
    driver = rows[0] || null;
  } catch (err) {
    if (!(err && err.code === '42703')) {
      throw err;
    }

    const { rows } = await db.query(
      `UPDATE driver_applications
         SET status = 'active'
         WHERE id = $1
         RETURNING *`,
      [id]
    );
    driver = rows[0] || null;
  }

  // Auto-assign referral code on activation if not already set
  if (driver && !driver.referral_code) {
    return assignReferralCode(id);
  }
  return driver;
}

/** Fetch all active drivers (in the matching pool). Returns {id, name, email, phone, vehicle_type, city}. */
async function getActiveDrivers() {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, phone, vehicle_type, city
       FROM driver_applications
       WHERE status = 'active'
         AND is_online = TRUE
       ORDER BY reviewed_at DESC, created_at ASC`
    );
    return rows;
  } catch (err) {
    if (err && err.code === '42703') {
      // is_online column not present yet (pre-migration) — fall back to all active drivers
      const { rows } = await db.query(
        `SELECT id, name, email, phone, vehicle_type, city
         FROM driver_applications
         WHERE status = 'active'
         ORDER BY created_at ASC`
      );
      return rows;
    }
    throw err;
  }
}

/** Insert a test/production driver with docs and mark them active. Returns the created row. */
async function createTestDriver(data) {
  const sql = `
    INSERT INTO driver_applications
      (name, email, phone, vehicle_type, city, status,
       vehicle_insurance_doc, driver_license_doc, vehicle_registration_doc)
    VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
    RETURNING *
  `;
  const { rows } = await db.query(sql, [
    data.name,
    data.email,
    data.phone,
    data.vehicleType,
    data.city,
    data.vehicleInsuranceDoc,
    data.driverLicenseDoc,
    data.vehicleRegistrationDoc,
  ]);
  return rows[0];
}

/** Fetch a single driver application by numeric ID. */
async function getDriverById(id) {
  const { rows } = await db.query(
    'SELECT * FROM driver_applications WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

/** Persist the Stripe Connect account ID onto the driver's record. */
async function saveStripeAccountId(driverId, stripeAccountId) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET stripe_account_id = $2
       WHERE id = $1
       RETURNING *`,
    [driverId, stripeAccountId]
  );
  return rows[0] || null;
}

/** Generate and save a referral code for a driver when they are activated. */
async function assignReferralCode(driverId) {
  // Unique 8-char alphanumeric code prefixed with 'DRV' to distinguish driver codes
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  let attempts = 0;
  while (attempts < 10) {
    code = 'DRV' + Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const { rows } = await db.query(
      'UPDATE driver_applications SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL RETURNING *',
      [driverId, code]
    );
    if (rows[0]) return rows[0];
    attempts++;
  }
  // Code already exists — return current record
  return getDriverById(driverId);
}

/** Look up an active driver by their referral code. Used on /drive wizard to pre-fill referrer. */
async function getDriverByReferralCode(code) {
  const { rows } = await db.query(
    `SELECT id, name, email, referral_code FROM driver_applications
     WHERE referral_code = $1 AND status = 'active'
     LIMIT 1`,
    [code]
  );
  return rows[0] || null;
}

/**
 * Count completed deliveries for a referred driver.
 * Used to check 3-haul threshold before paying out bounty.
 */
async function countDeliveredOrdersForDriver(driverId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM orders
     WHERE driver_id = $1 AND status = 'delivered'`,
    [driverId]
  );
  return parseInt(rows[0].cnt, 10);
}

/**
 * Record a $50 driver-to-driver referral bounty transfer.
 * Idempotent: only updates if referral_bounty_paid_at is still NULL.
 * Returns the updated row, or null if already paid (idempotency guard).
 */
async function recordReferralBounty(referredDriverId, transferId) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET referral_bounty_paid_at = NOW(),
           referral_bounty_transfer_id = $2
     WHERE id = $1 AND referral_bounty_paid_at IS NULL
     RETURNING *`,
    [referredDriverId, transferId]
  );
  return rows[0] || null;
}

/**
 * Update background check status from admin panel.
 * Status values: 'pending' | 'cleared' | 'failed'.
 */
async function updateBackgroundCheckStatus(driverId, status) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET background_check_status = $2
     WHERE id = $1
     RETURNING *`,
    [driverId, status]
  );
  return rows[0] || null;
}


/**
 * Record an electronic signature for the driver agreement.
 * Idempotent: will not overwrite an existing signature.
 */
async function recordAgreementSignature(driverId, signatureName, ipAddress) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET agreement_signed_at  = NOW(),
           agreement_signature  = $2,
           agreement_ip         = $3,
           agreement_version    = '1.0'
     WHERE id = $1
       AND agreement_signed_at IS NULL
     RETURNING *`,
    [driverId, signatureName, ipAddress]
  );
  return rows[0] || null;
}

/**
 * Record that a driver paid for their background check upfront.
 * Stores the amount they paid and when, so we can reimburse exactly what they spent (capped at $85).
 */
async function recordBgCheckPayment(driverId, amountCents) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET bgcheck_fee_paid_cents = $2,
           bgcheck_fee_paid_at    = NOW()
     WHERE id = $1
     RETURNING *`,
    [driverId, amountCents]
  );
  return rows[0] || null;
}

/**
 * Check whether a driver is eligible for background check reimbursement.
 * Eligible = passed bgcheck, completed >= 5 delivered orders, not yet reimbursed.
 * Returns { eligible: bool, completedOrders: number, reimbursementCents: number }
 */
async function getBgCheckReimbursementEligibility(driverId) {
  const MAX_REIMBURSEMENT_CENTS = 8500; // $85.00 cap

  const { rows: driverRows } = await db.query(
    `SELECT id, status, bgcheck_fee_paid_cents, bgcheck_fee_paid_at,
            bgcheck_reimbursed_at, bgcheck_reimbursement_transfer_id,
            background_check_status
     FROM driver_applications WHERE id = $1 LIMIT 1`,
    [driverId]
  );
  const driver = driverRows[0];
  if (!driver) return { eligible: false, reason: 'driver_not_found' };

  // Already reimbursed
  if (driver.bgcheck_reimbursed_at) {
    return { eligible: false, reason: 'already_reimbursed', reimbursedAt: driver.bgcheck_reimbursed_at };
  }
  // No fee on record
  if (!driver.bgcheck_fee_paid_cents) {
    return { eligible: false, reason: 'no_fee_recorded' };
  }
  // Must have passed
  if (driver.background_check_status !== 'cleared') {
    return { eligible: false, reason: 'check_not_cleared', status: driver.background_check_status };
  }

  const { rows: orderRows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM orders WHERE driver_id = $1 AND status = 'delivered'`,
    [driverId]
  );
  const completedOrders = parseInt(orderRows[0].cnt, 10);

  if (completedOrders < 5) {
    return {
      eligible: false,
      reason: 'threshold_not_met',
      completedOrders,
      remaining: 5 - completedOrders,
    };
  }

  const reimbursementCents = Math.min(driver.bgcheck_fee_paid_cents, MAX_REIMBURSEMENT_CENTS);
  return {
    eligible: true,
    completedOrders,
    reimbursementCents,
    feePaidCents: driver.bgcheck_fee_paid_cents,
  };
}

/**
 * Mark a background check reimbursement as paid.
 * Idempotent — will not overwrite an existing reimbursement record.
 * transferId is the Stripe transfer/payout ID for auditing.
 */
async function recordBgCheckReimbursement(driverId, transferId, amountCents) {
  const { rows } = await db.query(
    `UPDATE driver_applications
       SET bgcheck_reimbursed_at                = NOW(),
           bgcheck_reimbursement_transfer_id    = $2,
           bgcheck_reimbursement_amount_cents   = $3
     WHERE id = $1
       AND bgcheck_reimbursed_at IS NULL
     RETURNING *`,
    [driverId, transferId, amountCents]
  );
  return rows[0] || null;
}

/**
 * Fetch all active drivers who are eligible for bgcheck reimbursement.
 * Called by the weekly payout job to batch-process reimbursement credits.
 * Returns drivers with 5+ deliveries, cleared bgcheck, unpaid reimbursement, fee on record.
 */
async function getDriversDueForBgCheckReimbursement() {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.email, d.stripe_account_id,
            d.bgcheck_fee_paid_cents,
            LEAST(d.bgcheck_fee_paid_cents, 8500) AS reimbursement_cents,
            COUNT(o.id) AS delivered_count
     FROM driver_applications d
     JOIN orders o ON o.driver_id = d.id AND o.status = 'delivered'
     WHERE d.status = 'active'
       AND d.background_check_status = 'cleared'
       AND d.bgcheck_fee_paid_cents IS NOT NULL
       AND d.bgcheck_reimbursed_at IS NULL
       AND d.stripe_account_id IS NOT NULL
     GROUP BY d.id
     HAVING COUNT(o.id) >= 5
     ORDER BY d.reviewed_at ASC`
  );
  return rows;
}


module.exports = {
  createDriverApplication,
  getDriverApplicationByEmail,
  getDriverApplications,
  getDriverByEmail,
  getDriverById,
  activateDriver,
  getActiveDrivers,
  createTestDriver,
  saveStripeAccountId,
  assignReferralCode,
  getDriverByReferralCode,
  countDeliveredOrdersForDriver,
  recordReferralBounty,
  updateBackgroundCheckStatus,
  recordAgreementSignature,
  recordBgCheckPayment,
  getBgCheckReimbursementEligibility,
  recordBgCheckReimbursement,
  getDriversDueForBgCheckReimbursement,
};