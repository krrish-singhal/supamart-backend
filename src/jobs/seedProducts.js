require("dotenv").config();
const { db } = require("../config/firebase");
const { COLLECTIONS, AVAILABILITY, OFFER_KIND, OFFER_SCOPE } = require("../config/constants");

// ---------------------------------------------------------------------------
// Cloudinary demo image URLs — varied by category feel
// ---------------------------------------------------------------------------
const IMG = {
  vegetables: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/spices.jpg",
  fruits:     "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/pot-mussels.jpg",
  groceries:  "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/spices.jpg",
  beverages:  "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/fish-vegetables.jpg",
  snacks:     "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/pot-mussels.jpg",
  dairy:      "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/fish-vegetables.jpg",
  household:  "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/ecommerce/accessories-bag.jpg",
  frozen:     "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/pot-mussels.jpg",
  bakery:     "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/food/spices.jpg",
  personalCare: "https://res.cloudinary.com/demo/image/upload/w_400,h_400,c_fill/samples/ecommerce/accessories-bag.jpg",
};

// Build a versioned image array: [base?v=1, base?v=2]
function imgs(base, count = 2) {
  return Array.from({ length: count }, (_, i) => `${base}?v=${i + 1}`);
}

// Build a variant with a realistic id
function v(label, price, stock, discountPct = 0) {
  return {
    id: label.toLowerCase().replace(/[^a-z0-9]/g, "_"),
    label,
    price,
    offerPrice: discountPct > 0 ? Math.round(price * (1 - discountPct / 100)) : null,
    stock,
  };
}

// ---------------------------------------------------------------------------
// Product catalogue — 30 per category
// ---------------------------------------------------------------------------

// isFeatured / isTrending assignment: we mark specific indices globally later.
// For now each entry has { name, description, unit, variants[], soldCount }
// categoryId + availability + isFeatured + isTrending + images + timestamps
// are filled in during seeding.

