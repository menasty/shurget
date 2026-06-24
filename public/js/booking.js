// booking.js — One-page accordion booking flow

// Safe GA4 event helper — no-ops when gtag isn't loaded (env var not set)
function ga4(eventName, params) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params || {});
  }
}

// ─── UTM attribution helpers ──────────────────────────────────────────────────

function readUtmFirstCookie() {
  try {
    const match = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('utm_first='));
    if (!match) return null;
    return JSON.parse(decodeURIComponent(match.slice('utm_first='.length)));
  } catch (_) { return null; }
}

function readUtmFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return { s: p.get('utm_source') || '', m: p.get('utm_medium') || '', c: p.get('utm_campaign') || '' };
}

const _utmFirst = readUtmFirstCookie();
const _utmLast  = readUtmFromUrl();

// ─── Booking state ────────────────────────────────────────────────────────────

const state = {
  itemType: null,
  customItem: null,
  pickupAddress: '',
  dropoffAddress: '',
  helpers: 0,
  distanceMiles: null,
  pricing: null,
  previewDriver: null,
  orderId: null,
  referralCode: null,         // validated code (null = not applied)
  referralDiscountCents: 0,   // $20 = 2000 when applied
  partnerSlug: new URLSearchParams(window.location.search).get('ref_partner') || null,
  // UTM first-touch (from cookie set at original landing)
  utmSourceFirst:   _utmFirst ? _utmFirst.s : '',
  utmMediumFirst:   _utmFirst ? _utmFirst.m : '',
  utmCampaignFirst: _utmFirst ? _utmFirst.c : '',
  // UTM last-touch (from URL at the moment the user submits the booking)
  utmSourceLast:   _utmLast.s,
  utmMediumLast:   _utmLast.m,
  utmCampaignLast: _utmLast.c,
};

let accordionOpen = 'item'; // which section is open

// ─── Accordion helpers ────────────────────────────────────────────────────────

function openSection(id) {
  accordionOpen = id;
  // Collapse all bodies
  document.querySelectorAll('.accordion-body').forEach(b => b.classList.remove('open'));
  // Close all headers
  document.querySelectorAll('.accordion-header').forEach(h => h.setAttribute('aria-expanded', 'false'));
  // Open the target
  const body = document.getElementById('body-' + id);
  if (body) body.classList.add('open');
  const hdr = document.getElementById('btn-toggle-' + id);
  if (hdr) hdr.setAttribute('aria-expanded', 'true');
  // Scroll into view
  const section = document.getElementById('section-' + id);
  if (section) {
    const offset = 70;
    const top = section.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

function unlockSection(id) {
  const section = document.getElementById('section-' + id);
  if (!section) return;
  section.classList.remove('locked');
  const btn = document.getElementById('btn-toggle-' + id);
  if (btn) btn.disabled = false;
  // Make section-num green
  const num = document.getElementById('num-' + id);
  if (num) num.classList.add('done');
}

function setSummary(id, text) {
  const el = document.getElementById('summary-' + id);
  if (el) el.textContent = text;
}

// ─── Sticky bar ───────────────────────────────────────────────────────────────

function updateStickyBar() {
  const label = document.getElementById('sticky-label');
  const price = document.getElementById('sticky-price');
  const cta = document.getElementById('btn-sticky-cta');

  if (state.pricing) {
    label.textContent = state.itemType
      ? `${capitalize(state.itemType)} · ${state.distanceMiles} mi`
      : `${state.distanceMiles} mi`;
    price.textContent = `$${state.pricing.priceTotal.toFixed(2)}`;
    cta.textContent = 'Book Now →';
    cta.disabled = false;
  } else {
    label.textContent = 'Enter addresses above';
    price.textContent = '—';
    cta.textContent = 'Get Price';
    cta.disabled = true;
  }
}

// ─── Helpers toggle ───────────────────────────────────────────────────────────

document.querySelectorAll('.helper-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.helper-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.helpers = parseInt(btn.dataset.helpers, 10);
  });
});

// ─── Item selection ────────────────────────────────────────────────────────────

document.querySelectorAll('.item-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.item-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const value = card.dataset.value;
    state.itemType = value;

    const otherBlock = document.getElementById('other-input-block');
    if (value === 'other') {
      otherBlock.classList.add('visible');
      document.getElementById('other-item-input').focus();
      state.customItem = null;
    } else {
      otherBlock.classList.remove('visible');
      state.customItem = null;
    }

    // Update summary
    const label = card.querySelector('.item-label')?.textContent || value;
    setSummary('item', label);

    checkStep1();
    updateStickyBar();
    ga4('booking_initiated', { item_type: state.itemType });
  });
});

