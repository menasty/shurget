# Shurget Soft-Launch Coordination Plan
**Status:** Draft | **Date:** 2026-06-04 | **Stage:** Pre-launch

---

## 1. Test Scope

### 1.1 Geographic Zones (2 routes initially)

| Zone | Pickup Area | Dropoff Area | Why |
|------|-------------|--------------|-----|
| **A** | Downtown / Midtown metro core | Suburban residential (5–15 mi) | High-density furniture/appliance moves |
| **B** | University district | Off-campus housing (3–10 mi) | Predictable demand, short distances |

**Rationale:** Both zones have dense pickup points and short-to-medium distances, minimizing fuel/time risk during the pilot. Expand to Zone C (industrial/commercial) only after Zone A and B hit criteria below.

### 1.2 Delivery Item Types (pilot only)

- Sofa, armchair, mattress, dresser (furniture — most common, easiest to load)
- Refrigerator, washer/dryer (appliances — validates heavy-item handling)

**Excluded from pilot:** Hot tubs, sheds, pianos (require special equipment not yet validated).

### 1.3 Capacity Constraints

- **Max 2 concurrent deliveries** during pilot (prevents driver overload, limits operational blast radius)
- **Hours:** 8:00 AM – 8:00 PM daily (no night runs during pilot)
- **Volume target:** 1–2 deliveries/day for the first 5 deliveries, then re-evaluate

---

## 2. Driver Onboarding (Minimum 2 drivers)

### 2.1 Selection Criteria
- Active pickup truck (crew cab preferred for cargo protection)
- Available for at least 3 pilot days
- Located within 10 miles of Zone A or B

### 2.2 Briefing Package (send before Day 1)

**Driver gets via email:**
1. App walkthrough (screenshot guide of driver-facing flow — to be built)
2. Pickup checklist: photo on arrival, check-in with customer name
3. Dropoff checklist: photo on arrival, customer signature or photo confirmation
4. Emergency contact: Polsia on-call number (placeholder until support agent wired)
5. Payment timeline: drivers paid weekly, first payout after 5 deliveries

**Driver expectations during pilot:**
- Respond to dispatch request within 10 minutes
- Update location via the driver app at pickup and every 5 minutes en route
- Report issues immediately via in-app chat or phone

### 2.3 Driver Success Metrics (pilot phase)

| Metric | Target |
|--------|--------|
| Acceptance rate | ≥ 80% of dispatched requests |
| Avg response time | ≤ 10 minutes |
| Location updates | ≥ 90% on-time |
| Customer rating | ≥ 4.5/5 (if rating system not yet built, use manual follow-up score) |

---

## 3. Customer Acquisition (5–10 test customers)

### 3.1 Sources
- **Existing network:** Friends, colleagues, neighbors in Zones A/B — personal outreach
- **Next-door network:** Post in neighborhood groups (Facebook/Nextdoor) offering free delivery for feedback
- **Offer:** Free or discounted first delivery in exchange for honest review

### 3.2 Customer Briefing

**Before booking, customer is told:**
- This is a beta pilot — real driver, real truck, real delivery
- They'll get an upfront price (no surprises)
- They'll receive SMS with driver name, photo (if available), phone, and ETA
- Post-delivery, Polsia will follow up for feedback (no spam, one email)

---

## 4. Success Criteria — First 5 Deliveries

All five must pass before scaling to Phase 2 (more routes, more drivers, marketing).

| # | Criterion | How Measured | Pass Threshold |
|---|-----------|--------------|---------------|
| 1 | **Booking confirms** | Customer receives confirmation email + SMS within 2 min of booking | 5/5 confirmed |
| 2 | **Driver matched** | Driver assigned and accepts within 15 min of booking | 5/5 matched |
| 3 | **Price accuracy** | Final charge within ±10% of initial quote | 5/5 pass |
| 4 | **On-time pickup** | Driver arrives within ±10 min of stated ETA | 5/5 on time |
| 5 | **Delivery completed** | Item arrives at dropoff, customer confirmed receipt | 5/5 completed |
| 6 | **Customer satisfaction** | ≥ 4/5 on follow-up survey (or written feedback) | 4/5 or higher |
| 7 | **No incidents** | No damage reports, no complaints, no billing errors | 0 incidents |

