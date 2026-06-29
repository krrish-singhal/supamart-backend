const Repository = require("./Repository");
const { COLLECTIONS } = require("../config/constants");
const { userSchema } = require("../schemas/user.schema");
const { categorySchema, productSchema, bannerSchema } = require("../schemas/catalog.schema");
const { orderSchema, offerSchema, deliveryPartnerSchema, cartSchema } = require("../schemas/order.schema");

// Ready-to-use, schema-validated repositories.
const Users = new Repository(COLLECTIONS.USERS, userSchema);
const Categories = new Repository(COLLECTIONS.CATEGORIES, categorySchema);
const Products = new Repository(COLLECTIONS.PRODUCTS, productSchema);
const Banners = new Repository(COLLECTIONS.BANNERS, bannerSchema);
const Orders = new Repository(COLLECTIONS.ORDERS, orderSchema);
const Offers = new Repository(COLLECTIONS.OFFERS, offerSchema);
const Carts = new Repository(COLLECTIONS.CARTS, cartSchema);
const DeliveryPartners = new Repository(COLLECTIONS.DELIVERY_PARTNERS, deliveryPartnerSchema);

module.exports = { Users, Categories, Products, Banners, Orders, Offers, Carts, DeliveryPartners };