document.getElementById('other-item-input').addEventListener('input', () => {
  state.customItem = document.getElementById('other-item-input').value.trim();
  const input = document.getElementById('other-item-input');
  setSummary('item', state.customItem || 'Other');
  checkStep1();
  updateStickyBar();
});

// ─── Address inputs ───────────────────────────────────────────────────────────

function checkStep1() {
  const a1 = document.getElementById('pickup-address').value.trim();
  const a2 = document.getElementById('dropoff-address').value.trim();
  const otherSelected = state.itemType === 'other';
  const hasCustom = otherSelected ? !!state.customItem : true;
  document.getElementById('btn-price').disabled = !(state.itemType && hasCustom && a1 && a2);
}

document.getElementById('pickup-address').addEventListener('input', () => {
  state.pickupAddress = document.getElementById('pickup-address').value.trim();
  checkStep1();
  updateStickyBar();
});

document.getElementById('dropoff-address').addEventListener('input', () => {
  state.dropoffAddress = document.getElementById('dropoff-address').value.trim();
  checkStep1();
  updateStickyBar();
});

// ─── Error / loading ───────────────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 6000);
}

function setLoading(text) {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').classList.add('visible');
}

function clearLoading() {
  document.getElementById('loading').classList.remove('visible');
}

// ─── Step 1 → 2: Calculate price ──────────────────────────────────────────────

