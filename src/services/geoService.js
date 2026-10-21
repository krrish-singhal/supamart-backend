// All distance/radius/charge logic lives here so the rule cannot be bypassed by clients.

const { FREE_DELIVERY_THRESHOLD } = require("../config/constants");

const { haversineKm, evaluateServiceArea, withinDistance } = require('../config/deliveryArea');

// returns { distanceKm, withinRadius, deliveryCharge }
function evaluateDelivery(config, destLat, destLng, subtotal = 0) {
  const { distanceKm, withinRadius, coordinatesValid } = evaluateServiceArea(destLat, destLng);
  let deliveryCharge = 0;
  
  if (withinRadius && config.deliveryTiers && config.deliveryTiers.length > 0) {
    // Sort tiers by maxKm ascending just in case
    const tiers = [...config.deliveryTiers].sort((a, b) => a.maxKm - b.maxKm);
    const tier = tiers.find(t => withinDistance(distanceKm, t.maxKm));
    deliveryCharge = tier ? tier.charge : (tiers[tiers.length - 1].charge || 0);
  }

  if (subtotal >= FREE_DELIVERY_THRESHOLD) {
    deliveryCharge = 0;
  }

  return { distanceKm, withinRadius, coordinatesValid, deliveryCharge };
}

module.exports = { haversineKm, evaluateDelivery };
