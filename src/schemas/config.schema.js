const { STORE_LOCATION, SERVICE_RADIUS_KM } = require('../config/deliveryArea');
const Joi = require("joi");

// config/global — tunable business rules plus the fixed delivery-area policy
const deliveryTierSchema = Joi.object({
  maxKm: Joi.number().min(0).required(),
  charge: Joi.number().min(0).required(),
});

const configSchema = Joi.object({
  storeLat: Joi.number().valid(STORE_LOCATION.lat).required(),
  storeLng: Joi.number().valid(STORE_LOCATION.lng).required(),
  serviceRadiusKm: Joi.number().valid(SERVICE_RADIUS_KM).required(),
  freeDeliveryThreshold: Joi.number().min(0).optional(),
  preparationMinutes: Joi.number().min(0).max(180).optional(),
  deliverySpeedKmph: Joi.number().min(1).max(100).optional(),
  minOrderValue: Joi.number().min(0).optional(),
  taxPercent: Joi.number().min(0).max(100).optional(),
  deliveryTiers: Joi.array().items(deliveryTierSchema).optional(),
  slots: Joi.array().optional(),
  deliveryMode: Joi.string().optional(),
  storeHours: Joi.object().unknown(true).optional(),
  orderSeq: Joi.number().integer().min(1000).optional(),
  updatedAt: Joi.number().optional(),
}).unknown(true);

// metrics/daily/{YYYY-MM-DD} and metrics/monthly/{YYYY-MM}
const metricsSchema = Joi.object({
  orders: Joi.number().integer().min(0).default(0),
  revenue: Joi.number().min(0).default(0),
  delivered: Joi.number().integer().min(0).default(0),
  pending: Joi.number().integer().min(0).default(0),
  cancelled: Joi.number().integer().min(0).default(0),
  // peak hours histogram: { "9": 12, "10": 30, ... }
  hourly: Joi.object().pattern(/^[0-9]{1,2}$/, Joi.number().integer().min(0)).default({}),
  updatedAt: Joi.number().required(),
});

module.exports = { configSchema, metricsSchema };