const CATALOGUE = {
  Vegetables: [
    { name: "Tomato",               unit: "kg",  description: "Fresh, ripe red tomatoes, perfect for curries and salads.",          variants: [v("500g", 25, 200, 10), v("1kg", 45, 150, 10)],  soldCount: 320 },
    { name: "Onion",                unit: "kg",  description: "Farm-fresh onions, essential for every Indian kitchen.",              variants: [v("500g", 22, 300, 0),  v("1kg", 40, 200, 0)],   soldCount: 410 },
    { name: "Potato",               unit: "kg",  description: "Versatile potatoes great for sabzi, fries, and more.",               variants: [v("500g", 20, 350),      v("1kg", 38, 250)],       soldCount: 390 },
    { name: "Spinach",              unit: "pcs", description: "Tender green spinach leaves, rich in iron and vitamins.",            variants: [v("1 bunch", 20, 150, 0), v("2 bunch", 38, 100, 0)], soldCount: 180 },
    { name: "Carrot",               unit: "kg",  description: "Sweet and crunchy carrots, ideal for salads, halwa, and cooking.",   variants: [v("500g", 30, 180, 8),  v("1kg", 55, 120, 8)],   soldCount: 220 },
    { name: "Cucumber",             unit: "pcs", description: "Cool, refreshing cucumbers perfect for raita and salads.",           variants: [v("2 pcs", 18, 200),     v("4 pcs", 34, 150)],     soldCount: 170 },
    { name: "Capsicum",             unit: "kg",  description: "Colourful bell peppers — green, red, and yellow varieties.",         variants: [v("250g", 40, 120, 10), v("500g", 75, 80, 10)],   soldCount: 145 },
    { name: "Cauliflower",          unit: "pcs", description: "Large, fresh cauliflower head ideal for gobi sabzi and pakoda.",     variants: [v("1 pc", 40, 100),      v("2 pcs", 75, 60)],      soldCount: 130 },
    { name: "Cabbage",              unit: "pcs", description: "Crispy green cabbage head, great for stir-fry and coleslaw.",        variants: [v("500g", 25, 180),      v("1 pc", 40, 120)],      soldCount: 115 },
    { name: "Broccoli",             unit: "pcs", description: "Nutrient-rich broccoli florets, excellent steamed or stir-fried.",   variants: [v("1 pc", 60, 90, 10),  v("2 pcs", 115, 50, 10)], soldCount: 95  },
    { name: "Lady Finger (Bhindi)", unit: "kg",  description: "Tender, fresh bhindi for classic masala okra curry.",                variants: [v("250g", 25, 160),      v("500g", 45, 110)],      soldCount: 210 },
    { name: "Bitter Gourd (Karela)",unit: "kg",  description: "Fresh bitter gourd, loved for its distinct taste and health benefits.", variants: [v("250g", 22, 140),   v("500g", 40, 90)],       soldCount: 88  },
    { name: "Ridge Gourd",          unit: "kg",  description: "Tender ridge gourd ideal for light sabzis and curries.",             variants: [v("500g", 28, 130),      v("1kg", 50, 80)],        soldCount: 72  },
    { name: "Bottle Gourd",         unit: "pcs", description: "Fresh lauki for healthy curries, halwa, and kofta.",                 variants: [v("1 pc", 35, 110),      v("2 pcs", 65, 70)],      soldCount: 98  },
    { name: "Drumstick",            unit: "pcs", description: "Crisp drumsticks (sahjan) for sambhar and curries.",                 variants: [v("4 pcs", 30, 120),     v("8 pcs", 55, 80)],      soldCount: 105 },
    { name: "Pumpkin",              unit: "kg",  description: "Sweet orange pumpkin for curries, halwa, and soups.",                variants: [v("500g", 22, 150),      v("1kg", 40, 100)],       soldCount: 82  },
    { name: "Sweet Potato",         unit: "kg",  description: "Naturally sweet shakarkandi — nutritious and delicious.",            variants: [v("500g", 35, 130),      v("1kg", 65, 80)],        soldCount: 110 },
    { name: "Radish",               unit: "pcs", description: "Crunchy white radish (mooli) perfect for parathas and salads.",      variants: [v("1 bunch", 18, 160),   v("2 bunch", 32, 100)],   soldCount: 90  },
    { name: "Beetroot",             unit: "kg",  description: "Deep purple beetroot great for juices, salads, and halwa.",          variants: [v("500g", 30, 140),      v("1kg", 55, 90)],        soldCount: 120 },
    { name: "Green Peas",           unit: "kg",  description: "Fresh, sweet green peas for pulao, matar paneer, and more.",         variants: [v("250g", 30, 200),      v("500g", 55, 140)],      soldCount: 195 },
    { name: "French Beans",         unit: "kg",  description: "Tender french beans ideal for stir-fry and vegetable dishes.",       variants: [v("250g", 35, 120),      v("500g", 65, 80)],       soldCount: 88  },
    { name: "Cluster Beans",        unit: "kg",  description: "Gavar phali — great for traditional Rajasthani and Gujarati sabzi.", variants: [v("250g", 22, 130),      v("500g", 40, 85)],       soldCount: 65  },
    { name: "Colocasia (Arbi)",     unit: "kg",  description: "Arbi roots for spicy fry, gravy, or South Indian preparations.",    variants: [v("250g", 28, 110),      v("500g", 50, 75)],       soldCount: 58  },
    { name: "Yam",                  unit: "kg",  description: "Suran — hearty yam root used in gravies and fries.",                 variants: [v("500g", 40, 100),      v("1kg", 75, 60)],        soldCount: 52  },
    { name: "Turnip",               unit: "kg",  description: "Winter shalgam — mild and nutritious root vegetable.",               variants: [v("500g", 28, 120),      v("1kg", 50, 80)],        soldCount: 60  },
    { name: "Corn / Maize",         unit: "pcs", description: "Fresh sweet corn on the cob, great grilled or in salads.",          variants: [v("2 pcs", 30, 200),     v("4 pcs", 55, 140)],     soldCount: 230 },
    { name: "Spring Onion",         unit: "pcs", description: "Fresh spring onions for chutney, salads, and Chinese dishes.",       variants: [v("1 bunch", 15, 180),   v("2 bunch", 28, 120)],   soldCount: 150 },
    { name: "Coriander Leaves",     unit: "pcs", description: "Fragrant fresh coriander for garnishing and chutney.",               variants: [v("1 bunch", 12, 300),   v("2 bunch", 22, 200)],   soldCount: 380 },
    { name: "Mint Leaves",          unit: "pcs", description: "Fresh mint leaves — indispensable for chutney, raita, and drinks.",  variants: [v("1 bunch", 10, 250),   v("2 bunch", 18, 180)],   soldCount: 280 },
    { name: "Curry Leaves",         unit: "pcs", description: "Aromatic curry leaves — essential for South Indian tempering.",      variants: [v("1 bunch", 8,  350),   v("2 bunch", 14, 250)],   soldCount: 290 },
  ],

  Fruits: [
    { name: "Apple",                unit: "kg",  description: "Crisp Shimla apples — naturally sweet and crunchy.",                 variants: [v("500g", 80, 150, 8),   v("1kg", 150, 100, 8)],   soldCount: 310 },
    { name: "Banana",               unit: "dozen", description: "Ripe, yellow bananas — a daily-energy favourite.",                  variants: [v("6 pcs", 35, 300),     v("12 pcs", 65, 200)],    soldCount: 450 },
    { name: "Mango",                unit: "kg",  description: "Succulent Alphonso or Kesar mangoes — king of fruits.",              variants: [v("500g", 120, 100, 10), v("1kg", 230, 70, 10)],   soldCount: 280 },
    { name: "Orange",               unit: "kg",  description: "Juicy Nagpur oranges packed with Vitamin C.",                        variants: [v("500g", 60, 180),      v("1kg", 115, 120)],      soldCount: 210 },
    { name: "Grapes",               unit: "kg",  description: "Seedless green or black grapes — sweet, plump, and fresh.",         variants: [v("500g", 70, 160, 7),   v("1kg", 135, 110, 7)],   soldCount: 245 },
    { name: "Watermelon",           unit: "pcs", description: "Large, juicy watermelon — the ultimate summer refresher.",           variants: [v("1 pc (2-3kg)", 120, 80), v("Half pc", 65, 120)], soldCount: 195 },
    { name: "Papaya",               unit: "pcs", description: "Ripe papaya — excellent for digestion and a natural sweetener.",     variants: [v("500g", 40, 150),      v("1 pc (~1kg)", 75, 100)], soldCount: 155 },
    { name: "Pineapple",            unit: "pcs", description: "Tropical pineapple — tangy, sweet, and full of Vitamin C.",         variants: [v("1 pc", 80, 90),       v("2 pcs", 150, 55)],     soldCount: 120 },
    { name: "Pomegranate",          unit: "kg",  description: "Anar — jewel-like seeds bursting with antioxidants.",               variants: [v("500g", 90, 120, 10),  v("1kg", 170, 80, 10)],   soldCount: 230 },
    { name: "Guava",                unit: "kg",  description: "Amrood — sweet and crunchy, rich in Vitamin C.",                    variants: [v("500g", 40, 200),      v("1kg", 75, 140)],       soldCount: 185 },
    { name: "Kiwi",                 unit: "pcs", description: "Imported kiwi fruit — tangy-sweet with a vibrant green interior.",  variants: [v("3 pcs", 90, 100, 10), v("6 pcs", 170, 70, 10)], soldCount: 145 },
    { name: "Strawberry",           unit: "pcs", description: "Fresh Mahabaleshwar strawberries — bright red and aromatic.",       variants: [v("250g", 80, 90, 12),   v("500g", 150, 60, 12)],  soldCount: 175 },
    { name: "Coconut",              unit: "pcs", description: "Fresh coconut — for cooking, chutneys, or drinking tender water.",   variants: [v("1 pc", 45, 200),      v("2 pcs", 85, 130)],     soldCount: 260 },
    { name: "Lemon",                unit: "pcs", description: "Nimbu — tangy citrus essential for everyday cooking.",               variants: [v("6 pcs", 20, 400),     v("12 pcs", 36, 280)],    soldCount: 380 },
    { name: "Sweet Lime (Mosambi)", unit: "kg",  description: "Mosambi — mildly sweet citrus, loved as fresh juice.",              variants: [v("500g", 55, 160),      v("1kg", 105, 110)],      soldCount: 200 },
    { name: "Sapota (Chikoo)",      unit: "kg",  description: "Chikoo — caramel-sweet fruit with a malt-like flavour.",            variants: [v("500g", 50, 130),      v("1kg", 95, 90)],        soldCount: 115 },
    { name: "Jackfruit",            unit: "kg",  description: "Kathal — tropical superfruit eaten ripe or as a meat substitute.",  variants: [v("500g", 45, 100),      v("1kg", 85, 65)],        soldCount: 80  },
    { name: "Dragon Fruit",         unit: "pcs", description: "Exotic dragon fruit — vibrant pink skin and mild sweet flesh.",     variants: [v("1 pc", 120, 70, 10),  v("2 pcs", 230, 45, 10)], soldCount: 95  },
    { name: "Fig",                  unit: "pcs", description: "Anjeer — naturally sweet figs packed with fibre.",                  variants: [v("6 pcs", 80, 80),      v("12 pcs", 150, 50)],    soldCount: 70  },
    { name: "Plum",                 unit: "kg",  description: "Juicy Aloo Bukhara plums — sweet with a hint of tartness.",        variants: [v("500g", 90, 90),       v("1kg", 170, 60)],       soldCount: 88  },
    { name: "Peach",                unit: "kg",  description: "Soft, fragrant peaches from Himachal — summer's delight.",         variants: [v("500g", 110, 70),      v("1kg", 210, 45)],       soldCount: 65  },
    { name: "Pear",                 unit: "kg",  description: "Crisp and juicy nashpati pears from the Himalayan foothills.",      variants: [v("500g", 70, 100),      v("1kg", 135, 70)],       soldCount: 95  },
    { name: "Litchi",               unit: "kg",  description: "Juicy litchi — sweet, floral, and incredibly refreshing.",          variants: [v("500g", 100, 80, 8),   v("1kg", 190, 55, 8)],    soldCount: 140 },
    { name: "Dates",                unit: "pcs", description: "Medjool dates — rich, caramel-sweet and energy-packed.",            variants: [v("250g", 120, 90),      v("500g", 230, 60)],      soldCount: 160 },
    { name: "Avocado",              unit: "pcs", description: "Creamy imported avocado — perfect for toast, guac, and smoothies.", variants: [v("1 pc", 90, 80, 10),   v("2 pcs", 170, 50, 10)], soldCount: 105 },
    { name: "Mulberry",             unit: "pcs", description: "Seasonal Indian shehtoot — sweet-tart with a deep purple colour.",  variants: [v("250g", 80, 60),       v("500g", 150, 40)],      soldCount: 45  },
    { name: "Starfruit",            unit: "pcs", description: "Kamrakh — star-shaped tropical fruit with a mild citrus flavour.",  variants: [v("2 pcs", 60, 70),      v("4 pcs", 110, 45)],     soldCount: 40  },
    { name: "Custard Apple (Sitaphal)", unit: "pcs", description: "Creamy sitaphal — naturally sweet with a custard-like texture.", variants: [v("2 pcs", 80, 80),      v("4 pcs", 150, 50)],     soldCount: 90  },
    { name: "Passion Fruit",        unit: "pcs", description: "Tropical passionfruit — intensely fragrant with a sweet-tart pulp.", variants: [v("3 pcs", 90, 60),     v("6 pcs", 170, 40)],     soldCount: 55  },
    { name: "Amla (Indian Gooseberry)", unit: "kg", description: "Fresh amla — a superfood powerhouse rich in Vitamin C.",        variants: [v("250g", 40, 150),      v("500g", 75, 100)],      soldCount: 135 },
  ],

  Groceries: [
    { name: "Basmati Rice 5kg",         unit: "pack", description: "Long-grain aged basmati rice — perfect for biryani and pulao.",       variants: [v("5kg", 450, 120, 5), v("10kg", 880, 70, 5)],   soldCount: 280 },
    { name: "Toor Dal 1kg",             unit: "kg",   description: "Split pigeon peas — the base for everyday dal and sambhar.",          variants: [v("1kg", 140, 200),     v("2kg", 270, 120)],      soldCount: 240 },
    { name: "Chana Dal 1kg",            unit: "kg",   description: "Split Bengal gram — ideal for dal, besan, and pakoda.",               variants: [v("1kg", 110, 180),     v("2kg", 210, 100)],      soldCount: 195 },
    { name: "Moong Dal 1kg",            unit: "kg",   description: "Yellow moong dal — light, digestible, and nutritious.",               variants: [v("500g", 75, 200),     v("1kg", 145, 140)],      soldCount: 220 },
    { name: "Urad Dal 1kg",             unit: "kg",   description: "Black gram dal — essential for idli, dosa, and dal makhani.",         variants: [v("500g", 80, 180),     v("1kg", 155, 120)],      soldCount: 175 },
    { name: "Wheat Flour (Atta) 5kg",   unit: "pack", description: "Whole wheat chakki atta — for soft rotis and parathas every day.",    variants: [v("5kg", 260, 200, 8), v("10kg", 500, 100, 8)],  soldCount: 310 },
    { name: "Maida 1kg",                unit: "kg",   description: "Fine all-purpose flour for baking, poori, and sweets.",               variants: [v("1kg", 50, 250),      v("2kg", 95, 150)],       soldCount: 190 },
    { name: "Sooji (Semolina) 500g",    unit: "pack", description: "Fine rava semolina for upma, halwa, and rava dosa.",                  variants: [v("500g", 40, 220),     v("1kg", 75, 140)],       soldCount: 165 },
    { name: "Besan (Gram Flour) 1kg",   unit: "kg",   description: "Fresh besan for pakoda, kadhi, and Rajasthani gatte ki sabzi.",       variants: [v("500g", 55, 200),     v("1kg", 105, 130)],      soldCount: 210 },
    { name: "Mustard Oil 1L",           unit: "L",    description: "Cold-pressed kachi ghani mustard oil — sharp flavour for Indian cooking.", variants: [v("1L", 180, 150, 5), v("2L", 350, 90, 5)],  soldCount: 200 },
    { name: "Sunflower Oil 1L",         unit: "L",    description: "Refined sunflower oil — light, heart-healthy, and versatile.",        variants: [v("1L", 150, 200),      v("5L", 680, 100)],       soldCount: 250 },
    { name: "Olive Oil 500ml",          unit: "ml",   description: "Extra virgin olive oil — ideal for salad dressings and sautéing.",     variants: [v("500ml", 450, 70, 10), v("1L", 850, 40, 10)],  soldCount: 130 },
    { name: "Coconut Oil 500ml",        unit: "ml",   description: "Cold-pressed virgin coconut oil — for cooking and hair care.",         variants: [v("500ml", 220, 100),   v("1L", 420, 60)],        soldCount: 115 },
    { name: "Ghee 500g",                unit: "g",    description: "Pure desi cow ghee — rich flavour for dal, roti, and kheer.",          variants: [v("500g", 380, 120, 5), v("1kg", 750, 70, 5)],   soldCount: 275 },
    { name: "Salt (Iodized) 1kg",       unit: "kg",   description: "Iodized table salt — the essential everyday staple.",                  variants: [v("1kg", 22, 400),      v("2kg", 40, 250)],       soldCount: 420 },
    { name: "Sugar 1kg",                unit: "kg",   description: "Refined white sugar for chai, sweets, and everyday use.",              variants: [v("1kg", 48, 350),      v("5kg", 230, 150)],      soldCount: 390 },
    { name: "Turmeric Powder 200g",     unit: "g",    description: "Pure haldi powder — essential for colour, flavour, and health.",       variants: [v("100g", 35, 300),     v("200g", 65, 200)],      soldCount: 300 },
    { name: "Red Chilli Powder 200g",   unit: "g",    description: "Hot Kashmiri or Byadagi chilli powder for vibrant curries.",           variants: [v("100g", 40, 280),     v("200g", 75, 180)],      soldCount: 280 },
    { name: "Coriander Powder 200g",    unit: "g",    description: "Freshly ground dhania powder — a cornerstone of Indian spice blends.", variants: [v("100g", 30, 280),     v("200g", 55, 180)],      soldCount: 265 },
    { name: "Cumin (Jeera) 100g",       unit: "g",    description: "Whole jeera seeds for tadka, rice, and digestive drinks.",             variants: [v("100g", 60, 220),     v("200g", 115, 140)],     soldCount: 240 },
    { name: "Garam Masala 100g",        unit: "g",    description: "Aromatic garam masala blend — the finishing touch for any curry.",      variants: [v("50g", 45, 240),      v("100g", 85, 160)],      soldCount: 290 },
    { name: "Rajma (Kidney Beans) 500g",unit: "g",    description: "Red kidney beans for the iconic Punjabi rajma-chawal.",                variants: [v("500g", 90, 150),     v("1kg", 170, 90)],       soldCount: 200 },
    { name: "Black Chana 500g",         unit: "g",    description: "Desi kala chana — fibre-rich, great for chole and sundal.",            variants: [v("500g", 85, 160),     v("1kg", 160, 100)],      soldCount: 180 },
    { name: "Soya Chunks 200g",         unit: "g",    description: "High-protein soya nuggets — vegetarian meat alternative.",             variants: [v("200g", 55, 180),     v("400g", 100, 110)],     soldCount: 155 },
    { name: "Vermicelli (Sewai) 500g",  unit: "g",    description: "Fine wheat vermicelli for sewai kheer and upma.",                      variants: [v("200g", 25, 250),     v("500g", 55, 170)],      soldCount: 165 },
    { name: "Poha (Flattened Rice) 500g",unit:"g",    description: "Thin or thick poha — for quick breakfasts and kanda poha.",            variants: [v("500g", 45, 200),     v("1kg", 85, 130)],       soldCount: 210 },
    { name: "Sabudana 500g",            unit: "g",    description: "Tapioca pearls (sago) for khichdi, vada, and kheer during fasting.",   variants: [v("500g", 60, 170),     v("1kg", 115, 100)],      soldCount: 145 },
    { name: "Tamarind 200g",            unit: "g",    description: "Imli — tangy tamarind block for chutneys, sambhar, and rasam.",        variants: [v("200g", 40, 180),     v("500g", 90, 110)],      soldCount: 160 },
    { name: "Jaggery (Gud) 500g",       unit: "g",    description: "Unrefined cane jaggery — natural sweetener rich in iron.",             variants: [v("500g", 65, 200),     v("1kg", 120, 130)],      soldCount: 185 },
    { name: "Vinegar 500ml",            unit: "ml",   description: "White vinegar for pickling, salad dressings, and cooking.",            variants: [v("500ml", 35, 200),    v("1L", 65, 130)],        soldCount: 90  },
  ],

  Beverages: [
    { name: "Coca-Cola 2L",                unit: "L",    description: "Classic Coca-Cola — refreshing fizzy cola drink, great for parties.",  variants: [v("1.25L", 65, 200),    v("2L", 100, 150)],       soldCount: 340 },
    { name: "Pepsi 2L",                    unit: "L",    description: "Pepsi's bold cola taste — cold and refreshing.",                       variants: [v("600ml", 40, 250),    v("2L", 100, 170)],       soldCount: 295 },
    { name: "Sprite 1.5L",                 unit: "L",    description: "Lemon-lime fizz for a refreshing, ice-cold drink.",                    variants: [v("750ml", 45, 200),    v("1.5L", 80, 140)],      soldCount: 265 },
    { name: "Limca 600ml",                 unit: "ml",   description: "Lime 'n' lemoni Limca — the thirst quencher of India.",               variants: [v("600ml", 40, 200),    v("1.5L", 80, 130)],      soldCount: 220 },
    { name: "Thums Up 1.5L",               unit: "L",    description: "Strong, slightly spicy Thums Up cola — a true Indian classic.",        variants: [v("750ml", 45, 200),    v("1.5L", 80, 140)],      soldCount: 300 },
    { name: "Mountain Dew 1.25L",          unit: "L",    description: "Citrus-blast Mountain Dew — neon green and intensely refreshing.",     variants: [v("600ml", 40, 200),    v("1.25L", 72, 150)],     soldCount: 240 },
    { name: "Maaza Mango 600ml",           unit: "ml",   description: "Thick, mango-pulp Maaza — taste of summer in every sip.",             variants: [v("250ml", 20, 250),    v("600ml", 45, 170)],     soldCount: 285 },
    { name: "Frooti 200ml",                unit: "ml",   description: "Parle Agro's Frooti — the original Indian mango drink.",               variants: [v("200ml", 15, 350),    v("1L", 65, 180)],        soldCount: 310 },
    { name: "Real Orange Juice 1L",        unit: "L",    description: "100% real orange juice — no added preservatives, just pure fruit.",    variants: [v("1L", 130, 120, 8),   v("2L", 250, 70, 8)],     soldCount: 190 },
    { name: "Paper Boat Aam Panna 200ml",  unit: "ml",   description: "Refreshing raw mango aam panna with a traditional homestyle taste.",   variants: [v("200ml", 30, 200),    v("6-pack", 165, 100)],   soldCount: 175 },
    { name: "Minute Maid Guava 400ml",     unit: "ml",   description: "Sweet guava nectar from Minute Maid, rich and pulpy.",                variants: [v("400ml", 50, 150),    v("1L", 110, 90)],        soldCount: 140 },
    { name: "B Natural Mixed Fruit 1L",    unit: "L",    description: "ITC's B Natural — real fruit goodness with no artificial colours.",    variants: [v("1L", 120, 130),      v("2-pack", 225, 80)],    soldCount: 130 },
    { name: "Tropicana Apple 1L",          unit: "L",    description: "Chilled Tropicana apple juice — pure, refreshing, and nutritious.",    variants: [v("1L", 125, 140, 6),   v("2L", 240, 80, 6)],     soldCount: 185 },
    { name: "Kinley Water 1L",             unit: "L",    description: "Coca-Cola's Kinley purified drinking water — safe and clean.",         variants: [v("500ml", 15, 400),    v("1L", 20, 300)],        soldCount: 410 },
    { name: "Bisleri Water 1L",            unit: "L",    description: "India's most trusted packaged water brand.",                           variants: [v("500ml", 15, 400),    v("1L", 20, 300)],        soldCount: 450 },
    { name: "Evian Water 1L",              unit: "L",    description: "Premium natural mineral water from the French Alps.",                  variants: [v("500ml", 80, 100),    v("1L", 150, 60)],        soldCount: 70  },
    { name: "Red Bull 250ml",              unit: "ml",   description: "Original Red Bull energy drink — for peak performance.",               variants: [v("250ml", 125, 120, 5), v("2-pack", 240, 70, 5)], soldCount: 220 },
    { name: "Monster Energy 500ml",        unit: "ml",   description: "Monster Energy — unleash the beast with bold energy.",                 variants: [v("500ml", 120, 130),   v("2-pack", 230, 80)],    soldCount: 195 },
    { name: "Sting 250ml",                 unit: "ml",   description: "PepsiCo's Sting energy drink — sweet, strong, and affordable.",        variants: [v("250ml", 30, 300),    v("6-pack", 170, 120)],   soldCount: 260 },
    { name: "Tea Bags (Tetley) 100pc",     unit: "pack", description: "Tetley round tea bags — smooth Assam blend, quick to brew.",          variants: [v("50 bags", 110, 150), v("100 bags", 210, 100)], soldCount: 235 },
    { name: "Nescafe Classic 100g",        unit: "g",    description: "Nescafe Classic instant coffee — bold aroma, smooth taste.",           variants: [v("50g", 130, 180),     v("100g", 245, 120, 5)],  soldCount: 290 },
    { name: "Bru Filter Coffee 200g",      unit: "g",    description: "South Indian blend Bru filter coffee — rich and aromatic.",            variants: [v("100g", 90, 180),     v("200g", 170, 120)],     soldCount: 200 },
    { name: "Horlicks 500g",               unit: "g",    description: "Horlicks health drink — nourishing malt for children and adults.",     variants: [v("500g", 310, 130, 5), v("1kg", 595, 80, 5)],   soldCount: 240 },
    { name: "Complan Chocolate 200g",      unit: "g",    description: "Complan chocolate flavour — complete planned nutrition for kids.",      variants: [v("200g", 175, 150),    v("500g", 400, 90)],      soldCount: 185 },
    { name: "Boost 500g",                  unit: "g",    description: "GSK's Boost chocolate malt — science-backed energy for kids.",         variants: [v("500g", 330, 130),    v("1kg", 620, 75)],       soldCount: 205 },
    { name: "Milo 400g",                   unit: "g",    description: "Nestlé Milo — chocolate malt drink powder loved by all ages.",         variants: [v("200g", 130, 160),    v("400g", 245, 100)],     soldCount: 175 },
    { name: "Amul Kool Milk 200ml",        unit: "ml",   description: "Amul Kool flavoured milk — rose, elaichi, and butterscotch flavours.",  variants: [v("200ml", 30, 300),    v("6-pack", 170, 120)],   soldCount: 310 },
    { name: "Amul Lassi 200ml",            unit: "ml",   description: "Refreshing Amul lassi — creamy, sweet, and traditionally made.",       variants: [v("200ml", 30, 300),    v("1L", 120, 130)],       soldCount: 280 },
    { name: "Yakult Probiotic 5x65ml",     unit: "pack", description: "Yakult — 6.5 billion beneficial bacteria per bottle for gut health.",  variants: [v("5-pack", 90, 150, 5), v("10-pack", 170, 90, 5)], soldCount: 220 },
    { name: "Coconut Water 330ml",         unit: "ml",   description: "Natural tender coconut water — isotonic and naturally hydrating.",      variants: [v("330ml", 55, 200),    v("6-pack", 310, 100)],   soldCount: 180 },
  ],

  Snacks: [
    { name: "Lays Classic Salted 52g",          unit: "pack", description: "Frito-Lay's original salted potato chips — light, crispy perfection.",  variants: [v("26g", 10, 500),      v("52g", 20, 350)],       soldCount: 490 },
    { name: "Doritos Nacho 75g",                unit: "pack", description: "Triangular corn tortilla chips with bold nacho cheese flavour.",          variants: [v("40g", 30, 300),      v("75g", 55, 200)],       soldCount: 380 },
    { name: "Kurkure Masala Munch 90g",         unit: "pack", description: "India's favourite corn puff snack — spicy, tangy, and addictive.",       variants: [v("40g", 10, 450),      v("90g", 20, 300)],       soldCount: 460 },
    { name: "Bingo Mad Angles 72g",             unit: "pack", description: "ITC's Bingo Mad Angles — triangular chips with a bold masala kick.",      variants: [v("37g", 10, 400),      v("72g", 20, 280)],       soldCount: 410 },
    { name: "Parle-G Biscuits 800g",            unit: "pack", description: "Parle-G — India's most loved glucose biscuit since 1939.",               variants: [v("100g", 10, 600),     v("800g", 75, 250)],      soldCount: 550 },
    { name: "Oreo Chocolate 120g",              unit: "pack", description: "Nabisco Oreo — classic chocolate sandwich cookie with cream filling.",    variants: [v("75g", 30, 350),      v("120g", 50, 250)],      soldCount: 420 },
    { name: "Hide & Seek Bourbon 120g",         unit: "pack", description: "Parle's Hide & Seek — buttery bourbon biscuit with chocolate cream.",     variants: [v("120g", 30, 300),     v("2-pack", 56, 180)],    soldCount: 340 },
    { name: "Good Day Cashew 100g",             unit: "pack", description: "Britannia Good Day — rich butter cookies loaded with whole cashews.",     variants: [v("100g", 35, 320),     v("200g", 65, 190)],      soldCount: 360 },
    { name: "Sunfeast Dark Fantasy 75g",         unit: "pack", description: "ITC's Dark Fantasy — indulgent choco-filled chocolate shortbread.",      variants: [v("75g", 35, 280),      v("150g", 65, 170)],      soldCount: 310 },
    { name: "Britannia Marie Gold 250g",         unit: "pack", description: "Classic Marie Gold — crunchy tea biscuit, perfect with a hot cup of chai.", variants: [v("150g", 15, 400),   v("250g", 25, 300)],      soldCount: 370 },
    { name: "Haldiram Aloo Bhujia 200g",        unit: "pack", description: "Haldiram's crispy spiced potato bhujia — a timeless Indian namkeen.",     variants: [v("150g", 70, 200),     v("400g", 160, 120)],     soldCount: 390 },
    { name: "Haldiram Sev 200g",                unit: "pack", description: "Crispy gram flour sev — great alone or in chaat and bhel.",               variants: [v("200g", 65, 210),     v("400g", 125, 130)],     soldCount: 320 },
    { name: "Haldiram Moong Dal Namkeen 200g",  unit: "pack", description: "Crispy fried moong dal — light, crunchy, and perfectly spiced.",          variants: [v("150g", 70, 190),     v("400g", 170, 110)],     soldCount: 300 },
    { name: "Bikaji Mix Namkeen 200g",          unit: "pack", description: "Bikaji's signature mixed namkeen — a medley of savoury flavours.",        variants: [v("200g", 65, 200),     v("400g", 125, 130)],     soldCount: 280 },
    { name: "Bikaji Khatta Meetha 200g",        unit: "pack", description: "Sweet and tangy chaat-style mixture — a perfect anytime snack.",          variants: [v("200g", 60, 200),     v("400g", 115, 130)],     soldCount: 255 },
    { name: "Parle Krackjack 200g",             unit: "pack", description: "Sweet 'n' salty Krackjack — India's original crispy square cracker.",     variants: [v("100g", 15, 380),     v("200g", 30, 250)],      soldCount: 310 },
    { name: "Kit Kat 4F 41.5g",                unit: "pack", description: "Nestlé Kit Kat — break time's finest crispy wafer chocolate.",            variants: [v("41.5g", 45, 300),    v("6-pack", 255, 150)],   soldCount: 350 },
    { name: "Dairy Milk Silk 60g",              unit: "pack", description: "Cadbury Dairy Milk Silk — ultra-smooth, melt-in-mouth chocolate bar.",    variants: [v("60g", 85, 250, 5),   v("2-pack", 162, 130, 5)], soldCount: 380 },
    { name: "Munch 25g",                        unit: "pack", description: "Nestlé Munch — wafer fingers coated in crunchy chocolate.",               variants: [v("25g", 10, 450),      v("6-pack", 55, 200)],    soldCount: 420 },
    { name: "5 Star 40g",                       unit: "pack", description: "Cadbury 5 Star — caramel and nougat bar smothered in chocolate.",         variants: [v("40g", 25, 380),      v("6-pack", 140, 180)],   soldCount: 360 },
    { name: "Maggi Masala Noodles 70g",         unit: "pack", description: "Nestlé Maggi 2-Minute Noodles — India's all-time favourite instant meal.", variants: [v("70g", 14, 500),      v("6-pack", 80, 250)],    soldCount: 520 },
    { name: "Yippee Mood Masala 65g",           unit: "pack", description: "Sunfeast Yippee — non-sticky instant noodles in Mood Masala flavour.",    variants: [v("65g", 14, 400),      v("6-pack", 80, 200)],    soldCount: 390 },
    { name: "Sunbites Multigrain 52g",          unit: "pack", description: "Quaker Sunbites — baked multigrain snack, lighter and crunchier.",        variants: [v("52g", 30, 250),      v("3-pack", 85, 140)],    soldCount: 170 },
    { name: "Too Yumm! Veggie Stix 55g",        unit: "pack", description: "Guiltless baked veggie stix — flavourful and low on fat.",                variants: [v("55g", 35, 220),      v("3-pack", 99, 130)],    soldCount: 190 },
    { name: "Pringles Original 107g",           unit: "pack", description: "Pringles stackable chips — light, perfectly seasoned, once you pop…",     variants: [v("107g", 99, 180, 8),  v("200g", 180, 100, 8)],  soldCount: 280 },
    { name: "Cheetos Crunchy 60g",              unit: "pack", description: "Frito-Lay Cheetos — cheesy puffed corn snack with an irresistible crunch.", variants: [v("60g", 35, 250),     v("3-pack", 100, 140)],   soldCount: 230 },
    { name: "Tedhe Medhe 75g",                  unit: "pack", description: "ITC Tedhe Medhe — wavy multigrain chips with a punchy flavour.",           variants: [v("37g", 10, 380),      v("75g", 20, 260)],       soldCount: 310 },
    { name: "Perk 25g",                         unit: "pack", description: "Cadbury Perk — wafer and chocolate bites for a light sweet treat.",        variants: [v("25g", 10, 400),      v("6-pack", 55, 200)],    soldCount: 350 },
    { name: "Snickers 45g",                     unit: "pack", description: "Snickers — peanuts, caramel, nougat, and chocolate, you're not you when hungry.", variants: [v("45g", 55, 220, 5), v("3-pack", 159, 120, 5)], soldCount: 290 },
    { name: "Treat Fruit Rolls Strawberry",     unit: "pack", description: "ITC Treat Jims Strawberry Fruit Rolls — sweet fruity roll-up for kids.",  variants: [v("10pc", 35, 300),     v("20pc", 65, 180)],      soldCount: 195 },
  ],

  Dairy: [
    { name: "Amul Gold Milk 1L",            unit: "L",    description: "Full cream milk with rich taste — 6% fat, Amul Gold standard.",          variants: [v("500ml", 30, 300),    v("1L", 58, 200)],        soldCount: 450 },
    { name: "Amul Taaza Toned Milk 1L",     unit: "L",    description: "Toned milk with 3% fat — everyday milk for tea, cereal, and cooking.",   variants: [v("500ml", 25, 350),    v("1L", 48, 250)],        soldCount: 420 },
    { name: "Mother Dairy Full Cream 500ml",unit: "ml",   description: "Mother Dairy full-cream pouch milk — fresh and pasteurised daily.",       variants: [v("500ml", 30, 300),    v("1L", 58, 200)],        soldCount: 390 },
    { name: "Nandini Homogenised Milk 1L",  unit: "L",    description: "KMF Nandini — South India's favourite fresh homogenised milk.",           variants: [v("500ml", 26, 280),    v("1L", 50, 190)],        soldCount: 320 },
    { name: "Amul Butter 500g",             unit: "g",    description: "The Real Taste of India — Amul salted butter, 80% milk fat.",             variants: [v("100g", 55, 300, 5),  v("500g", 260, 180, 5)],  soldCount: 380 },
    { name: "Amul Salted Butter 100g",      unit: "g",    description: "Convenient 100g Amul butter cube — perfect for baking and toast.",         variants: [v("100g", 55, 350),     v("2-pack", 105, 220)],   soldCount: 340 },
    { name: "Britannia Cheese Slices 200g", unit: "g",    description: "Processed cheese slices — ideal for sandwiches and burgers.",              variants: [v("200g", 140, 200, 5), v("400g", 270, 120, 5)],  soldCount: 270 },
    { name: "Amul Processed Cheese 200g",   unit: "g",    description: "Amul's creamy processed block cheese — great for cooking and snacking.",   variants: [v("200g", 145, 190),    v("400g", 280, 110)],     soldCount: 240 },
    { name: "Amul Mozzarella 200g",         unit: "g",    description: "Stretchy Amul mozzarella — perfect for pizzas and pasta.",                  variants: [v("200g", 175, 150),    v("400g", 340, 90)],      soldCount: 195 },
    { name: "Amul Paneer 200g",             unit: "g",    description: "Fresh Amul paneer — soft, milky, and ready for your favourite sabzi.",     variants: [v("200g", 90, 250, 5),  v("500g", 210, 150, 5)],  soldCount: 420 },
    { name: "Sagar Pure Ghee 1L",           unit: "L",    description: "Sagar pure desi ghee — rich aroma, golden colour, traditional flavour.",   variants: [v("500ml", 340, 130),   v("1L", 665, 80)],        soldCount: 230 },
    { name: "Amul Ghee 500ml",              unit: "ml",   description: "Amul pure ghee — made from fresh cream, ideal for rotis and dal.",         variants: [v("200ml", 160, 180),   v("500ml", 380, 120)],    soldCount: 310 },
    { name: "Nestlé Milkmaid 400g",         unit: "g",    description: "Condensed sweetened milk — for kheer, gulkand, and dessert bases.",        variants: [v("200g", 95, 200),     v("400g", 180, 130)],     soldCount: 250 },
    { name: "Amul Fresh Cream 200ml",       unit: "ml",   description: "Amul fresh cream 25% fat — for gravies, cakes, and creamy soups.",         variants: [v("100ml", 40, 250),    v("200ml", 75, 170)],     soldCount: 210 },
    { name: "Epigamia Greek Yogurt Mango",  unit: "g",    description: "Thick, protein-rich Greek yogurt with real mango chunks.",                 variants: [v("90g", 50, 180),      v("4-pack", 185, 90)],    soldCount: 175 },
    { name: "Epigamia Greek Yogurt Plain",  unit: "g",    description: "Natural Epigamia Greek yogurt — high-protein, probiotic, and tangy.",      variants: [v("200g", 70, 160),     v("400g", 130, 100)],     soldCount: 150 },
    { name: "Amul Dahi (Curd) 400g",        unit: "g",    description: "Thick, set Amul dahi — creamy and mildly tangy.",                          variants: [v("200g", 30, 300),     v("400g", 56, 200)],      soldCount: 390 },
    { name: "Mother Dairy Dahi 400g",       unit: "g",    description: "Mother Dairy fresh curd — thick, fresh, and probiotic-rich.",               variants: [v("200g", 28, 280),     v("400g", 54, 190)],      soldCount: 370 },
    { name: "Amul Masti Dahi 200g",         unit: "g",    description: "Amul Masti — extra thick fresh curd with a creamy, indulgent texture.",    variants: [v("200g", 32, 280),     v("400g", 60, 190)],      soldCount: 320 },
    { name: "Nestlé a+ Munch Yogurt",       unit: "g",    description: "Nestlé a+ flavoured yogurt with a crunchy munch mix-in topping.",          variants: [v("100g", 50, 200),     v("4-pack", 190, 100)],   soldCount: 160 },
    { name: "Amul Lassi 200ml",             unit: "ml",   description: "Classic sweet Amul Lassi — chilled, creamy, and refreshing.",               variants: [v("200ml", 30, 300),    v("1L", 120, 150)],       soldCount: 300 },
    { name: "Amul Chocolate Milk 200ml",    unit: "ml",   description: "Amul Kool chocolate milk — rich cocoa flavour, loved by kids.",             variants: [v("200ml", 30, 280),    v("6-pack", 165, 130)],   soldCount: 280 },
    { name: "Amul Kool Café 200ml",         unit: "ml",   description: "Amul Kool Café — rich coffee milk drink, cold-brewed style.",               variants: [v("200ml", 30, 260),    v("6-pack", 165, 120)],   soldCount: 220 },
    { name: "Dodla Flavoured Milk 200ml",   unit: "ml",   description: "Dodla dairy flavoured milk in various indulgent flavours.",                 variants: [v("200ml", 28, 240),    v("6-pack", 155, 110)],   soldCount: 145 },
    { name: "Nandini Toned Dahi 500g",      unit: "g",    description: "Nandini toned curd — fresh, consistently set, mild and clean.",             variants: [v("500g", 50, 200),     v("1kg", 95, 120)],       soldCount: 190 },
    { name: "Amul Shrikhand Mango 100g",    unit: "g",    description: "Amul Mango Shrikhand — strained yogurt dessert, sweet and luscious.",       variants: [v("100g", 45, 200),     v("500g", 200, 100)],     soldCount: 210 },
    { name: "Amul Shrikhand Kesar 100g",    unit: "g",    description: "Amul Kesar Shrikhand — traditional Gujarat-style saffron dessert.",         variants: [v("100g", 50, 180),     v("500g", 220, 90)],      soldCount: 185 },
    { name: "Prabhat Tazza Curd 400g",      unit: "g",    description: "Prabhat Tazza fresh set curd — mild, creamy, and probiotic.",               variants: [v("200g", 28, 200),     v("400g", 52, 140)],      soldCount: 130 },
    { name: "Verka Milk Cream 1L",          unit: "L",    description: "Verka fresh cream — silky smooth, 35% fat for rich culinary use.",          variants: [v("200ml", 60, 150),    v("1L", 270, 80)],        soldCount: 90  },
    { name: "Govardhan Cow Ghee 500ml",     unit: "ml",   description: "Govardhan pure cow ghee — slow-churned, rich desi aroma and flavour.",      variants: [v("500ml", 380, 120),   v("1L", 740, 70)],        soldCount: 170 },
  ],

  Household: [
    { name: "Surf Excel Quick Wash 1kg",      unit: "kg",   description: "Surf Excel washing powder — removes tough stains even in cold water.",     variants: [v("500g", 120, 200),    v("1kg", 225, 130)],      soldCount: 290 },
    { name: "Ariel Matic Front Load 2kg",     unit: "kg",   description: "Ariel Matic — designed for front-load machines, brilliant clean.",         variants: [v("1kg", 290, 150),     v("2kg", 560, 90)],       soldCount: 210 },
    { name: "Tide Plus 2kg",                  unit: "kg",   description: "Tide Plus detergent — double power formula for thorough cleaning.",         variants: [v("1kg", 230, 170),     v("2kg", 445, 100)],      soldCount: 240 },
    { name: "Rin Detergent Bar 250g",         unit: "g",    description: "Rin bar soap — powerful stain removal for everyday hand washing.",          variants: [v("250g", 30, 350),     v("4-pack", 115, 200)],   soldCount: 200 },
    { name: "Wheel Detergent Powder 500g",    unit: "g",    description: "HUL Wheel — budget-friendly detergent with lemon freshness.",               variants: [v("500g", 55, 280),     v("1kg", 100, 180)],      soldCount: 230 },
    { name: "Vim Dishwash Bar 155g",          unit: "g",    description: "Vim bar — cuts grease, removes stains, leaves dishes squeaky clean.",       variants: [v("155g", 25, 350),     v("3-pack", 70, 200)],    soldCount: 310 },
    { name: "Pril Dishwash Liquid 500ml",     unit: "ml",   description: "Pril active lemon dishwash gel — tough on grease, gentle on hands.",       variants: [v("225ml", 65, 200),    v("500ml", 120, 130)],    soldCount: 270 },
    { name: "Harpic Power Plus 500ml",        unit: "ml",   description: "Harpic — 10x more cleaning power, kills 99.9% toilet germs.",              variants: [v("200ml", 70, 200),    v("500ml", 155, 130)],    soldCount: 235 },
    { name: "Lizol Floor Cleaner 975ml",      unit: "ml",   description: "Lizol disinfectant floor cleaner — kills germs, leaves floors gleaming.",  variants: [v("500ml", 115, 180),   v("975ml", 195, 110)],    soldCount: 220 },
    { name: "Colin Glass Cleaner 500ml",      unit: "ml",   description: "Colin glass & surface cleaner — streak-free sparkle every time.",           variants: [v("250ml", 75, 200),    v("500ml", 130, 130)],    soldCount: 190 },
    { name: "Odonil Bathroom Air Freshener",  unit: "pcs",  description: "Odonil block — long-lasting fragrance for bathrooms, up to 30 days.",       variants: [v("48g", 50, 250),      v("2-pack", 95, 160)],    soldCount: 200 },
    { name: "Dettol Antiseptic Liquid 500ml", unit: "ml",   description: "Dettol original antiseptic — for wound care, mopping, and personal hygiene.", variants: [v("250ml", 110, 200),  v("500ml", 200, 130)],    soldCount: 270 },
    { name: "Savlon Antiseptic 500ml",        unit: "ml",   description: "Savlon antiseptic liquid — gentle, effective protection from germs.",       variants: [v("200ml", 80, 200),    v("500ml", 175, 130)],    soldCount: 195 },
    { name: "Mortein Cockroach Killer 235ml", unit: "ml",   description: "Mortein PowerGard cockroach spray — kills on contact, long-lasting.",       variants: [v("235ml", 200, 150),   v("2-pack", 380, 90)],    soldCount: 165 },
    { name: "Good Knight Power Booster",      unit: "ml",   description: "Good Knight mosquito repellent — 2x power, protects for 12 hours.",         variants: [v("45ml", 75, 200),     v("2-pack", 140, 130)],   soldCount: 250 },
    { name: "HIT Mosquito Spray 200ml",       unit: "ml",   description: "HIT flying insect killer spray — instant knock-down of mosquitoes.",        variants: [v("200ml", 150, 180),   v("425ml", 280, 110)],    soldCount: 195 },
    { name: "Scotch-Brite Scrub Pad 2pc",     unit: "pack", description: "Scotch-Brite — heavy-duty scrubbing power, gentle on cookware surfaces.",   variants: [v("2pc", 50, 250),      v("5pc", 110, 160)],      soldCount: 260 },
    { name: "Fogg Deodorant Body Spray",      unit: "ml",   description: "Fogg — no gas, only perfume deodorant body spray for lasting freshness.",   variants: [v("150ml", 220, 150, 5), v("2-pack", 420, 90, 5)], soldCount: 200 },
    { name: "Eveready Battery AA 4pc",        unit: "pack", description: "Eveready heavy-duty AA batteries — reliable power for remotes & toys.",     variants: [v("4pc", 55, 300),      v("8pc", 100, 180)],      soldCount: 180 },
    { name: "Philips LED Bulb 9W",            unit: "pcs",  description: "Philips 9W LED bulb — energy-saving with 1000 lumen, 15000hr life.",        variants: [v("1pc", 120, 200),     v("3pc", 340, 120)],      soldCount: 220 },
    { name: "Cello Plastic Container 5pc",    unit: "set",  description: "Cello airtight container set — keeps food fresh, stackable and BPA-free.",   variants: [v("5pc set", 350, 120), v("10pc set", 650, 70)],  soldCount: 155 },
    { name: "Tupperware Bottle 750ml",        unit: "pcs",  description: "Tupperware leak-proof water bottle — durable and eco-friendly.",             variants: [v("750ml", 450, 80),    v("1L", 550, 60)],        soldCount: 120 },
    { name: "Milton Thermos Flask 1L",        unit: "pcs",  description: "Milton thermosteel flask — keeps beverages hot/cold for 24 hours.",          variants: [v("1L", 650, 80),       v("2L", 950, 50)],        soldCount: 95  },
    { name: "Pigeon Gas Lighter",             unit: "pcs",  description: "Pigeon electronic gas lighter — safe, rechargeable spark igniter.",          variants: [v("1pc", 150, 180),     v("2pc", 280, 110)],      soldCount: 145 },
    { name: "Steelo Lunch Box 3-tier",        unit: "pcs",  description: "Stainless steel 3-tier tiffin box — leak-proof, insulated, office-ready.",   variants: [v("3-tier", 550, 90),   v("4-tier", 750, 60)],    soldCount: 110 },
    { name: "Glucon-D Nimbu Pani 500g",       unit: "g",    description: "Dabur Glucon-D — instant energy glucose drink with lemon flavour.",          variants: [v("250g", 90, 180),     v("500g", 165, 110)],     soldCount: 175 },
    { name: "Prestige Pressure Cooker 3L",    unit: "pcs",  description: "Prestige alpha deluxe pressure cooker — ISI marked, induction compatible.",  variants: [v("3L", 1200, 60),      v("5L", 1600, 40)],       soldCount: 75  },
    { name: "Bamix Hand Mixer",               unit: "pcs",  description: "Compact hand mixer — 200W motor for whisking, beating, and blending.",       variants: [v("1pc", 800, 50),      v("with accessories", 1100, 30)], soldCount: 55 },
    { name: "Godrej Jumbo Safe",              unit: "pcs",  description: "Godrej mini locker — compact electronic safe for documents and cash.",        variants: [v("standard", 3500, 30), v("with shelf", 4200, 20)], soldCount: 25 },
    { name: "Bajaj Mixer Jar",                unit: "pcs",  description: "Replacement Bajaj mixer grinder jar — fits most 750W Bajaj models.",         variants: [v("1L jar", 650, 60),   v("1.5L jar", 800, 40)],  soldCount: 45  },
  ],

  "Frozen Foods": [
    { name: "McCain Smiles Potato 420g",         unit: "pack", description: "McCain Smiles — fun smiley-face potato snacks, oven-baked or air-fried.",  variants: [v("420g", 200, 150),    v("2-pack", 380, 90)],    soldCount: 230 },
    { name: "McCain French Fries 425g",          unit: "pack", description: "McCain classic crinkle cut fries — crispy outside, fluffy inside.",         variants: [v("425g", 200, 160),    v("2-pack", 380, 95)],    soldCount: 260 },
    { name: "McCain Burger Tikki 400g",          unit: "pack", description: "McCain burger tikkis — spiced potato patties, ready in minutes.",           variants: [v("400g", 180, 140),    v("2-pack", 340, 85)],    soldCount: 195 },
    { name: "Amul Pizza Base 6pc",               unit: "pack", description: "Amul thin-crust pizza base — ready for topping, bake at home.",             variants: [v("6pc", 150, 130),     v("12pc", 280, 80)],      soldCount: 175 },
    { name: "Amul Frozen Peas 500g",             unit: "pack", description: "Amul tender frozen green peas — IQF, retains freshness and nutrients.",      variants: [v("500g", 80, 200),     v("1kg", 150, 130)],      soldCount: 220 },
    { name: "ITC Master Chef Veg Momos 200g",    unit: "pack", description: "Steam or fry — ITC's Tibetan-style vegetable momos ready in minutes.",      variants: [v("200g", 130, 160),    v("400g", 250, 100)],     soldCount: 200 },
    { name: "Kwality Wall's Cornetto Chocolate", unit: "pcs",  description: "Classic Cornetto — chocolate-dipped wafer cone with chocolate ice cream.",  variants: [v("1pc", 55, 200),      v("4-pack", 200, 100)],   soldCount: 290 },
    { name: "Kwality Wall's Paddle Pop Mango",   unit: "pcs",  description: "Fruity mango Paddle Pop — tangy sweet ice lolly loved by kids.",            variants: [v("1pc", 20, 300),      v("6-pack", 110, 150)],   soldCount: 320 },
    { name: "Amul Vanilla Ice Cream 1L",         unit: "L",    description: "Classic Amul vanilla ice cream tub — smooth, rich and family-sized.",       variants: [v("500ml", 150, 160),   v("1L", 280, 110)],       soldCount: 270 },
    { name: "Mother Dairy Kulfi Malai",          unit: "pcs",  description: "Classic malai kulfi — dense, creamy, and authentically Indian.",             variants: [v("1pc", 30, 250),      v("4-pack", 110, 130)],   soldCount: 240 },
    { name: "Naturals Ice Cream Mango 500ml",    unit: "ml",   description: "Naturals' signature Alphonso mango ice cream — pure, no artificial flavours.", variants: [v("500ml", 250, 90, 8), v("1L", 480, 55, 8)],   soldCount: 200 },
    { name: "Baskin Robbins Chocolate 500ml",    unit: "ml",   description: "Baskin Robbins decadent chocolate ice cream — indulgence in every scoop.",   variants: [v("500ml", 350, 80, 5), v("1L", 650, 50, 5)],    soldCount: 165 },
    { name: "Govardhan Frozen Malai Kofta",      unit: "pack", description: "Ready-to-cook frozen malai kofta curry — restaurant taste at home.",         variants: [v("400g", 200, 100),    v("800g", 380, 60)],      soldCount: 130 },
    { name: "Haldiram Frozen Samosa 400g",       unit: "pack", description: "Haldiram crispy frozen samosas — ready to fry, perfectly spiced filling.",   variants: [v("400g", 195, 130),    v("800g", 370, 80)],      soldCount: 175 },
    { name: "Haldiram Frozen Aloo Tikki 450g",   unit: "pack", description: "Haldiram aloo tikki — spiced potato cutlets, golden fried in minutes.",      variants: [v("450g", 190, 140),    v("900g", 360, 85)],      soldCount: 185 },
    { name: "Parampara Shahi Paneer Curry",      unit: "pack", description: "Parampara ready-to-cook shahi paneer — rich, creamy restaurant-style curry.", variants: [v("400g", 200, 100),    v("800g", 380, 60)],      soldCount: 145 },
    { name: "Godrej Yummiez Chicken Nuggets",    unit: "pack", description: "Godrej Yummiez golden chicken nuggets — crispy coating, juicy inside.",      variants: [v("250g", 200, 120),    v("500g", 380, 75)],      soldCount: 155 },
    { name: "Venky's Chicken Sausages 250g",     unit: "pack", description: "Venky's classic chicken sausages — great for breakfast or grilling.",        variants: [v("250g", 175, 120),    v("500g", 335, 75)],      soldCount: 140 },
    { name: "ITC Sunfeast Frozen Pizza 270g",    unit: "pack", description: "Sunfeast frozen pizza — thin crust with rich topping, oven-ready.",           variants: [v("270g", 220, 100),    v("2-pack", 420, 60)],    soldCount: 120 },
    { name: "Healthy Alt. Frozen Edamame 400g",  unit: "pack", description: "IQF frozen edamame (baby soybeans) — protein-rich healthy snack.",           variants: [v("400g", 250, 90),     v("800g", 470, 55)],      soldCount: 85  },
    { name: "Pillsbury Frozen Paratha 400g",     unit: "pack", description: "Pillsbury ready-to-cook frozen parathas — flaky, layered, in minutes.",      variants: [v("5pc", 130, 150),     v("10pc", 250, 90)],      soldCount: 210 },
    { name: "Fiesta Frozen Veg Cutlet 400g",     unit: "pack", description: "Vegetable cutlets loaded with carrots, peas, and potatoes, lightly spiced.",  variants: [v("400g", 175, 110),    v("800g", 330, 70)],      soldCount: 125 },
    { name: "Snowman Frozen Broccoli 500g",      unit: "pack", description: "IQF frozen broccoli florets — convenient and retains nutrients perfectly.",   variants: [v("500g", 180, 100),    v("1kg", 340, 60)],       soldCount: 90  },
    { name: "Dr. Oetker Waffle 400g",            unit: "pack", description: "Dr. Oetker Fun Foods Belgian-style waffles — ready to toast and eat.",        variants: [v("400g", 250, 90),     v("2-pack", 470, 55)],    soldCount: 95  },
    { name: "Ledo Frozen Pasta 500g",            unit: "pack", description: "Ledo frozen pasta in creamy white sauce — ready in 10 minutes.",              variants: [v("500g", 220, 90),     v("2-pack", 420, 55)],    soldCount: 80  },
    { name: "Giani's Kulfi Falooda 200g",        unit: "pcs",  description: "Giani's famous kulfi falooda — saffron and pistachio, a true dessert icon.",  variants: [v("1pc", 80, 120),      v("4-pack", 295, 65)],    soldCount: 110 },
    { name: "Daily Delight Jackfruit Biryani",   unit: "pack", description: "Ready-to-eat jackfruit dum biryani — vegan, aromatic and filling.",           variants: [v("250g", 180, 90),     v("500g", 340, 55)],      soldCount: 70  },
    { name: "Tropilicious Acai Bowl 200g",       unit: "pack", description: "Frozen acai blend — rich in antioxidants, ready for smoothie bowls.",         variants: [v("200g", 320, 60),     v("400g", 600, 35)],      soldCount: 45  },
    { name: "Asli Chicken Seekh Kebab 250g",     unit: "pack", description: "Minced chicken seekh kebabs — marinated in traditional Awadhi spices.",       variants: [v("250g", 225, 100),    v("500g", 430, 60)],      soldCount: 105 },
    { name: "Fab India Organic Frozen Corn",     unit: "pack", description: "Organic sweet corn kernels, IQF — sugar-sweet and vibrant golden.",           variants: [v("500g", 160, 100),    v("1kg", 300, 60)],       soldCount: 95  },
  ],

  Bakery: [
    { name: "Britannia 7 Days Croissant",      unit: "pcs",  description: "Buttery, layered croissant with real butter filling — fresh from the pack.",  variants: [v("55g", 25, 300),      v("6-pack", 140, 160)],   soldCount: 280 },
    { name: "Brown Bread (Harvest Gold) 400g", unit: "pack", description: "Harvest Gold whole wheat brown bread — soft, fibrous, and nutritious.",        variants: [v("400g", 45, 300),     v("2-pack", 85, 180)],    soldCount: 310 },
    { name: "Multigrain Bread (Bonn) 400g",    unit: "pack", description: "Bonn multigrain bread — packed with seeds, great for healthy sandwiches.",     variants: [v("400g", 55, 250),     v("2-pack", 105, 150)],   soldCount: 245 },
    { name: "White Bread (Modern) 400g",       unit: "pack", description: "Modern Bakeries soft white bread — fluffy slices for everyday use.",            variants: [v("400g", 38, 350),     v("2-pack", 72, 200)],    soldCount: 370 },
    { name: "Britannia Cake Fruit 65g",        unit: "pcs",  description: "Britannia's soft fruit cake with tutti-frutti and raisin pieces.",             variants: [v("65g", 20, 350),      v("6-pack", 115, 200)],   soldCount: 320 },
    { name: "English Oven Sourdough 400g",     unit: "pack", description: "English Oven rustic sourdough loaf — tangy flavour, chewy crumb.",             variants: [v("400g", 85, 150),     v("2-pack", 160, 90)],    soldCount: 155 },
    { name: "Wonder Bread 500g",               unit: "pack", description: "Classic Wonder Bread — soft enriched white bread loved across generations.",    variants: [v("500g", 48, 280),     v("2-pack", 90, 160)],    soldCount: 290 },
    { name: "Nature's Own Keto Bread 400g",    unit: "pack", description: "Low-carb keto-friendly bread — almond and flaxseed base, soft texture.",       variants: [v("400g", 180, 90),     v("2-pack", 340, 55)],    soldCount: 120 },
    { name: "Bonn Bake Mix Cake 400g",         unit: "pack", description: "Bonn ready-to-bake vanilla cake mix — just add milk and butter.",               variants: [v("400g", 90, 130),     v("800g", 170, 80)],      soldCount: 105 },
    { name: "Bakers Choice Vanilla Muffin 6pc",unit: "pack", description: "Moist vanilla muffins with a golden dome — bakery-fresh taste.",               variants: [v("6pc", 120, 150),     v("12pc", 225, 90)],      soldCount: 175 },
    { name: "Walkers Shortbread Cookies 200g", unit: "pack", description: "Walkers pure butter Scottish shortbread — rich, crumbly, and golden.",          variants: [v("200g", 250, 80, 8),  v("400g", 470, 50, 8)],   soldCount: 130 },
    { name: "Dan Cake Banana 30g",             unit: "pcs",  description: "Dan Cake moist banana cake slice — soft, individually wrapped.",                variants: [v("30g", 15, 300),      v("6-pack", 85, 180)],    soldCount: 220 },
    { name: "Parle Coconut Cookies 200g",      unit: "pack", description: "Parle coconut cookies — crisp, light, and infused with coconut flavour.",       variants: [v("100g", 20, 300),     v("200g", 38, 200)],      soldCount: 250 },
    { name: "Little Hearts Biscuits 120g",     unit: "pack", description: "Britannia Little Hearts — heart-shaped puff pastry biscuits, light and flaky.", variants: [v("75g", 20, 350),      v("120g", 32, 250)],      soldCount: 290 },
    { name: "Pillsbury Banana Bread Mix 225g", unit: "pack", description: "Pillsbury banana bread mix — moist, home-baked banana loaf in minutes.",        variants: [v("225g", 120, 120),    v("450g", 225, 75)],      soldCount: 95  },
    { name: "Morden's Plum Cake 200g",         unit: "pack", description: "Morden's rich plum cake — dense, fruity, perfect for celebrations.",            variants: [v("200g", 180, 100),    v("400g", 340, 60)],      soldCount: 110 },
    { name: "Britannia Nutrichoice Crackers",  unit: "pack", description: "Fibre-rich digestive crackers — great for cheese pairing and healthy snacking.", variants: [v("100g", 45, 250),     v("200g", 85, 160)],      soldCount: 195 },
    { name: "Dukes Wafers Cream Orange 75g",   unit: "pack", description: "Dukes crispy orange cream wafers — light, crunchy, and sweet.",                 variants: [v("75g", 25, 300),      v("150g", 45, 190)],      soldCount: 200 },
    { name: "Glucose Biscuits 400g",           unit: "pack", description: "Classic glucose biscuits — energy-rich, crispy, and affordable.",               variants: [v("200g", 20, 350),     v("400g", 38, 240)],      soldCount: 310 },
    { name: "Anmol Tiger Cream Biscuits",      unit: "pack", description: "Anmol Tiger cream biscuits — fun tiger shape with vanilla cream filling.",      variants: [v("120g", 20, 300),     v("250g", 38, 200)],      soldCount: 195 },
    { name: "Patanjali Doodh Biscuit 200g",    unit: "pack", description: "Patanjali doodh biscuit — made with real milk, crispy and lightly sweet.",      variants: [v("100g", 20, 280),     v("200g", 38, 185)],      soldCount: 175 },
    { name: "Cremica Butter Cookies 200g",     unit: "pack", description: "Cremica butter cookies — rich with real butter, melt-in-mouth texture.",        variants: [v("200g", 75, 180),     v("400g", 140, 110)],     soldCount: 145 },
    { name: "Ginger Honey Cookies 200g",       unit: "pack", description: "Artisan ginger and honey cookies — warming spice with a touch of sweetness.",   variants: [v("200g", 120, 130),    v("400g", 230, 80)],      soldCount: 95  },
    { name: "Mr Brown Coffee Bread 400g",      unit: "pack", description: "Soft coffee-infused bread loaf — aromatic, great for toast.",                   variants: [v("400g", 75, 130),     v("2-pack", 140, 80)],    soldCount: 85  },
    { name: "Generic Garlic Bread Roll 200g",  unit: "pack", description: "Buttery garlic bread rolls — par-baked, ready to heat and serve.",               variants: [v("200g", 80, 150),     v("400g", 150, 90)],      soldCount: 125 },
    { name: "Pillsbury Whole Wheat Rolls 6pc", unit: "pack", description: "Pillsbury whole wheat dinner rolls — soft, wholesome, perfect for meals.",       variants: [v("6pc", 100, 140),     v("12pc", 190, 85)],      soldCount: 110 },
    { name: "Sunfeast Bounce Jelly 18g",       unit: "pcs",  description: "Sunfeast Bounce — jelly-filled soft sponge cake in strawberry and orange.",     variants: [v("18g", 10, 400),      v("6-pack", 55, 220)],    soldCount: 260 },
    { name: "Jimmy's Cocktail Samosa Mini",    unit: "pack", description: "Jimmy's miniature cocktail samosas — crispy, perfect as party starters.",       variants: [v("300g", 180, 120),    v("600g", 340, 75)],      soldCount: 140 },
    { name: "Mother's Recipe Namkeen Mathri",  unit: "pack", description: "Flaky, spiced mathri — traditional North Indian snack-bread, crispy delight.",  variants: [v("200g", 90, 140),     v("400g", 170, 85)],      soldCount: 120 },
    { name: "Monginis Chocolate Truffle",      unit: "pcs",  description: "Monginis choco truffle pastry — moist chocolate sponge, ganache icing.",        variants: [v("1pc", 80, 120),      v("6-pack", 450, 60)],    soldCount: 155 },
  ],

  "Personal Care": [
    { name: "Dove Original Soap 100g",            unit: "g",    description: "Dove 1/4 moisturising cream bar — gentle on skin, leaves it soft.",            variants: [v("100g", 55, 300, 5),  v("3-pack", 155, 180, 5)], soldCount: 350 },
    { name: "Lux Soft Touch Rose 125g",           unit: "g",    description: "Lux rose and almond oil luxury bar — for soft, fragrant skin.",                variants: [v("125g", 45, 280),     v("3-pack", 125, 170)],   soldCount: 300 },
    { name: "Pears Soft & Fresh Soap 125g",       unit: "g",    description: "Pears transparent glycerin soap — 98% pure glycerin, dermatologist-tested.",   variants: [v("75g", 50, 260),      v("125g", 75, 180)],      soldCount: 270 },
    { name: "Lifebuoy Total 125g",                unit: "g",    description: "Lifebuoy Total 10 — kills 99.9% germs, 10-in-1 germ protection.",               variants: [v("125g", 42, 300),     v("3-pack", 118, 190)],   soldCount: 290 },
    { name: "Dettol Original Soap 125g",          unit: "g",    description: "Dettol antiseptic bar soap — 100% original protection against germs.",          variants: [v("125g", 50, 280),     v("3-pack", 140, 175)],   soldCount: 310 },
    { name: "H&S Anti-Dandruff Shampoo 340ml",    unit: "ml",   description: "Head & Shoulders — clinically proven anti-dandruff shampoo, up to 100% flake-free.", variants: [v("180ml", 210, 180, 8), v("340ml", 370, 120, 8)], soldCount: 280 },
    { name: "TRESemmé Moisture Rich 485ml",       unit: "ml",   description: "TRESemmé salon-inspired shampoo — intense hydration for dry, frizzy hair.",     variants: [v("200ml", 180, 170),   v("485ml", 375, 110)],    soldCount: 220 },
    { name: "Pantene Smooth & Sleek 340ml",       unit: "ml",   description: "Pantene Pro-V shampoo — smooths frizz, controls flyaways for sleek hair.",      variants: [v("180ml", 200, 175),   v("340ml", 360, 115)],    soldCount: 240 },
    { name: "Dove Intense Repair Shampoo 340ml",  unit: "ml",   description: "Dove Intense Repair — strengthens hair 10x tougher with keratin actives.",      variants: [v("180ml", 215, 170),   v("340ml", 375, 110)],    soldCount: 255 },
    { name: "Clinic Plus Strong & Long 340ml",    unit: "ml",   description: "Clinic Plus shampoo — nourishes roots and prevents hair fall.",                  variants: [v("175ml", 110, 220),   v("340ml", 195, 140)],    soldCount: 260 },
    { name: "Colgate Total Advanced 150g",        unit: "g",    description: "Colgate Total — antibacterial toothpaste for 12-hour protection.",               variants: [v("75g", 60, 280),      v("150g", 110, 190)],     soldCount: 320 },
    { name: "Sensodyne Whitening 75g",            unit: "g",    description: "Sensodyne Whitening — gentle whitening for sensitive teeth.",                    variants: [v("75g", 150, 180, 5),  v("2-pack", 285, 110, 5)], soldCount: 240 },
    { name: "Closeup Red Hot 200g",               unit: "g",    description: "Closeup Red Hot toothpaste — menthol-fresh breath for confident close-ups.",    variants: [v("80g", 50, 280),      v("200g", 100, 180)],     soldCount: 270 },
    { name: "Oral-B Pro-Health 150g",             unit: "g",    description: "Oral-B toothpaste — freshens breath, removes stains, protects enamel.",         variants: [v("75g", 65, 250),      v("150g", 120, 165)],     soldCount: 230 },
    { name: "Pepsodent Whitening 150g",           unit: "g",    description: "Pepsodent Whitening Plus — removes yellow stains for visibly whiter teeth.",    variants: [v("80g", 48, 260),      v("150g", 88, 175)],      soldCount: 215 },
    { name: "Gillette Mach3 Razor 2pc",           unit: "pack", description: "Gillette Mach3 — 3-blade precision razor for a smooth, close shave.",           variants: [v("2pc", 330, 120, 5),  v("4pc", 620, 75, 5)],    soldCount: 180 },
    { name: "Veet Hair Removal Cream 50g",        unit: "g",    description: "Veet sensitive skin hair removal cream — fast-acting, gentle formula.",         variants: [v("50g", 105, 180),     v("200g", 380, 100)],     soldCount: 195 },
    { name: "Neutrogena Face Wash 100ml",         unit: "ml",   description: "Neutrogena oil-free acne face wash — removes oil, unclogs pores.",              variants: [v("100ml", 390, 120, 8), v("200ml", 730, 70, 8)],  soldCount: 165 },
    { name: "Himalaya Neem Face Wash 150ml",      unit: "ml",   description: "Himalaya purifying neem face wash — removes impurities, prevents pimples.",     variants: [v("100ml", 95, 200),    v("150ml", 130, 140)],    soldCount: 285 },
    { name: "Pond's White Beauty Face Wash 100ml",unit: "ml",   description: "Pond's White Beauty — brightening face wash for spot-less radiant skin.",       variants: [v("50ml", 70, 220),     v("100ml", 125, 150)],    soldCount: 200 },
    { name: "Nivea Body Lotion 600ml",            unit: "ml",   description: "Nivea Milk & Honey body lotion — 48h moisture for silky smooth skin.",          variants: [v("200ml", 175, 180),   v("600ml", 445, 110)],    soldCount: 210 },
    { name: "Vaseline Intensive Care 300ml",      unit: "ml",   description: "Vaseline cocoa radiant lotion — deeply nourishes and adds luminous glow.",      variants: [v("200ml", 155, 190),   v("300ml", 210, 130)],    soldCount: 225 },
    { name: "Lakme Sun Expert SPF50 100ml",       unit: "ml",   description: "Lakmé Sun Expert — lightweight SPF 50 PA+++ sunscreen, non-greasy.",            variants: [v("50ml", 210, 160, 5), v("100ml", 375, 100, 5)], soldCount: 195 },
    { name: "Garnier Micellar Water 125ml",       unit: "ml",   description: "Garnier SkinActive Micellar Water — no-rinse makeup remover and cleanser.",     variants: [v("125ml", 195, 150),   v("400ml", 545, 90)],     soldCount: 175 },
    { name: "Simple Kind To Skin Moisturiser",    unit: "ml",   description: "Simple hydrating light moisturiser — 100% skin-loving ingredients, no fragrance.", variants: [v("125ml", 330, 130, 5), v("250ml", 590, 80, 5)], soldCount: 155 },
    { name: "Whisper Ultra Soft XL Pads 15pc",   unit: "pack", description: "Whisper Ultra Soft XL — extra-large pads with 5x dry protection.",              variants: [v("15pc", 90, 200),     v("30pc", 170, 130)],     soldCount: 250 },
    { name: "Stayfree Secure All Night 8pc",      unit: "pack", description: "Stayfree Secure Nights — extra absorption, anti-leak for peaceful sleep.",       variants: [v("8pc", 85, 190),      v("16pc", 160, 120)],     soldCount: 220 },
    { name: "Kotex Ultra Thin Regular 20pc",      unit: "pack", description: "Kotex Ultra Thin — breathable wings for comfortable, discreet protection.",      variants: [v("20pc", 110, 180),    v("40pc", 205, 110)],     soldCount: 200 },
    { name: "Pampers Baby Dry Diapers S 78pc",    unit: "pack", description: "Pampers Baby-Dry — up to 12h dryness with 3 layers of absorbency.",             variants: [v("22pc", 299, 130, 5), v("78pc", 899, 70, 5)],   soldCount: 185 },
    { name: "Huggies Dry Pants M 54pc",           unit: "pack", description: "Huggies Dry Pants — bubble bed for softer sleep, flexible waistband.",           variants: [v("18pc", 250, 140, 5), v("54pc", 700, 80, 5)],   soldCount: 160 },
  ],
};

