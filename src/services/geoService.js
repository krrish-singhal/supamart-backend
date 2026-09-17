// All distance/radius/charge logic lives here so the rule cannot be bypassed by clients.

const { FREE_DELIVERY_THRESHOLD } = require("../config/constants");

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// returns { distanceKm, withinRadius, deliveryCharge }
function evaluateDelivery(config, destLat, destLng, subtotal = 0) {
  const distanceKm = haversineKm(config.storeLat, config.storeLng, destLat, destLng);
  const withinRadius = distanceKm <= (config.serviceRadiusKm || 5);
  let deliveryCharge = 0;
  
  if (withinRadius && config.deliveryTiers && config.deliveryTiers.length > 0) {
    // Sort tiers by maxKm ascending just in case
    const tiers = [...config.deliveryTiers].sort((a, b) => a.maxKm - b.maxKm);
    const tier = tiers.find(t => distanceKm <= t.maxKm);
    deliveryCharge = tier ? tier.charge : (tiers[tiers.length - 1].charge || 0);
  }

  if (subtotal >= FREE_DELIVERY_THRESHOLD) {
    deliveryCharge = 0;
  }

  return { distanceKm, withinRadius, deliveryCharge };
}

module.exports = { haversineKm, evaluateDelivery };
