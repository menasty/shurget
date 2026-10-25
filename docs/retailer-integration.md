# Retailer Integration Guide — Shurget Embed Widget

The **Shurget Checkout Widget** lets retailers embed a "Haul it home — get a quote" button directly on their product pages. Customers get live delivery pricing without leaving the retailer's site, and the retailer is automatically credited for every booking.

---

## Quick Start (60 Seconds)

Add one script tag next to your "Add to Cart" button:

```html
<script
  src="https://shurget.com/widget.js"
  data-item="sofa"
  data-origin-zip="80202"
  data-partner="YOUR-STORE-SLUG"
></script>
```

That's it. The widget appears, loads live pricing, and routes bookings to Shurget with your partner attribution baked in.

---

## Configuration Options

| Attribute | Required | Default | Description |
|---|---|---|---|
| `data-item` | Yes | `other` | Item type: `sofa`, `armchair`, `mirror`, `dresser`, `mattress`, `bed-frame`, `refrigerator`, `washer-dryer`, `dishwasher`, `exercise-equipment`, `grill`, `dining-table`, `desk`, `other` |
| `data-origin-zip` | Recommended | _(empty)_ | Your store's ZIP code — locks the pickup address so customers only enter delivery ZIP |
| `data-partner` | Recommended | _(empty)_ | Your unique partner slug — used for booking attribution and revenue dashboard |
| `data-label` | No | `Shurget it home — get a quote` | Button text |
| `data-color` | No | `#E86A00` | Button background color (any hex) |
| `data-weight` | No | `standard` | Item weight: `standard` or `heavy` — affects pricing |

### Full Example

```html
<!-- Product page: /products/bentwood-sectional -->
<div class="product-info">
  <h1>The Bentwood Sectional</h1>
  <p class="price">$1,249</p>
  <button class="add-to-cart">Add to Cart</button>

  <!-- Shurget delivery widget -->
  <script
    src="https://shurget.com/widget.js"
    data-item="sofa"
    data-origin-zip="80202"
    data-partner="bentwood-furniture"
    data-label="Haul it home — instant quote"
    data-color="#1a1a1a"
  ></script>
</div>
```

### Multiple Item Types (Custom Site)

If your product page has dynamic content, inject the script programmatically:

```js
const script = document.createElement('script');
script.src = 'https://shurget.com/widget.js';
script.setAttribute('data-item', 'sofa');
script.setAttribute('data-origin-zip', '80202');
script.setAttribute('data-partner', 'my-store');
document.body.appendChild(script);
```

---

## How It Works

1. **Customer clicks the button** → modal opens with a live Shurget pricing form (no redirect)
2. **Customer enters their delivery ZIP** → instant price calculated server-side
3. **Customer clicks "Book Now"** → modal closes, browser navigates to Shurget's checkout page with all params pre-filled (`item`, `origin_zip`, `dest_zip`, `ref_partner`)
4. **Customer completes payment** → order confirmed, partner attribution stored
5. **Delivery dispatched** → customer gets SMS/email tracking; you see the booking in your partner dashboard

---

## Partner Attribution

Set `data-partner="YOUR-SLUG"` on every widget instance. This:

- Tags the order with `partner_slug` in Shurget's system
- Credits the booking to your account in the partner dashboard
- Triggers commission payouts when earned (≥ $25 threshold)

Choose a slug that identifies your store (e.g., `acme-furniture`, `couch-potatoes`). Lowercase, hyphens allowed, no spaces.

---

## Platform Compatibility

The widget is plain JavaScript — no framework, no build step required.

| Platform | Status | Notes |
|---|---|---|
| **Shopify** | ✅ Works | Add as a custom HTML block or metafield in your theme |
| **WooCommerce** | ✅ Works | Add as a shortcode or custom HTML widget in a template |
| **BigCommerce** | ✅ Works | Add as a Web Component or custom HTML block |
| **Custom / Headless** | ✅ Works | Drop the `<script>` tag anywhere in your product HTML |
| **Webflow / Squarespace** | ✅ Works | Embed code block / custom code section |
| **Mobile Webviews** | ⚠️ Works with caveats | Payment flow requires external browser or WebView with `allow="payment"` |

---

## Troubleshooting

### Widget button doesn't appear

**Cause:** The script tag may be in a location that blocks DOM insertion, or `defer`/`async` on the script prevents immediate insertion.

**Fix:** Remove `defer` or `async` from the script tag. Place it at the very end of your `<body>`, or just after the product info block:

```html
<script src="https://shurget.com/widget.js" data-item="sofa" data-partner="my-store"></script>
</body>  <!-- NOT before this -->
```

### Pricing shows "Something went wrong"

**Cause:** Network issue or the store's ZIP code isn't in Shurget's Denver service area.

**Fix:** Shurget currently serves Denver, CO (ZIPs starting 802xx). Contact [partners@shurget.com](mailto:partners@shurget.com) to discuss coverage expansion.

### "Book Now" doesn't redirect

**Cause:** `window.parent.postMessage` may be blocked by the parent frame's CSP policy.

**Fix:** The widget falls back to `window.top.location.href` automatically. If the fallback also fails, your site may have a strict CSP blocking top navigation from iframes. Contact Shurget for an alternative deep-link method.

### CORS errors in browser console

**Cause:** The `/api/embed/calculate` endpoint is being called from a retailer domain without CORS headers (pre-July 2026 widget versions).

**Fix:** Ensure you are using `https://shurget.com/widget.js` (not a self-hosted copy). The live CDN serves the CORS-enabled version. If you've copied the widget locally, update to the latest version from `https://shurget.com/widget.js`.

### SSL/HTTPS warnings

**Cause:** Embedding the widget on an `http://` page triggers browser security warnings.

**Fix:** Your site must be served over HTTPS. All modern e-commerce platforms provide SSL certificates by default. If you're self-hosting, use Let's Encrypt or Cloudflare to add HTTPS.

---

## Custom Integrations (API Access)

For high-volume retailers who want programmatic order creation and webhook status updates:

**Status:** On roadmap. Contact [partners@shurget.com](mailto:partners@shurget.com) to join the API beta.

Expected capabilities:
- `POST /api/v1/orders` — create order and get tracking URL
- `POST /api/v1/orders/:id/cancel` — cancel before pickup
- `GET /api/v1/orders/:id` — get current status
- Webhooks: `order.booked`, `order.assigned`, `order.picked_up`, `order.delivered`, `order.cancelled`

---

## Contact & Sales

- **Pilot program:** Fill out the form at [shurget.com/partners](#pilot-form) — we respond within 1 business day
- **Volume pricing:** Partners with 20+ deliveries/month qualify for discounted rates
- **Custom integration / API:** [partners@shurget.com](mailto:partners@shurget.com)
- **Support:** [support@shurget.com](mailto:support@shurget.com)

---

*Last updated: June 2026 — Shurget v1.0*