// ---------------------------------------------------------------------------
// isFeatured / isTrending distribution
// Exactly 20 featured and 20 trending products, spread across all categories.
// We track by (categoryName, productIndex within that category).
// ---------------------------------------------------------------------------

// 2 featured + 2 trending per category = 20 each across 10 categories
const FEATURED_INDICES = {
  "Vegetables":    [0, 2],
  "Fruits":        [0, 2],
  "Groceries":     [0, 5],
  "Beverages":     [0, 8],
  "Snacks":        [0, 5],
  "Dairy":         [0, 3],
  "Household":     [0, 5],
  "Frozen Foods":  [0, 8],
  "Bakery":        [0, 3],
  "Personal Care": [0, 4],
};

const TRENDING_INDICES = {
  "Vegetables":    [1, 27],
  "Fruits":        [1, 12],
  "Groceries":     [1, 14],
  "Beverages":     [1, 14],
  "Snacks":        [1, 4],
  "Dairy":         [1, 16],
  "Household":     [1, 11],
  "Frozen Foods":  [1, 14],
  "Bakery":        [1, 3],
  "Personal Care": [1, 11],
};

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------
const BANNERS = [
  {
    image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/pot-mussels.jpg?v=banner1",
    target: null,
    order: 0,
    isActive: true,
  },
  {
    image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/spices.jpg?v=banner2",
    target: null,
    order: 1,
    isActive: true,
  },
  {
    image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/food/fish-vegetables.jpg?v=banner3",
    target: null,
    order: 2,
    isActive: true,
  },
  {
    image: "https://res.cloudinary.com/demo/image/upload/w_800,h_300,c_fill/samples/ecommerce/accessories-bag.jpg?v=banner4",
    target: null,
    order: 3,
    isActive: true,
  },
];

