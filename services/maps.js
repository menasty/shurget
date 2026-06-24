// services/maps.js — Address geocoding and distance calculation via OpenRouteService
// Owns: geocoding, point-to-point distance
// Does NOT own: pricing logic (that lives in db/orders.js)

const ORS_API_KEY = process.env.ORS_API_KEY;

async function geocode(address) {
  if (!address) return null;
  if (ORS_API_KEY) {
    try {
      const url = `https://api.openrouteservice.org/v2/geocode/search?text=${encodeURIComponent(address)}&size=1`;
      const res = await fetch(url, {
        headers: { Authorization: ORS_API_KEY },
      });
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates;
        return { lat, lng };
      }
    } catch (e) {
      console.warn('[maps] ORS geocode failed:', e.message);
    }
  }
  return estimateFromZip(address);
}

function estimateFromZip(address) {
  const zipMatch = address.match(/\b(5[0-9]{4}|4[0-9]{4}|6[0-9]{4})\b/);
  if (zipMatch) {
    const zip = parseInt(zipMatch[1]);
    const lat = 40 + (500 - (zip % 500)) / 100;
    const lng = -100 - (zip % 1000) / 10;
    return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 };
  }
  return null;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.max(1, Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))));
}

/**
 * Calculate driving distance (in miles) between two addresses.
 * Falls back to straight-line haversine if ORS routing API unavailable.
 * Returns { distanceMiles, pickupCoords, dropoffCoords } or null on total failure.
 */
async function calculateDistance(pickupAddress, dropoffAddress) {
  const pickupCoords  = await geocode(pickupAddress);
  const dropoffCoords = await geocode(dropoffAddress);

  if (!pickupCoords || !dropoffCoords) {
    return null;
  }

  // Try ORS routing API for actual road distance
  if (ORS_API_KEY) {
    try {
      const url = `https://api.openrouteservice.org/v2/routes/driving-car?start=${pickupCoords.lng},${pickupCoords.lat}&end=${dropoffCoords.lng},${dropoffCoords.lat}`;
      const res = await fetch(url, {
        headers: { Authorization: ORS_API_KEY },
      });
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const meters = data.features[0].properties.segments?.[0]?.distance;
        if (meters != null) {
          return {
            distanceMiles: Math.max(1, Math.round(meters / 1609.34)),
            pickupCoords,
            dropoffCoords,
          };
        }
      }
    } catch (e) {
      console.warn('[maps] ORS routing failed, falling back to haversine:', e.message);
    }
  }

  // Fallback: haversine straight-line distance
  return {
    distanceMiles: haversineMiles(pickupCoords.lat, pickupCoords.lng, dropoffCoords.lat, dropoffCoords.lng),
    pickupCoords,
    dropoffCoords,
  };
}

module.exports = { geocode, calculateDistance, haversineMiles };