**Scaling gate:** If ≤ 4/7 criteria pass, extend pilot 5 more deliveries before re-evaluating.

---

## 5. Action Checklist

### Phase 0 — Before Launch (complete by end of Week 1)

- [ ] Confirm 2+ drivers with trucks, send briefing package
- [ ] Identify 5–10 test customers in Zones A/B, brief them
- [ ] Verify Stripe webhook is live (test mode) — orders `pending_payment` → `paid` correctly
- [ ] Verify driver location tracking: POST /api/orders/:id/location responds, GET /api/orders/:id returns lat/lng
- [ ] Confirm Postmark emails are sending (confirmation email on booking)
- [ ] Set up monitoring: check logs for errors on Render after each delivery
- [ ] Assign on-call contact (Polsia or human) for driver/customer issues during pilot

### Phase 1 — Active Deliveries (first 5)

**Booking Confirmation:**
- [ ] Customer fills /book form → receives immediate confirmation email (Postmark)
- [ ] Stripe Checkout redirects correctly → order status updates to `pending_payment`
- [ ] Stripe webhook fires → order promoted to `paid`

**Driver Dispatch:**
- [ ] Driver receives in-app or SMS dispatch request
- [ ] Driver accepts → order updated with driver_name, driver_phone, eta_minutes
- [ ] Customer receives SMS with driver name + ETA
- [ ] Driver updates location at pickup → customer sees live ETA on dashboard

**Delivery Completion:**
- [ ] Driver marks delivery complete (endpoint needed — TODO if not yet built)
- [ ] Order status updated to `delivered`
- [ ] Stripe webhook events logged for audit

**Customer Follow-up:**
- [ ] Automated follow-up email sent within 2 hours of delivery completion
- [ ] Email asks: How was the delivery? Any issues? Would you use Shurget again?
- [ ] Response collected → stored in context graph for future reference

### Phase 2 — Scale Decision (after 5 deliveries)

- [ ] Pull logs: any errors during booking, payment, or dispatch?
- [ ] Review customer feedback
- [ ] Score against 7 criteria table above
- [ ] If criteria met: open Zone C, onboard 2 more drivers, begin marketing
- [ ] If criteria not met: identify failure points, fix, run 5 more deliveries

---

## 6. Rollback Triggers

If ANY of these occur, pause operations and fix before continuing:
- Stripe charge fails or charges incorrectly (billing error)
- Driver no-show with no communication for >30 minutes
- Item damaged during transport
- Customer complaint about safety or unprofessional behavior

---

## 7. Open Items (needs owner decision before launch)

1. **Driver dispatch channel** — `/drive` is only a signup form. There is NO active dispatch API for a live driver to receive job assignments. Needs: a driver-facing endpoint (SMS push, email, or an authenticated GET /api/drive/available-jobs). Without this, the pilot cannot proceed beyond the first test order.
2. **Delivery completion trigger** — No `PATCH /api/orders/:id/status` or equivalent exists. Orders have a `status` column but no route to set it to `delivered`. Needs: a driver-side "mark complete" endpoint wired to `confirmOrder` with `status: 'delivered'`.
3. **Driver payment** — How are drivers paid? Weekly ACH? In-app payout? Define before onboarding drivers.
4. **On-call contact** — Who do drivers call if something goes wrong mid-delivery?

---

## 8. Gaps Found (needs engineering before launch)

| Gap | Impact | Action |
|-----|--------|--------|
| No driver dispatch endpoint | Cannot assign drivers to orders | Add `POST /api/orders/:id/dispatch` that calls `confirmOrder` with driver info |
| No delivery completion endpoint | Cannot close orders to `delivered` | Add `PATCH /api/orders/:id/status` or `POST /api/orders/:id/complete` |
| No driver auth | Location updates and dispatch not authenticated | Gate with a simple driver token for pilot phase |

**These gaps must be resolved before the first real delivery can occur.**

---

*This plan gates all scaling decisions. No additional routes, drivers, or marketing until Phase 2 scorecard is reviewed.*