// ---------------------------------------------------------------------------
// Offers (built after categories are fetched so we can fill scopeId)
// ---------------------------------------------------------------------------
function buildOffers(categoryMap) {
  const now = Date.now();
  const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
  return [
    {
      code: "FLAT10OFF",
      kind: OFFER_KIND.FLAT,
      value: 10,
      scope: OFFER_SCOPE.CART,
      scopeId: null,
      minValue: 100,
      maxDiscount: null,
      validFrom: now,
      validTo: now + sixMonths,
      isActive: true,
    },
    {
      code: "FRESH20",
      kind: OFFER_KIND.PERCENT,
      value: 20,
      scope: OFFER_SCOPE.CATEGORY,
      scopeId: categoryMap["Vegetables"] || null,
      minValue: 0,
      maxDiscount: 100,
      validFrom: now,
      validTo: now + sixMonths,
      isActive: true,
    },
    {
      code: "WELCOME50",
      kind: OFFER_KIND.FLAT,
      value: 50,
      scope: OFFER_SCOPE.CART,
      scopeId: null,
      minValue: 300,
      maxDiscount: null,
      validFrom: now,
      validTo: now + sixMonths,
      isActive: true,
    },
    {
      code: "SNACK15",
      kind: OFFER_KIND.PERCENT,
      value: 15,
      scope: OFFER_SCOPE.CATEGORY,
      scopeId: categoryMap["Snacks"] || null,
      minValue: 0,
      maxDiscount: 80,
      validFrom: now,
      validTo: now + sixMonths,
      isActive: true,
    },
    {
      code: "FIRSTORDER",
      kind: OFFER_KIND.FLAT,
      value: 100,
      scope: OFFER_SCOPE.CART,
      scopeId: null,
      minValue: 500,
      maxDiscount: null,
      validFrom: now,
      validTo: now + sixMonths,
      isActive: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Delivery Partners
// ---------------------------------------------------------------------------
const DELIVERY_PARTNERS = [
  {
    name: "Ravi Kumar",
    mobile: "9876543210",
    isActive: true,
    fcmTokens: [],
    currentOrders: [],
  },
  {
    name: "Suresh Yadav",
    mobile: "9123456780",
    isActive: true,
    fcmTokens: [],
    currentOrders: [],
  },
];

// ---------------------------------------------------------------------------
// Main seeding function
// ---------------------------------------------------------------------------
async function seedProducts() {
  const firestore = db();
  const now = Date.now();

  // ── 1. Seed-lock check ─────────────────────────────────────────────────────
  console.log("Checking seed lock...");
  const lockDoc = await firestore.collection(COLLECTIONS.CONFIG).doc("global").get();
  if (lockDoc.exists && lockDoc.data().productsSeeded === true) {
    console.log("✓ Products already seeded (seed lock set). Skipping.");
    process.exit(0);
  }

  // ── 2. Also check actual product count as a safety net ────────────────────
  const productCountSnap = await firestore.collection(COLLECTIONS.PRODUCTS).limit(1).get();
  if (!productCountSnap.empty) {
    console.log("✓ Products collection is not empty. Skipping to avoid duplicates.");
    process.exit(0);
  }

  // ── 3. Fetch all categories and build name → id map ───────────────────────
  console.log("\nFetching categories...");
  const catSnap = await firestore.collection(COLLECTIONS.CATEGORIES).get();
  if (catSnap.empty) {
    console.error("✗ No categories found. Run `npm run seed` first to create categories.");
    process.exit(1);
  }

  /** @type {Record<string, string>} name -> Firestore doc ID */
  const categoryMap = {};
  catSnap.docs.forEach((doc) => {
    categoryMap[doc.data().name] = doc.id;
  });

  console.log(`Found ${Object.keys(categoryMap).length} categories: ${Object.keys(categoryMap).join(", ")}`);

  const expectedCategories = Object.keys(CATALOGUE);
  const missingCategories = expectedCategories.filter((c) => !categoryMap[c]);
  if (missingCategories.length > 0) {
    console.error(`✗ Missing categories in Firestore: ${missingCategories.join(", ")}`);
    console.error("  Run `npm run seed` first or ensure categories exist.");
    process.exit(1);
  }

  // ── 4. Seed products by category ──────────────────────────────────────────
  console.log("\nSeeding products...");
  let totalSeeded = 0;

  for (const [categoryName, products] of Object.entries(CATALOGUE)) {
    const categoryId = categoryMap[categoryName];
    const imgKey = {
      "Vegetables": "vegetables",
      "Fruits": "fruits",
      "Groceries": "groceries",
      "Beverages": "beverages",
      "Snacks": "snacks",
      "Dairy": "dairy",
      "Household": "household",
      "Frozen Foods": "frozen",
      "Bakery": "bakery",
      "Personal Care": "personalCare",
    }[categoryName];

    const featuredSet = new Set(FEATURED_INDICES[categoryName] || []);
    const trendingSet = new Set(TRENDING_INDICES[categoryName] || []);

    // Check if this category already has products (idempotency per category)
    const existingSnap = await firestore
      .collection(COLLECTIONS.PRODUCTS)
      .where("categoryId", "==", categoryId)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      console.log(`  [SKIP] ${categoryName} — already has products`);
      totalSeeded += products.length;
      continue;
    }

    console.log(`  Seeding ${categoryName} (${products.length} products, categoryId: ${categoryId})...`);

    // Use batched writes — max 500 ops per batch, but 30 products is safe.
    const batch = firestore.batch();

    products.forEach((product, idx) => {
      const docRef = firestore.collection(COLLECTIONS.PRODUCTS).doc();
      const imageUrl = IMG[imgKey];
      const docData = {
        name: product.name,
        description: product.description || "",
        categoryId,
        unit: product.unit,
        images: imgs(imageUrl, 2),
        variants: product.variants,
        availability: AVAILABILITY.AVAILABLE,
        isAvailableToday: true,
        isFeatured: featuredSet.has(idx),
        isTrending: trendingSet.has(idx),
        soldCount: product.soldCount,
        createdAt: now,
        updatedAt: now,
      };
      batch.set(docRef, docData);
    });

    await batch.commit();
    totalSeeded += products.length;
    console.log(`  ✓ ${categoryName}: ${products.length} products written`);
  }

  console.log(`\nTotal products seeded: ${totalSeeded}`);

  // ── 5. Seed banners ───────────────────────────────────────────────────────
  console.log("\nSeeding banners...");
  const bannerCountSnap = await firestore.collection(COLLECTIONS.BANNERS).limit(1).get();
  if (!bannerCountSnap.empty) {
    console.log("  [SKIP] Banners already exist");
  } else {
    const bannerBatch = firestore.batch();
    BANNERS.forEach((banner) => {
      const docRef = firestore.collection(COLLECTIONS.BANNERS).doc();
      bannerBatch.set(docRef, { ...banner, createdAt: now });
    });
    await bannerBatch.commit();
    console.log(`  ✓ ${BANNERS.length} banners seeded`);
  }

  // ── 6. Seed offers ────────────────────────────────────────────────────────
  console.log("\nSeeding offers...");
  const offerCountSnap = await firestore.collection(COLLECTIONS.OFFERS).limit(1).get();
  if (!offerCountSnap.empty) {
    console.log("  [SKIP] Offers already exist");
  } else {
    const offers = buildOffers(categoryMap);
    const offerBatch = firestore.batch();
    offers.forEach((offer) => {
      const docRef = firestore.collection(COLLECTIONS.OFFERS).doc();
      offerBatch.set(docRef, offer);
    });
    await offerBatch.commit();
    console.log(`  ✓ ${offers.length} offers seeded`);
  }

  // ── 7. Seed delivery partners ─────────────────────────────────────────────
  console.log("\nSeeding delivery partners...");
  const partnerCountSnap = await firestore.collection(COLLECTIONS.DELIVERY_PARTNERS).limit(1).get();
  if (!partnerCountSnap.empty) {
    console.log("  [SKIP] Delivery partners already exist");
  } else {
    const partnerBatch = firestore.batch();
    DELIVERY_PARTNERS.forEach((partner) => {
      const docRef = firestore.collection(COLLECTIONS.DELIVERY_PARTNERS).doc();
      partnerBatch.set(docRef, { ...partner, createdAt: now });
    });
    await partnerBatch.commit();
    console.log(`  ✓ ${DELIVERY_PARTNERS.length} delivery partners seeded`);
  }

  // ── 8. Set seed lock ──────────────────────────────────────────────────────
  await firestore.collection(COLLECTIONS.CONFIG).doc("global").set(
    { productsSeeded: true, productsSeededAt: now },
    { merge: true }
  );
  console.log("\n✓ Seed lock written to config/global.productsSeeded");

  console.log("\n============================================================");
  console.log("  SupaMart product seed complete!");
  console.log(`  Products : ${totalSeeded}`);
  console.log(`  Banners  : ${BANNERS.length}`);
  console.log(`  Offers   : 5`);
  console.log(`  Partners : ${DELIVERY_PARTNERS.length}`);
  console.log("============================================================\n");

  process.exit(0);
}

seedProducts().catch((err) => {
  console.error("\n✗ Seed failed:", err.message || err);
  console.error(err.stack);
  process.exit(1);
});