document.getElementById('btn-price').addEventListener('click', async () => {
  state.pickupAddress  = document.getElementById('pickup-address').value.trim();
  state.dropoffAddress = document.getElementById('dropoff-address').value.trim();
  setLoading('Calculating your price…');

  try {
    const res = await fetch('/api/booking/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType: state.itemType,
        customItem: state.itemType === 'other' ? state.customItem : null,
        pickupAddress: state.pickupAddress,
        dropoffAddress: state.dropoffAddress,
        helpers: state.helpers,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to calculate');

    state.pricing       = data.pricing;
    state.distanceMiles = data.distanceMiles ?? 5;
    state.previewDriver = data.driver;

    const dist = state.distanceMiles;

    // Show no-driver availability warning in the price section
    const driverPanel = document.getElementById('driver-panel');
    if (driverPanel) {
      if (data.noDriverAvailable) {
        driverPanel.innerHTML = `
          <div style="margin-top:0.75rem;padding:0.75rem;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:0.8rem;color:#92400e;line-height:1.5;">
            <strong>⚠️ No local drivers available right now.</strong><br>
            We may still be able to fulfill your order. Continue to checkout and we'll work on it.
          </div>
        `;
      }
    }

    // Price panel
    document.getElementById('price-display').textContent = `$${state.pricing.priceTotal.toFixed(2)}`;
    document.getElementById('price-base-rate').textContent = `$${state.pricing.priceBaseRate.toFixed(2)}`;
    document.getElementById('price-distance').textContent = `$${state.pricing.priceDistance.toFixed(2)}`;
    document.getElementById('distance-label').textContent = `Distance (${dist} mi × $1.50)`;
    document.getElementById('distance-badge').textContent = `${dist} mi`;
    document.getElementById('price-fee').textContent = `$${state.pricing.priceFee.toFixed(2)}`;

    const helpersRow = document.getElementById('helpers-row');
    if (state.helpers > 0 && state.pricing.priceHelpers > 0) {
      document.getElementById('helpers-label').textContent = `${state.helpers} helper${state.helpers > 1 ? 's' : ''}`;
      document.getElementById('price-helpers').textContent = `$${state.pricing.priceHelpers.toFixed(2)}`;
      helpersRow.style.display = 'flex';
    } else {
      helpersRow.style.display = 'none';
    }

    // Driver panel
    const d = state.previewDriver;
    const initials = d.name.split(' ').map(n => n[0]).join('');
    document.getElementById('driver-initial').textContent = initials;
    document.getElementById('driver-name').textContent = d.name;
    document.getElementById('driver-eta').textContent = `${d.eta} min away`;
    document.getElementById('driver-panel').classList.add('visible');

    clearLoading();

    // Mark section 1 complete, unlock section 2, open it
    setSummary('item', `${capitalize(state.itemType)} · ${dist} mi`);
    document.getElementById('num-item').classList.add('done');
    unlockSection('price');
    openSection('price');
    ga4('view_booking_step2', { item_type: state.itemType, distance_miles: dist, price: state.pricing.priceTotal });

    // Update sticky bar
    updateStickyBar();

    // Also populate section 3 price + driver
    document.getElementById('price-display-2').textContent = `$${state.pricing.priceTotal.toFixed(2)}`;
    const helpersRow2 = document.getElementById('helpers-row-2');
    if (state.helpers > 0 && state.pricing.priceHelpers > 0) {
      document.getElementById('helpers-label-2').textContent = `${state.helpers} helper${state.helpers > 1 ? 's' : ''} included`;
      document.getElementById('price-helpers-2').textContent = `+$${state.pricing.priceHelpers.toFixed(2)}`;
      helpersRow2.style.display = 'flex';
    } else {
      helpersRow2.style.display = 'none';
    }
    document.getElementById('driver-initial-2').textContent = initials;
    document.getElementById('driver-name-2').textContent = d.name;
    document.getElementById('driver-eta-2').textContent = `${d.eta} min away`;
    document.getElementById('driver-panel-2').classList.add('visible');

  } catch (err) {
    clearLoading();
    showError(err.message);
  }
});

// ─── Step 2 → 3 ───────────────────────────────────────────────────────────────

document.getElementById('btn-to-customer').addEventListener('click', () => {
  // Copy name+phone from summary
  setSummary('price', `$${state.pricing.priceTotal.toFixed(2)}`);
  document.getElementById('num-price').classList.add('done');
  unlockSection('customer');
  openSection('customer');
  ga4('view_booking_step3', { price: state.pricing.priceTotal });
});

document.getElementById('btn-back-price').addEventListener('click', () => openSection('item'));

// ─── Step 3: Submit ───────────────────────────────────────────────────────────

document.getElementById('cust-name').addEventListener('input', updateSubmitBtn);
document.getElementById('cust-phone').addEventListener('input', updateSubmitBtn);
document.getElementById('cust-terms-consent').addEventListener('change', updateSubmitBtn);

function updateSubmitBtn() {
  const name  = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const terms = document.getElementById('cust-terms-consent').checked;
  document.getElementById('btn-submit').disabled = !(name && phone && terms);
}

document.getElementById('btn-submit').addEventListener('click', async () => {
  const name  = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const email = document.getElementById('cust-email').value.trim();
  const smsConsent = document.getElementById('cust-sms-consent').checked;

  const terms = document.getElementById('cust-terms-consent').checked;
  if (!name || !phone) {
    showError('Please enter your name and phone number.');
    return;
  }
  if (!terms) {
    showError('Please agree to the Terms of Service and Privacy Policy to continue.');
    return;
  }

  setLoading('Creating your checkout session…');

  try {
    const res = await fetch('/api/booking/create-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemType: state.itemType,
        customItem: state.itemType === 'other' ? state.customItem : null,
        pickupAddress: state.pickupAddress,
        dropoffAddress: state.dropoffAddress,
        helpers: state.helpers,
        customerName: name,
        customerPhone: phone,
        customerEmail: email,
        smsConsent,
        referralCode: state.referralCode || undefined,
        partnerSlug: state.partnerSlug || undefined,
        utmSourceFirst:   state.utmSourceFirst   || undefined,
        utmMediumFirst:   state.utmMediumFirst   || undefined,
        utmCampaignFirst: state.utmCampaignFirst || undefined,
        utmSourceLast:    state.utmSourceLast    || undefined,
        utmMediumLast:    state.utmMediumLast    || undefined,
        utmCampaignLast:  state.utmCampaignLast  || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create checkout');

    clearLoading();
    ga4('begin_checkout', { item_type: state.itemType, price: data.pricing.priceTotal, order_id: data.orderId });
    window.location.href = data.checkoutUrl;
  } catch (err) {
    clearLoading();
    showError(err.message);
  }
});

// ─── Referral code ────────────────────────────────────────────────────────────

async function applyReferralCode() {
  const input = document.getElementById('referral-code-input');
  const msgEl = document.getElementById('referral-msg');
  const code   = input ? input.value.trim().toUpperCase() : '';

  if (!code) return;

  msgEl.style.display = 'block';
  msgEl.style.color = '#6b7280';
  msgEl.textContent = 'Validating…';

  const email = document.getElementById('cust-email').value.trim();

  try {
    const r = await fetch('/api/referral/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, bookerEmail: email }),
    });
    const data = await r.json();

    if (data.valid) {
      state.referralCode = data.code;
      state.referralDiscountCents = data.discount_cents;

      msgEl.style.color = '#16a34a';
      msgEl.textContent = '✓ ' + data.message;

      // Update the displayed price in section 3
      if (state.pricing) {
        const discountedTotal = Math.max(0, state.pricing.priceTotal - state.referralDiscountCents / 100);
        document.getElementById('price-display-2').textContent = `$${discountedTotal.toFixed(2)}`;

        // Add discount row if not already there
        let discRow = document.getElementById('referral-discount-row');
        if (!discRow) {
          discRow = document.createElement('div');
          discRow.id = 'referral-discount-row';
          discRow.className = 'breakdown-row';
          discRow.style.color = '#16a34a';
          const bd = document.getElementById('price-panel-2').querySelector('.price-breakdown');
          if (bd) bd.appendChild(discRow);
        }
        discRow.innerHTML = `<span>Referral discount</span><span>-$${(state.referralDiscountCents / 100).toFixed(0)}</span>`;
        discRow.style.display = 'flex';
      }
    } else {
      state.referralCode = null;
      state.referralDiscountCents = 0;
      msgEl.style.color = '#dc2626';
      msgEl.textContent = '✗ ' + (data.message || 'Invalid code.');
    }
  } catch {
    msgEl.style.color = '#dc2626';
    msgEl.textContent = 'Could not validate code — try again.';
  }
}

const applyBtn = document.getElementById('btn-apply-referral');
if (applyBtn) applyBtn.addEventListener('click', applyReferralCode);

const refInput = document.getElementById('referral-code-input');
if (refInput) {
  refInput.addEventListener('input', () => {
    refInput.value = refInput.value.toUpperCase();
  });
  refInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyReferralCode(); }
  });
}

