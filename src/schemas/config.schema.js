const { STORE_LOCATION, SERVICE_RADIUS_KM } = require('../config/deliveryArea');
const Joi = require("joi");

// config/global — tunable business rules plus the fixed delivery-area policy
const deliveryTierSchema = Joi.object({
  maxKm: Joi.number().min(0).required(),
  charge: Joi.number().min(0).required(),
});

const slotSchema = Joi.object({
  label: Joi.string().required(), // "9AM - 11AM"
  from: Joi.string().required(),
  to: Joi.string().required(),
  active: Joi.boolean().default(true),
});

const configSchema = Joi.object({
  storeLat: Joi.number().valid(STORE_LOCATION.lat).required(),
  storeLng: Joi.number().valid(STORE_LOCATION.lng).required(),
  serviceRadiusKm: Joi.number().valid(SERVICE_RADIUS_KM).default(SERVICE_RADIUS_KM),
  minOrderValue: Joi.number().min(0).default(200),
  taxPercent: Joi.number().min(0).max(100).default(0),
  deliveryTiers: Joi.array().items(deliveryTierSchema).min(1).required(),
  slots: Joi.array().items(slotSchema).min(1).required(),
  orderSeq: Joi.number().integer().min(1000).default(1000), // running order number
  updatedAt: Joi.number().required(),
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
