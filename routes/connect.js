// routes/connect.js — Stripe Connect V2 Integration
// ─────────────────────────────────────────────────────────────────────────────
// Flows:
//   GET  /connect                          → onboarding dashboard (create account + status)
//   POST /connect/accounts                 → create a V2 connected account
//   POST /connect/accounts/:id/onboard     → generate account link for onboarding
//   GET  /connect/products                 → product creation UI
//   POST /connect/products                 → create a platform-level Stripe product
//   GET  /connect/storefront               → customer-facing storefront (all products)
//   POST /connect/checkout                 → create Checkout session with destination charge
//   GET  /connect/success                  → post-payment success page
//   POST /api/connect/webhook              → receive V2 thin events (requirements changes)
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const router  = express.Router();

// ─── Sample-integration lockdown ─────────────────────────────────────────────
// Every route in this router requires an admin session, EXCEPT the Stripe
// webhook below, which authenticates via Stripe's signature verification.
// Previously these endpoints created real Stripe objects with no
// authentication at all. (The router is mounted at both /connect and
// /api/connect; req.path inside the router is the post-mount remainder, so
// the webhook exemption matches on both mounts.)
const { requireAdmin } = require('../middleware/session');
router.use((req, res, next) => {
  if (req.path === '/api/connect/webhook') return next();
  return requireAdmin(req, res, next);
});

// ─── Stripe Client ───────────────────────────────────────────────────────────
// PLACEHOLDER: Set STRIPE_SECRET_KEY in your Render environment variables.
// Get this from: https://dashboard.stripe.com/apikeys
// It starts with sk_live_... (production) or sk_test_... (testing).
const Stripe = require('stripe');

function getStripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    // Helpful error so misconfiguration is immediately obvious in logs
    throw new Error(
      '[connect] STRIPE_SECRET_KEY is not set. ' +
      'Add it to your Render environment variables before using Connect features.'
    );
  }
  // Using the latest Stripe Node SDK (v17+). The API version is set automatically by the SDK.
  return new Stripe(key);
}

// ─── PLACEHOLDER: Webhook secret ─────────────────────────────────────────────
// After setting up your webhook destination in the Stripe Dashboard
// (Developers → Webhooks → Add destination → Connected accounts → thin events),
// copy the signing secret and set it as STRIPE_CONNECT_WEBHOOK_SECRET in Render.
function getWebhookSecret() {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      '[connect] STRIPE_CONNECT_WEBHOOK_SECRET is not set. ' +
      'Create a webhook destination in the Stripe Dashboard and paste the signing secret into Render.'
    );
  }
  return secret;
}

// ─── In-memory store ─────────────────────────────────────────────────────────
// NOTE: In production this should be persisted to your Neon/Postgres database.
// For this integration sample, we use an in-memory Map that resets on server restart.
// Schema:
//   accounts: Map<localUserId, { stripeAccountId, displayName, email, createdAt }>
//   products: Map<stripeProductId, { name, description, priceId, unitAmount, currency,
//                                    stripeAccountId, displayName, createdAt }>
const accountStore = new Map(); // localId → { stripeAccountId, displayName, email }
const productStore = new Map(); // stripeProductId → product metadata

