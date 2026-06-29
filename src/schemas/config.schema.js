const Joi = require("joi");

// config/global  — single source of truth for tunable business rules
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
  storeLat: Joi.number().required(),
  storeLng: Joi.number().required(),
  serviceRadiusKm: Joi.number().min(0).default(5),
  minOrderValue: Joi.number().min(0).default(200),
  taxPercent: Joi.number().min(0).max(100).default(0),
  deliveryTiers: Joi.array().items(deliveryTierSchema).min(1).required(),
  slots: Joi.array().items(slotSchema).min(1).required(),
  orderSeq: Joi.number().integer().min(1000).default(1000), // running order number
  updatedAt: Joi.number().required(),
});

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
