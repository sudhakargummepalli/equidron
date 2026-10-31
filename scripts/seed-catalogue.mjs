// A wider demo catalogue: more categories, with prices, stock and generated images.
//
// The shop's categories are the categories of its live products, so "add a category" only means anything if
// something in it can actually be bought. Each item below becomes a product, an active offer from the given
// shop, and stock at that shop's warehouse - the same three rows a seller's own submission would create.
//
// Safe to run twice: products are matched by title, offers by (product, seller, condition).
//
//   node scripts/seed-catalogue.mjs
import pg from "pg";

const URL = process.env.DATABASE_URL_PG || "postgres://equidron:equidron-local@127.0.0.1:5432/equidron_live";
const SHOP_ID = Number(process.env.SEED_SHOP_ID || 6);   // the owner's shop
const UNITS = Number(process.env.SEED_UNITS || 25);

const ITEMS = [
  // existing categories, so the shelves are not one item deep
  ["Phones", "Orbit Nova X5 5G Smartphone (8GB RAM, 128GB, Midnight Blue)", "Orbit", 1899900, "A 6.7-inch 5G phone with a 5000 mAh battery, 50 MP main camera and 128 GB storage."],
  ["Phones", "Kestrel K12 Lite Smartphone (4GB RAM, 64GB, Charcoal)", "Kestrel", 899900, "An everyday 4G phone with a 6.5-inch display, 5000 mAh battery and dual SIM."],
  ["Laptops", "VoltBook Air 14 (Ryzen 5, 16GB, 512GB SSD)", "VoltBook", 6299900, "A 14-inch thin laptop for study and work, with a backlit keyboard and 10-hour battery."],
  ["Laptops", "VoltBook Game 15 (Core i7, 16GB, 1TB SSD, RTX)", "VoltBook", 11499900, "A 15-inch gaming laptop with a 144 Hz screen and a discrete graphics card."],
  ["Audio", "PulseBuds Air Wireless Earbuds with Charging Case", "PulseBuds", 249900, "True wireless earbuds with 24 hours of playtime including the case, and IPX4 splash resistance."],
  ["Audio", "PulseBuds Studio Over-Ear Headphones", "PulseBuds", 799900, "Over-ear headphones with active noise cancellation and 40 hours of battery."],
  ["Wearables", "PulseWatch S2 Smartwatch (AMOLED, SpO2)", "Pulse", 449900, "A 1.4-inch AMOLED smartwatch with heart rate, SpO2 and seven-day battery life."],
  ["Home & Kitchen", "SteelCore Pressure Cooker 5L (Induction Ready)", "SteelCore", 279900, "A five-litre stainless steel pressure cooker that works on induction and gas."],
  ["Home & Kitchen", "SteelCore Non-Stick Frying Pan 24cm", "SteelCore", 89900, "A 24 cm non-stick pan with a stay-cool handle, suitable for gas and induction."],
  ["Grocery", "Organic Toor Dal 1kg", "FarmFresh", 18900, "Unpolished toor dal from a single farm, cleaned and packed in a one-kilo pouch."],
  ["Grocery", "Malnad Estate Filter Coffee Powder 500g", "Malnad", 42500, "Medium-roast filter coffee powder, 80 percent coffee and 20 percent chicory."],
  ["Fashion", "Cotton Kurta for Men (Full Sleeve, White)", "Loomcraft", 129900, "A full-sleeve cotton kurta with a mandarin collar, machine washable."],
  ["Fashion", "Everyday Canvas Sneakers (Unisex)", "Stride", 179900, "Canvas sneakers with a cushioned insole and a rubber sole, unisex sizing."],
  ["Books", "The Quiet Algorithm (Paperback)", "PageTurner", 49900, "A readable introduction to how recommendation systems decide what you see."],
  ["Gadgets", "ArmorLite Clear Case for Orbit Nova X5", "ArmorLite", 49900, "A clear shockproof case with a matte back that works with wireless charging."],

  // new categories
  ["Sports & Fitness", "FlexGrip Yoga Mat 6mm with Carry Strap", "FlexGrip", 129900, "A 6 mm non-slip yoga mat with a carry strap, easy to wipe clean."],
  ["Sports & Fitness", "IronCore Adjustable Dumbbell Set 20kg", "IronCore", 449900, "A pair of adjustable dumbbells with plates, for home strength training."],
  ["Toys & Baby", "Wooden Stacking Rings (6 Pieces)", "TinyNest", 74900, "Six painted wooden rings on a peg, for toddlers learning size and order."],
  ["Toys & Baby", "Baby Muslin Swaddle Wrap (Pack of 3)", "TinyNest", 99900, "Three breathable cotton muslin wraps, soft after washing."],
  ["Beauty & Personal Care", "Gentle Face Wash for Oily Skin 150ml", "ClearLeaf", 34900, "A gel face wash with salicylic acid, fragrance free, for daily use."],
  ["Beauty & Personal Care", "Aloe Hydrating Gel 200ml", "ClearLeaf", 27900, "A light aloe gel for after sun and everyday moisturising."],
  ["Kitchen Appliances", "BrewMate Drip Coffee Maker 600ml", "BrewMate", 199900, "A 600 ml drip coffee maker with a keep-warm plate and a reusable filter."],
  ["Kitchen Appliances", "MixMate Hand Blender 300W", "MixMate", 159900, "A 300 watt hand blender with a whisk and a chopping attachment."],
  ["Office & Stationery", "A5 Hardbound Notebook (Dotted, 200 pages)", "PaperMill", 39900, "A dotted A5 notebook with a hard cover and a ribbon marker."],
  ["Office & Stationery", "Gel Pens, Pack of 10 (Blue)", "PaperMill", 19900, "Ten smooth gel pens with a 0.7 mm tip, blue ink."],
  ["Pet Supplies", "Stainless Steel Pet Bowl (Large)", "PawCare", 44900, "A one-litre stainless steel bowl with a non-slip rubber base."],
  ["Pet Supplies", "Rope Tug Toy for Dogs", "PawCare", 24900, "A braided cotton rope toy for tug and fetch, machine washable."],
  ["Automotive", "Car Phone Holder with Suction Mount", "RoadMate", 69900, "A suction-mount phone holder with a 360-degree ball joint."],
  ["Automotive", "Tyre Inflator with Digital Gauge", "RoadMate", 189900, "A portable tyre inflator with a digital gauge and an auto-stop pressure setting."],
  ["Garden & Outdoor", "Terracotta Planter Set (3 Sizes)", "GreenLeaf", 89900, "Three unglazed terracotta planters with drainage holes and saucers."],
  ["Garden & Outdoor", "Pruning Shears with Safety Lock", "GreenLeaf", 59900, "Bypass pruning shears with a steel blade and a thumb lock."],
  ["Musical Instruments", "Acoustic Guitar for Beginners (38 inch)", "StringTown", 549900, "A 38-inch acoustic guitar with a spruce top, a gig bag and a strap."],
  ["Musical Instruments", "Digital Keyboard 61 Keys", "StringTown", 899900, "A 61-key digital keyboard with 100 voices, a metronome and a headphone jack."],
];

