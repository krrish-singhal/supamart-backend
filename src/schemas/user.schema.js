const Joi = require("joi");

// users/{uid}
const userSchema = Joi.object({
  name: Joi.string().min(1).max(80).required(),
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
  email: Joi.string().email().allow("", null),
  defaultAddressId: Joi.string().allow(null),
  isGuest: Joi.boolean().default(false),
  fcmTokens: Joi.array().items(Joi.string()).default([]),
  totalOrders: Joi.number().integer().min(0).default(0),
  lifetimeSpending: Joi.number().min(0).default(0),
  createdAt: Joi.number().required(), // epoch ms
  updatedAt: Joi.number().required(),
});

// users/{uid}/addresses/{addressId}
const addressSchema = Joi.object({
  houseNo: Joi.string().min(1).max(120).required(),
  street: Joi.string().min(1).max(160).required(),
  landmark: Joi.string().max(160).allow("", null),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).required(),
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  isDefault: Joi.boolean().default(false),
  createdAt: Joi.number().required(),
});

module.exports = { userSchema, addressSchema };