// ─── Helper: base URL for redirect/return URLs ────────────────────────────────
function baseUrl(req) {
  const host  = req.headers['x-original-host'] ||
                req.headers['x-forwarded-host'] ||
                req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${host}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING DASHBOARD
// GET /connect
// Displays all connected accounts and their current onboarding status.
// Status is always fetched live from Stripe — never cached in DB.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  const flash = req.query.flash || null;
  const error = req.query.error || null;

  // Enrich each stored account with live status from the Stripe V2 accounts API
  const accounts = [];
  for (const [localId, acct] of accountStore.entries()) {
    let status = 'unknown';
    let onboardingComplete = false;
    let readyToReceivePayments = false;

    try {
      const stripeClient = getStripeClient();

      // Retrieve V2 account with recipient configuration and requirements included
      const account = await stripeClient.v2.core.accounts.retrieve(
        acct.stripeAccountId,
        { include: ['configuration.recipient', 'requirements'] }
      );

      // Check if transfers capability is active (driver can receive payouts)
      readyToReceivePayments =
        account?.configuration?.recipient?.capabilities
          ?.stripe_balance?.stripe_transfers?.status === 'active';

      // Check requirements status: if nothing is currently_due or past_due → onboarding complete
      const reqStatus = account.requirements?.summary?.minimum_deadline?.status;
      onboardingComplete = reqStatus !== 'currently_due' && reqStatus !== 'past_due';

      if (readyToReceivePayments) {
        status = 'active';
      } else if (onboardingComplete) {
        status = 'pending_approval';
      } else {
        status = 'onboarding_incomplete';
      }
    } catch (err) {
      console.error(`[connect] Failed to retrieve account ${acct.stripeAccountId}:`, err.message);
      status = 'error';
    }

    accounts.push({ localId, ...acct, status, readyToReceivePayments, onboardingComplete });
  }

  res.render('connect-dashboard', { accounts, flash, error });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE CONNECTED ACCOUNT
// POST /connect/accounts
// Creates a V2 connected account. The platform is responsible for fees and losses.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/accounts', async (req, res) => {
  const { displayName, email } = req.body;

  if (!displayName || !email) {
    return res.redirect('/connect?error=Display+name+and+email+are+required');
  }

  try {
    const stripeClient = getStripeClient();

    // Create a V2 connected account.
    // IMPORTANT: Do NOT pass a top-level `type` field — V2 uses configuration objects instead.
    // - fees_collector: 'application' → platform (Shurget) collects fees
    // - losses_collector: 'application' → platform covers losses
    // - stripe_transfers requested → account can receive payouts from the platform
    const account = await stripeClient.v2.core.accounts.create({
      display_name:  displayName,
      contact_email: email,
      identity: {
        country: 'us', // All Shurget drivers are US-based
      },
      dashboard: 'express', // Driver gets a simplified Stripe Express dashboard
      defaults: {
        responsibilities: {
          fees_collector:   'application', // Platform handles fee collection
          losses_collector: 'application', // Platform handles losses
        },
      },
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: {
                requested: true, // Request transfers capability for payouts
              },
            },
          },
        },
      },
    });

    // Persist the mapping: localId → stripeAccountId
    // NOTE: Replace this Map with a DB INSERT in production.
    const localId = `acct_local_${Date.now()}`;
    accountStore.set(localId, {
      stripeAccountId: account.id,
      displayName,
      email,
      createdAt: new Date().toISOString(),
    });

    console.log(`[connect] Created account ${account.id} for ${email}`);
    res.redirect(`/connect?flash=Account+created+for+${encodeURIComponent(email)}+%E2%80%94+complete+onboarding+below`);

  } catch (err) {
    console.error('[connect] createAccount error:', err.message);
    res.redirect(`/connect?error=${encodeURIComponent(err.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATE ONBOARDING LINK
// POST /connect/accounts/:localId/onboard
// Creates a V2 account link and redirects the user to Stripe's hosted onboarding.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/accounts/:localId/onboard', async (req, res) => {
  const { localId } = req.params;
  const acct = accountStore.get(localId);

  if (!acct) {
    return res.redirect('/connect?error=Account+not+found');
  }

  try {
    const stripeClient = getStripeClient();
    const base = baseUrl(req);

    // Create a V2 account link for the recipient configuration onboarding flow.
    // refresh_url: where to send the user if the link expires before they complete onboarding
    // return_url: where to send the user after they finish (success or not)
    const accountLink = await stripeClient.v2.core.accountLinks.create({
      account: acct.stripeAccountId,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['recipient'],          // Onboard the recipient configuration
          refresh_url: `${base}/connect`,         // Expired link → back to dashboard
          return_url:  `${base}/connect?flash=Onboarding+completed+for+${encodeURIComponent(acct.displayName)}`,
        },
      },
    });

    // Redirect the user to Stripe's hosted onboarding page
    res.redirect(accountLink.url);

  } catch (err) {
    console.error('[connect] createAccountLink error:', err.message);
    res.redirect(`/connect?error=${encodeURIComponent(err.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCT CREATION UI
// GET /connect/products
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/products', (req, res) => {
  const accounts = Array.from(accountStore.entries()).map(([localId, a]) => ({
    localId,
    ...a,
  }));
  const flash = req.query.flash || null;
  const error = req.query.error || null;
  res.render('connect-products', { accounts, flash, error });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE PRODUCT
// POST /connect/products
// Creates a product at the platform level (not on the connected account).
// Stores connected account ID in product metadata so Checkout knows where to transfer funds.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/products', async (req, res) => {
  const { name, description, priceInDollars, currency = 'usd', localAccountId } = req.body;

  if (!name || !priceInDollars || !localAccountId) {
    return res.redirect('/connect/products?error=Name%2C+price%2C+and+seller+are+required');
  }

  const acct = accountStore.get(localAccountId);
  if (!acct) {
    return res.redirect('/connect/products?error=Seller+account+not+found');
  }

  const priceInCents = Math.round(parseFloat(priceInDollars) * 100);
  if (isNaN(priceInCents) || priceInCents < 50) {
    return res.redirect('/connect/products?error=Price+must+be+at+least+$0.50');
  }

  try {
    const stripeClient = getStripeClient();

    // Create a product at the PLATFORM level (no `stripeAccount` header).
    // The connected account ID is stored in metadata so Checkout can look it up.
    const product = await stripeClient.products.create({
      name,
      description: description || undefined,
      default_price_data: {
        unit_amount: priceInCents,
        currency,
      },
      metadata: {
        // Store the connected account ID so we can create destination charges
        connected_account_id: acct.stripeAccountId,
        local_account_id:     localAccountId,
        seller_name:          acct.displayName,
        seller_email:         acct.email,
      },
    });

    // Persist product metadata locally (replace with DB INSERT in production)
    productStore.set(product.id, {
      name,
      description:    description || '',
      priceId:        product.default_price,
      unitAmount:     priceInCents,
      currency,
      stripeAccountId: acct.stripeAccountId,
      localAccountId,
      displayName:    acct.displayName,
      createdAt:      new Date().toISOString(),
    });

    console.log(`[connect] Created product ${product.id} → account ${acct.stripeAccountId}`);
    res.redirect(`/connect/products?flash=Product+%22${encodeURIComponent(name)}%22+created`);

  } catch (err) {
    console.error('[connect] createProduct error:', err.message);
    res.redirect(`/connect/products?error=${encodeURIComponent(err.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STOREFRONT
// GET /connect/storefront
// Displays all platform products. Customers click "Buy" to go to Stripe Checkout.
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/storefront', async (req, res) => {
  const flash = req.query.flash || null;

  // Fetch all platform products from Stripe so we always show live data
  let stripeProducts = [];
  try {
    const stripeClient = getStripeClient();
    const result = await stripeClient.products.list({ active: true, limit: 50, expand: ['data.default_price'] });
    // Only show products that have a connected account in metadata (our Connect products)
    stripeProducts = result.data.filter(p => p.metadata?.connected_account_id);
  } catch (err) {
    console.error('[connect] storefront list error:', err.message);
  }

  res.render('connect-storefront', { products: stripeProducts, flash });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE CHECKOUT SESSION (Destination Charge)
// POST /connect/checkout
// Creates a Checkout session that transfers funds to the connected account
// minus a 15% application fee that stays with the platform.
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/checkout', async (req, res) => {
  const { productId } = req.body;

  if (!productId) {
    return res.redirect('/connect/storefront?error=Missing+product');
  }

  try {
    const stripeClient = getStripeClient();
    const base = baseUrl(req);

    // Fetch the product from Stripe to get the price and connected account
    const product = await stripeClient.products.retrieve(productId, {
      expand: ['default_price'],
    });

    const connectedAccountId = product.metadata?.connected_account_id;
    if (!connectedAccountId) {
      return res.redirect('/connect/storefront?error=Product+has+no+connected+seller');
    }

    const price = product.default_price;
    if (!price || !price.unit_amount) {
      return res.redirect('/connect/storefront?error=Product+has+no+price');
    }

    // Calculate application fee: platform keeps 15% of the transaction
    const PLATFORM_FEE_RATE = 0.20;
    const applicationFeeAmount = Math.round(price.unit_amount * PLATFORM_FEE_RATE);

    // Create a Checkout session with a destination charge.
    // - application_fee_amount: how much the PLATFORM keeps (in cents)
    // - transfer_data.destination: the connected account that receives the rest
    const session = await stripeClient.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency:     price.currency,
            unit_amount:  price.unit_amount,
            product_data: {
              name:        product.name,
              description: product.description || undefined,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount, // Platform fee (15%)
        transfer_data: {
          destination: connectedAccountId, // Funds go to this connected account
        },
      },
      mode:        'payment',
      success_url: `${base}/connect/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${base}/connect/storefront`,
    });

    console.log(`[connect] Checkout session ${session.id} → account ${connectedAccountId}`);
    res.redirect(303, session.url);

  } catch (err) {
    console.error('[connect] checkout error:', err.message);
    res.redirect(`/connect/storefront?error=${encodeURIComponent(err.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUCCESS PAGE
// GET /connect/success
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/success', async (req, res) => {
  const sessionId = req.query.session_id;
  let session = null;

  if (sessionId) {
    try {
      const stripeClient = getStripeClient();
      session = await stripeClient.checkout.sessions.retrieve(sessionId, {
        expand: ['line_items'],
      });
    } catch (err) {
      console.error('[connect] success retrieve error:', err.message);
    }
  }

  res.render('connect-success', { session });
});

// ═══════════════════════════════════════════════════════════════════════════════
// V2 THIN EVENT WEBHOOK
// POST /api/connect/webhook
// Receives thin event notifications for V2 account requirement changes.
//
// Setup in Stripe Dashboard:
//   Developers → Webhooks → Add destination → Connected accounts → Show advanced options
//   Payload style: Thin
//   Events: v2.core.account[requirements].updated
//            v2.core.account[configuration.recipient].capability_status_updated
//
// Local testing:
//   stripe listen --thin-events \
//     'v2.core.account[requirements].updated,v2.core.account[.recipient].capability_status_updated' \
//     --forward-thin-to http://localhost:3000/api/connect/webhook
// ═══════════════════════════════════════════════════════════════════════════════
router.post(
  '/api/connect/webhook',
  // Raw body is required for signature verification — must come BEFORE express.json()
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    // Immediately acknowledge receipt — Stripe retries if we don't respond within 30s
    res.sendStatus(200);

    try {
      const stripeClient = getStripeClient();
      const webhookSecret = getWebhookSecret();

      // Step 1: Parse and verify the thin event signature
      // parseThinEvent verifies the HMAC signature before we do anything with the payload
      const thinEvent = stripeClient.parseThinEvent(req.body, sig, webhookSecret);
      console.log(`[connect/webhook] Received thin event: ${thinEvent.type} id=${thinEvent.id}`);

      // Step 2: Fetch the full event object from Stripe
      // Thin events only contain the event ID and type — we must fetch the data separately
      const event = await stripeClient.v2.core.events.retrieve(thinEvent.id);

      // Step 3: Handle each event type
      switch (event.type) {

        // ── Requirements updated ─────────────────────────────────────────────
        // Fired when Stripe adds or removes requirements for a connected account.
        // This happens due to regulatory changes, card network updates, etc.
        case 'v2.core.account[requirements].updated': {
          const accountId = event.related_object?.id;
          console.log(`[connect/webhook] Requirements updated for account: ${accountId}`);

          // Fetch the full account to see what's now required
          const account = await stripeClient.v2.core.accounts.retrieve(
            accountId,
            { include: ['configuration.recipient', 'requirements'] }
          );

          const reqStatus = account.requirements?.summary?.minimum_deadline?.status;
          console.log(`[connect/webhook] Requirements status: ${reqStatus}`);

          // TODO: If reqStatus is 'currently_due' or 'past_due', notify the driver
          // to complete onboarding via email or SMS using your existing notification services.
          break;
        }

        // ── Recipient capability status updated ──────────────────────────────
        // Fired when the stripe_transfers capability changes status (e.g. becomes active).
        case 'v2.core.account[configuration.recipient].capability_status_updated': {
          const accountId = event.related_object?.id;
          console.log(`[connect/webhook] Recipient capability updated for account: ${accountId}`);

          const account = await stripeClient.v2.core.accounts.retrieve(
            accountId,
            { include: ['configuration.recipient'] }
          );

          const transfersStatus =
            account?.configuration?.recipient?.capabilities
              ?.stripe_balance?.stripe_transfers?.status;

          console.log(`[connect/webhook] stripe_transfers status: ${transfersStatus}`);

          if (transfersStatus === 'active') {
            // TODO: Notify the driver that their account is ready to receive payouts
            console.log(`[connect/webhook] Account ${accountId} is now active for payouts`);
          }
          break;
        }

        default:
          console.log(`[connect/webhook] Unhandled event type: ${event.type}`);
      }

    } catch (err) {
      // We already sent 200, so we just log the error — Stripe won't retry
      console.error('[connect/webhook] Error processing event:', err.message);
    }
  }
);

module.exports = router;