// Pre-fill referral code from URL ?ref=CODE param when step 3 opens
document.getElementById('btn-to-customer').addEventListener('click', () => {
  const refParam = new URLSearchParams(window.location.search).get('ref');
  const inp = document.getElementById('referral-code-input');
  if (refParam && inp && !inp.value) {
    inp.value = refParam.toUpperCase();
    // Auto-validate after a short delay so the section is visible
    setTimeout(applyReferralCode, 300);
  }
}, { once: true }); // once: fire only first time (section unlock)

document.getElementById('btn-back-customer').addEventListener('click', () => openSection('price'));

// ─── Sticky bar CTA ───────────────────────────────────────────────────────────

document.getElementById('btn-sticky-cta').addEventListener('click', () => {
  if (state.pricing) {
    // Already have price — jump to section 3
    openSection('customer');
  } else {
    // Trigger price calculation
    document.getElementById('btn-price').click();
  }
});

// ─── Widget / deep-link pre-fill ──────────────────────────────────────────────
// Pre-fill from ?item=sofa, ?origin_zip=78704, ?dest_zip=78745, ?ref_partner=SLUG
// (partners pass ZIP codes from their store config; the form takes full address text)

const params = new URLSearchParams(window.location.search);

// Pre-select item type card if ?item= matches a data-value
const itemParam = params.get('item');
if (itemParam) {
  const matchCard = document.querySelector(`.item-card[data-value="${itemParam}"]`);
  if (matchCard) {
    matchCard.click();
    // scroll to and open section 1 so user sees the pre-selection
    setTimeout(() => openSection('item'), 0);
  }
}

// Pre-fill pickup address from ?origin_zip (widget passes ZIP as address placeholder)
const originZip = params.get('origin_zip');
if (originZip) {
  const pickupInp = document.getElementById('pickup-address');
  if (pickupInp) {
    pickupInp.value = originZip + ', TX';
    pickupInp.disabled = true; // locked by widget config
  }
}

// Pre-fill dropoff address from ?dest_zip
const destZip = params.get('dest_zip');
if (destZip) {
  const dropoffInp = document.getElementById('dropoff-address');
  if (dropoffInp) dropoffInp.value = destZip + ', TX';
}

// ─── Init ──────────────────────────────────────────────────────────────────────

// Open section 1 by default (but if item pre-filled, re-open it to show selection)
openSection(itemParam ? 'item' : 'item');
checkStep1();
updateStickyBar();
ga4('view_booking_step1', { page: '/book' });

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}