const client = new pg.Client({ connectionString: URL });
await client.connect();

const shop = (await client.query("SELECT id, name FROM sellers WHERE id = $1", [SHOP_ID])).rows[0];
if (!shop) throw new Error(`no shop ${SHOP_ID}`);
await client.query("BEGIN");

let warehouse = (await client.query("SELECT MIN(id) AS id FROM warehouses WHERE seller_id = $1", [SHOP_ID])).rows[0].id;
if (!warehouse) {
  warehouse = (await client.query(
    "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES ($1, $2, 'Bengaluru', 'seller_dispatch', $3) RETURNING id",
    ["S-" + SHOP_ID, shop.name + " dispatch", SHOP_ID])).rows[0].id;
}

let added = 0, touched = 0;
for (const [category, title, brand, pricePaise, description] of ITEMS) {
  let product = (await client.query("SELECT id FROM products WHERE title = $1", [title])).rows[0];
  if (!product) {
    product = (await client.query(
      `INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, is_sample, created_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, '[]'::jsonb, 10, 'live', true, now()) RETURNING id`,
      [title, brand, category, description])).rows[0];
    // The catalogue draws its own picture from the product id; no photo upload needed for sample stock.
    await client.query("UPDATE products SET images = to_jsonb(ARRAY['/img/p' || id || '-1.svg']) WHERE id = $1", [product.id]);
    added++;
  }

  const offer = (await client.query(
    `INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at)
     VALUES ($1, $2, $3, $4, 'new', 'seller', 1, 'active', now())
     ON CONFLICT (product_id, seller_id, condition) DO UPDATE
       SET price_paise = EXCLUDED.price_paise, status = 'active', updated_at = now()
     RETURNING id`,
    [product.id, SHOP_ID, pricePaise, Math.round(pricePaise * 1.2)])).rows[0];

  await client.query(
    `INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES ($1, $2, $3, 0)
     ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = EXCLUDED.on_hand`,
    [offer.id, warehouse, UNITS]);
  touched++;
}

await client.query("COMMIT");

const summary = (await client.query(
  `SELECT COUNT(DISTINCT category) AS categories, COUNT(*) AS products
   FROM products p WHERE p.status = 'live'
     AND EXISTS (SELECT 1 FROM offers o WHERE o.product_id = p.id AND o.status = 'active')`)).rows[0];
console.log(`seeded: ${added} new products, ${touched} listings stocked at ${shop.name}`);
console.log(`catalogue now: ${summary.products} buyable products in ${summary.categories} categories`);
await client.end();
