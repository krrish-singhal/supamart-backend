const Joi = require("joi");
const { AVAILABILITY } = require("../config/constants");

// products/{id}.variants[]
const variantSchema = Joi.object({
  id: Joi.string().required(),
  label: Joi.string().required(), // "500ml", "1L"
  price: Joi.number().min(0).required(),
  offerPrice: Joi.number().min(0).allow(null),
  stock: Joi.number().integer().min(0).required(),
});

// categories/{categoryId}
// parentId null = top-level category; set = sub-category shown under its parent
// (e.g. "Powder" under "Detergent") in the Categories screen accordion.
const categorySchema = Joi.object({
  name: Joi.string().min(1).max(60).required(),
  image: Joi.string().uri().allow("", null),
  // Slug key for a locally-bundled asset (customer/src/utils/subCategoryImages.js),
  // used instead of `image` when the picture ships in the app bundle rather than a remote URL.
  imageKey: Joi.string().max(80).allow(null).default(null),
  order: Joi.number().integer().min(0).required(),
  parentId: Joi.string().allow(null).default(null),
  isActive: Joi.boolean().default(true),
  createdAt: Joi.number().required(),
  updatedAt: Joi.number().required(),
});

// brands/{brandId}
const brandSchema = Joi.object({
  name: Joi.string().min(1).max(60).required(),
  logoUrl: Joi.string().uri().allow("", null),
  order: Joi.number().integer().min(0).required(),
  isActive: Joi.boolean().default(true),
  createdAt: Joi.number().required(),
  updatedAt: Joi.number().required(),
});

// products/{productId}
const productSchema = Joi.object({
  name: Joi.string().min(1).max(120).required(),
  description: Joi.string().max(2000).allow("", null),
  categoryId: Joi.string().required(),
  brandId: Joi.string().allow(null).default(null),
  unit: Joi.string().max(30).required(), // "ml", "kg", "pcs"
  images: Joi.array().items(Joi.string().uri()).min(1).required(),
  variants: Joi.array().items(variantSchema).min(1).required(),
  availability: Joi.string().valid(...Object.values(AVAILABILITY)).default(AVAILABILITY.AVAILABLE),
  isAvailableToday: Joi.boolean().default(true),
  isFeatured: Joi.boolean().default(false),
  isTrending: Joi.boolean().default(false),
  soldCount: Joi.number().integer().min(0).default(0),
  createdAt: Joi.number().required(),
  updatedAt: Joi.number().required(),
});

// banners/{bannerId}
const bannerSchema = Joi.object({
  image: Joi.string().uri().required(),
  target: Joi.string().allow("", null), // categoryId / productId / url
  order: Joi.number().integer().min(0).required(),
  isActive: Joi.boolean().default(true),
  createdAt: Joi.number().required(),
});

module.exports = { variantSchema, categorySchema, brandSchema, productSchema, bannerSchema };
