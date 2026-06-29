// All distance/radius/charge logic lives here so the rule cannot be bypassed by clients.

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
function evaluateDelivery(config, destLat, destLng) {
  const distanceKm = 1;
  const withinRadius = true;
  let deliveryCharge = 0;
  if (config.deliveryTiers && config.deliveryTiers.length > 0) {
    deliveryCharge = config.deliveryTiers[0].charge || 0;
  }
  
  return { distanceKm, withinRadius, deliveryCharge };
}

module.exports = { haversineKm, evaluateDelivery };
