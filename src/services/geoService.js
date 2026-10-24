// All distance/radius/charge logic lives here so the rule cannot be bypassed by clients.

const { FREE_DELIVERY_THRESHOLD } = require("../config/constants");

const { haversineKm, evaluateServiceArea, deliveryChargeForDistance } = require('../config/deliveryArea');

// returns { distanceKm, withinRadius, deliveryCharge }
function evaluateDelivery(config, destLat, destLng, subtotal = 0) {
  const { distanceKm, withinRadius, coordinatesValid } = evaluateServiceArea(destLat, destLng);
  let deliveryCharge = deliveryChargeForDistance(distanceKm);

  if (subtotal >= (config.freeDeliveryThreshold ?? FREE_DELIVERY_THRESHOLD)) {
    deliveryCharge = 0;
  }

  return { distanceKm, withinRadius, coordinatesValid, deliveryCharge };
}

module.exports = { haversineKm, evaluateDelivery };
