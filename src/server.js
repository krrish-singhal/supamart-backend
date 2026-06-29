require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { errorHandler, notFound } = require("./middleware/error");
const authRoutes = require("./routes/auth.routes");
const usersRoutes = require("./routes/users.routes");
const addressesRoutes = require("./routes/addresses.routes");
const categoriesRoutes = require("./routes/categories.routes");
const productsRoutes = require("./routes/products.routes");
const bannersRoutes = require("./routes/banners.routes");
const offersRoutes = require("./routes/offers.routes");
const cartRoutes = require("./routes/cart.routes");
const configRoutes = require("./routes/config.routes");
const orderRoutes = require("./routes/orders.routes");
const deliveryPartnersRoutes = require("./routes/deliveryPartners.routes");
const adminRoutes = require("./routes/admin.routes");

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(morgan("tiny"));
app.use(rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));

app.get("/", (req, res) => res.json({ status: "SupaMart API is running", version: "1.0.0" }));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// Public endpoints (no auth required)
app.use("/api/auth", authRoutes);
app.use("/api/config", configRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/banners", bannersRoutes);
app.use("/api/offers", offersRoutes);
app.use("/api/products", productsRoutes);

// Authenticated endpoints (auth checked per-route)
app.use("/api/users/:uid/addresses", addressesRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/delivery-partners", deliveryPartnersRoutes);

// Admin-only endpoints
app.use("/api/admin", adminRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", () => console.log(`SupaMart API running on :${PORT}`));

// Allow long-running uploads (Cloudinary can take 30-60s on slow networks)
server.keepAliveTimeout = 120_000;   // 2 min
server.headersTimeout   = 125_000;   // slightly above keepAlive

module.exports = app;
