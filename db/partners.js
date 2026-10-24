// db/partners.js — Partner onboarding and management
// Owns: partner_applications + partners tables
// Does NOT own: email sending, Stripe Connect (services handle those)

const db = require('./index');

// ─── Applications ────────────────────────────────────────────────────────────

/** Save a new partner application (from /partners/apply). */
async function createPartnerApplication(data) {
  const { rows } = await db.query(
    `INSERT INTO partner_applications
       (store_name, website_url, contact_name, contact_email, contact_phone,
        monthly_volume, zip_codes_served, item_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.storeName      || '',
      data.websiteUrl     || '',
      data.contactName    || '',
      data.contactEmail   || '',
      data.contactPhone   || '',
      data.monthlyVolume  || '',
      data.zipCodesServed|| '',
      data.itemDescription|| '',
    ]
  );
  return rows[0];
}

/** Get all pending partner applications for admin review. */
async function getPendingApplications() {
  const { rows } = await db.query(
    `SELECT * FROM partner_applications
     WHERE status = 'pending'
     ORDER BY created_at DESC`
  );
  return rows;
}

/** Get all partner applications (for admin list). */
async function getAllApplications() {
  const { rows } = await db.query(
    `SELECT * FROM partner_applications ORDER BY created_at DESC`
  );
  return rows;
}

/** Update application status (approve or reject). */
async function updateApplicationStatus(id, status, reviewedBy) {
  const { rows } = await db.query(
    `UPDATE partner_applications
     SET status = $1, reviewed_at = NOW(), reviewed_by = $2
     WHERE id = $3
     RETURNING *`,
    [status, reviewedBy || '', id]
  );
  return rows[0] || null;
}

// ─── Active Partners ─────────────────────────────────────────────────────────

/** Create an approved partner and generate slug from store name. */
async function createPartner(data) {
  // Generate slug: lowercase, spaces→hyphens, strip non-alphanumeric
  const baseSlug = (data.storeName || 'partner')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Ensure uniqueness: append -1, -2, etc. if slug taken
  const { rows: existing } = await db.query(
    `SELECT slug FROM partners WHERE slug LIKE $1 || '%' ORDER BY slug`,
    [baseSlug]
  );
  let slug = baseSlug;
  if (existing.length > 0) {
    const taken = new Set(existing.map(r => r.slug));
    let i = 1;
    while (taken.has(slug)) { slug = baseSlug + '-' + i++; }
  }

  const { rows } = await db.query(
    `INSERT INTO partners
       (slug, store_name, website_url, contact_email, commission_rate)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      slug,
      data.storeName   || '',
      data.websiteUrl  || '',
      data.contactEmail|| '',
      data.commissionRate || 0.100,
    ]
  );
  return rows[0];
}

/** Get partner by slug. */
async function getPartnerBySlug(slug) {
  const { rows } = await db.query(
    `SELECT * FROM partners WHERE slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

/** Get partner by Stripe account ID (for webhook idempotency). */
async function getPartnerByStripeAccount(stripeAccountId) {
  const { rows } = await db.query(
    `SELECT * FROM partners WHERE stripe_account_id = $1`,
    [stripeAccountId]
  );
  return rows[0] || null;
}

/** Update partner Stripe Connect account. */
async function updatePartnerStripeAccount(partnerId, stripeAccountId) {
  await db.query(
    `UPDATE partners SET stripe_account_id = $1, updated_at = NOW() WHERE id = $2`,
    [stripeAccountId, partnerId]
  );
}

/** Add commission to a partner's balance (called when a widget order is delivered). */
async function addCommission(partnerId, cents) {
  await db.query(
    `UPDATE partners SET commission_balance_cents = commission_balance_cents + $1, updated_at = NOW() WHERE id = $2`,
    [cents, partnerId]
  );
}

/** Deduct commission (on payout). */
async function deductCommission(partnerId, cents) {
  await db.query(
    `UPDATE partners SET
       commission_balance_cents = GREATEST(0, commission_balance_cents - $1),
       last_payout_amount_cents = $1,
       last_payout_at = NOW(),
       updated_at = NOW()
     WHERE id = $2`,
    [cents, partnerId]
  );
}

/** Get all partners (for admin). */
async function getAllPartners() {
  const { rows } = await db.query(
    `SELECT * FROM partners ORDER BY created_at DESC`
  );
  return rows;
}

/** Get partner orders summary (total bookings, total revenue, commission earned). */
async function getPartnerStats(partnerSlug) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('paid', 'dispatched', 'in_progress', 'delivered')) AS total_bookings,
       COALESCE(SUM(price_total * 100) FILTER (WHERE status IN ('paid', 'dispatched', 'in_progress', 'delivered')), 0) AS total_revenue_cents,
       COALESCE(SUM(price_total * 100) FILTER (WHERE status IN ('paid', 'dispatched', 'in_progress', 'delivered')), 0) * 0.15 * MAX(p.commission_rate) AS commission_earned_cents
     FROM orders o
     JOIN partners p ON p.slug = $1
     WHERE o.partner_slug = $1`,
    [partnerSlug]
  );
  return rows[0] || { total_bookings: 0, total_revenue_cents: 0, commission_earned_cents: 0 };
}

module.exports = {
  createPartnerApplication,
  getPendingApplications,
  getAllApplications,
  updateApplicationStatus,
  createPartner,
  getPartnerBySlug,
  getPartnerByStripeAccount,
  updatePartnerStripeAccount,
  addCommission,
  deductCommission,
  getAllPartners,
  getPartnerStats,
};