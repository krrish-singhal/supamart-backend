// Canonical delivery policy. Sync the identical app module with npm run sync:delivery-area.
// Coordinates are the centre of the supplied Plus Code 6JWRHV76+F39, Menamkulam.
const STORE_LOCATION = Object.freeze({
  lat: 8.5636625,
  lng: 76.860234375,
  address: 'HV76+F39, Menamkulam, Thiruvananthapuram, Menamkulam, Keralam 695582',
  plusCode: '6JWRHV76+F39',
  mapsUrl: 'https://share.google/HufMXvVSvLv6chNM5',
});
const SERVICE_RADIUS_KM = 5;
const DELIVERY_TIERS = Object.freeze([
  Object.freeze({ maxKm: 1, charge: 10 }),
  Object.freeze({ maxKm: 2, charge: 15 }),
  Object.freeze({ maxKm: 3, charge: 20 }),
  Object.freeze({ maxKm: 4, charge: 25 }),
  Object.freeze({ maxKm: 5, charge: 30 }),
]);
const EARTH_RADIUS_KM = 6371;
// One micrometre: absorbs floating-point error at exactly 5 km, not a delivery allowance.
const BOUNDARY_EPSILON_KM = 1e-9;

function validCoordinates(lat, lng) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if (!validCoordinates(lat1, lng1) || !validCoordinates(lat2, lng2)) return null;
  const radians = degrees => degrees * Math.PI / 180;
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
  const bounded = Math.max(0, Math.min(1, a));
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

function withinDistance(distanceKm, radiusKm) {
  return typeof distanceKm === 'number' && Number.isFinite(distanceKm) && distanceKm >= 0
    && typeof radiusKm === 'number' && Number.isFinite(radiusKm) && radiusKm >= 0
    && distanceKm <= radiusKm + BOUNDARY_EPSILON_KM;
}

// Inclusive upper bounds: exactly 1 km costs ₹10; just over 1 km costs ₹15.
function deliveryChargeForDistance(distanceKm) {
  if (!withinDistance(distanceKm, SERVICE_RADIUS_KM)) return 0;
  return DELIVERY_TIERS.find(tier => withinDistance(distanceKm, tier.maxKm)).charge;
}

function evaluateServiceArea(lat, lng) {
  const distanceKm = haversineKm(STORE_LOCATION.lat, STORE_LOCATION.lng, lat, lng);
  return {
    distanceKm,
    coordinatesValid: distanceKm !== null,
    withinRadius: withinDistance(distanceKm, SERVICE_RADIUS_KM),
  };
}

function withDeliveryArea(config = {}) {
  return {
    ...config,
    deliveryTiers: DELIVERY_TIERS.map(tier => ({ ...tier })),
    freeDeliveryThreshold: Number.isFinite(config.freeDeliveryThreshold) && config.freeDeliveryThreshold >= 0 ? config.freeDeliveryThreshold : 3000,
    storeLat: STORE_LOCATION.lat,
    storeLng: STORE_LOCATION.lng,
    storeAddress: STORE_LOCATION.address,
    storePlusCode: STORE_LOCATION.plusCode,
    storeMapsUrl: STORE_LOCATION.mapsUrl,
    serviceRadiusKm: SERVICE_RADIUS_KM,
    distanceMethod: 'straight-line',
  };
}

module.exports = { STORE_LOCATION, SERVICE_RADIUS_KM, DELIVERY_TIERS, deliveryChargeForDistance, EARTH_RADIUS_KM, validCoordinates, haversineKm, withinDistance, evaluateServiceArea, withDeliveryArea };
