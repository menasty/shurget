// db/surge.js — Surge pricing configuration (persisted in DB)
// The surge_config table holds a single-row JSON config that admin can update.
// Fallback to environment variable SURGE_MULTIPLIER for simple deployments.
//
// Schema (auto-created if missing via initSurgeTable):
//   CREATE TABLE IF NOT EXISTS surge_config (
//     id           SERIAL PRIMARY KEY,
//     multiplier   NUMERIC(4,2) NOT NULL DEFAULT 1.00,
//     active       BOOLEAN NOT NULL DEFAULT FALSE,
//     label        TEXT,           -- shown to customer: e.g. "High Demand"
//     reason       TEXT,           -- internal note
//     updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_by   TEXT
//   );

const db = require('./index');

async function initSurgeTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS surge_config (
      id           SERIAL PRIMARY KEY,
      multiplier   NUMERIC(4,2) NOT NULL DEFAULT 1.00,
      active       BOOLEAN NOT NULL DEFAULT FALSE,
      label        TEXT,
      reason       TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by   TEXT
    )
  `);
  // Seed default row if empty
  await db.query(`
    INSERT INTO surge_config (multiplier, active, label, reason)
    SELECT 1.00, FALSE, 'Standard Rate', 'default'
    WHERE NOT EXISTS (SELECT 1 FROM surge_config LIMIT 1)
  `);
}

/**
 * Get the current surge config.
 * Returns { multiplier, active, label }.
 * Falls back to { multiplier: 1.00, active: false, label: null } on error.
 */
async function getSurgeConfig() {
  try {
    const { rows } = await db.query(
      'SELECT multiplier, active, label FROM surge_config ORDER BY id DESC LIMIT 1'
    );
    if (!rows.length) return { multiplier: 1.00, active: false, label: null };
    const row = rows[0];
    return {
      multiplier: parseFloat(row.multiplier) || 1.00,
      active:     row.active === true,
      label:      row.label || null,
    };
  } catch (_) {
    // Non-fatal: fall back to env var or 1.0
    const envMultiplier = parseFloat(process.env.SURGE_MULTIPLIER) || 1.00;
    return { multiplier: envMultiplier, active: envMultiplier > 1.00, label: 'High Demand' };
  }
}

/**
 * Set surge pricing. Called from admin portal.
 * multiplier: 1.00 = normal, 1.20 = 20% surge, 1.50 = 50% surge
 * active: boolean
 * label: string shown to customer ("High Demand", "Weekend Rate", etc.)
 */
async function setSurgeConfig({ multiplier, active, label, reason, updatedBy }) {
  const m = Math.max(1.00, Math.min(2.00, parseFloat(multiplier) || 1.00));
  const { rows } = await db.query(
    `UPDATE surge_config
       SET multiplier  = $1,
           active      = $2,
           label       = $3,
           reason      = $4,
           updated_at  = NOW(),
           updated_by  = $5
     WHERE id = (SELECT id FROM surge_config ORDER BY id DESC LIMIT 1)
     RETURNING *`,
    [m, active === true, label || 'High Demand', reason || null, updatedBy || 'admin']
  );
  return rows[0];
}

/**
 * Evaluate weather conditions and return the appropriate surge tier.
 * Uses Open-Meteo WMO weather codes + windspeed + snowfall.
 *
 * WMO code reference (relevant ranges):
 *   51-67  : Drizzle / freezing drizzle / rain
 *   71-77  : Snow / snow grains / ice crystals
 *   80-82  : Rain showers
 *   85-86  : Snow showers
 *   95     : Thunderstorm
 *   96,99  : Thunderstorm w/ hail
 *
 * Returns { multiplier, active, label, reason } — ready to pass to setSurgeConfig.
 */
function evaluateWeatherSurge(weathercode, windspeedMph, snowfallMm, tempF) {
  const code = parseInt(weathercode, 10) || 0;

  // ── SEVERE: blizzard / thunderstorm with hail / heavy snow ──────────────
  // 1.40× — "Severe Weather Rate"
  const severe =
    (code >= 95) ||                        // thunderstorm (any)
    (code >= 85 && code <= 86) ||           // heavy snow showers
    (code >= 75 && code <= 77) ||           // heavy snow / ice crystals
    (windspeedMph >= 45) ||                 // near-gale wind regardless of precip
    (snowfallMm >= 5 && windspeedMph >= 25); // blowing snow combo

  if (severe) {
    return {
      multiplier: 1.40,
      active:     true,
      label:      'Severe Weather',
      reason:     `Auto: WMO ${code}, wind ${windspeedMph}mph, snow ${snowfallMm}mm, temp ${tempF}°F`,
    };
  }

  // ── MODERATE: snow / freezing rain / ice / high wind ────────────────────
  // 1.25× — "Winter Conditions"
  const moderate =
    (code >= 71 && code <= 77) ||           // any snow / snow grains
    (code >= 56 && code <= 57) ||           // freezing drizzle
    (code >= 66 && code <= 67) ||           // freezing rain
    (windspeedMph >= 30) ||                 // strong wind advisory
    (tempF !== null && tempF <= 10) ||      // extreme cold (feels dangerous)
    (snowfallMm > 0 && snowfallMm < 5);    // light snow accumulating

  if (moderate) {
    return {
      multiplier: 1.25,
      active:     true,
      label:      'Winter Conditions',
      reason:     `Auto: WMO ${code}, wind ${windspeedMph}mph, snow ${snowfallMm}mm, temp ${tempF}°F`,
    };
  }

  // ── HEAT: extreme summer heat (dangerous for drivers + loads) ───────────
  // 1.20× — "Extreme Heat"
  if (tempF !== null && tempF >= 100) {
    return {
      multiplier: 1.20,
      active:     true,
      label:      'Extreme Heat',
      reason:     `Auto: temp ${tempF}°F — heat advisory conditions`,
    };
  }

  // ── NORMAL: clear the auto surge ────────────────────────────────────────
  return {
    multiplier: 1.00,
    active:     false,
    label:      'Standard Rate',
    reason:     `Auto: conditions normal (WMO ${code}, wind ${windspeedMph}mph, temp ${tempF}°F)`,
  };
}

module.exports = { initSurgeTable, getSurgeConfig, setSurgeConfig, evaluateWeatherSurge };
