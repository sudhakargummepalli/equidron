-- A wider demo catalogue, in plain SQL, so seeding needs nothing but psql.
--
--   psql -U equidron -h 127.0.0.1 -d equidron_live -f scripts/seed-catalogue.sql
--
-- Each item becomes a product, an active offer from shop 6, and 25 units at that shop's warehouse: the same
-- three rows a seller's own submission creates. Safe to run twice - products match on title, offers on
-- (product, seller, condition).

BEGIN;

CREATE TEMP TABLE seed_items (category text, title text, brand text, price_paise bigint, description text) ON COMMIT DROP;
INSERT INTO seed_items VALUES
  ('Phones', 'Orbit Nova X5 5G Smartphone (8GB RAM, 128GB, Midnight Blue)', 'Orbit', 1899900, 'A 6.7-inch 5G phone with a 5000 mAh battery, 50 MP main camera and 128 GB storage.'),
  ('Phones', 'Kestrel K12 Lite Smartphone (4GB RAM, 64GB, Charcoal)', 'Kestrel', 899900, 'An everyday 4G phone with a 6.5-inch display, 5000 mAh battery and dual SIM.'),
  ('Laptops', 'VoltBook Air 14 (Ryzen 5, 16GB, 512GB SSD)', 'VoltBook', 6299900, 'A 14-inch thin laptop for study and work, with a backlit keyboard and 10-hour battery.'),
  ('Laptops', 'VoltBook Game 15 (Core i7, 16GB, 1TB SSD, RTX)', 'VoltBook', 11499900, 'A 15-inch gaming laptop with a 144 Hz screen and a discrete graphics card.'),
  ('Audio', 'PulseBuds Air Wireless Earbuds with Charging Case', 'PulseBuds', 249900, 'True wireless earbuds with 24 hours of playtime including the case, and IPX4 splash resistance.'),
  ('Audio', 'PulseBuds Studio Over-Ear Headphones', 'PulseBuds', 799900, 'Over-ear headphones with active noise cancellation and 40 hours of battery.'),
  ('Wearables', 'PulseWatch S2 Smartwatch (AMOLED, SpO2)', 'Pulse', 449900, 'A 1.4-inch AMOLED smartwatch with heart rate, SpO2 and seven-day battery life.'),
  ('Home & Kitchen', 'SteelCore Pressure Cooker 5L (Induction Ready)', 'SteelCore', 279900, 'A five-litre stainless steel pressure cooker that works on induction and gas.'),
  ('Home & Kitchen', 'SteelCore Non-Stick Frying Pan 24cm', 'SteelCore', 89900, 'A 24 cm non-stick pan with a stay-cool handle, suitable for gas and induction.'),
  ('Grocery', 'Organic Toor Dal 1kg', 'FarmFresh', 18900, 'Unpolished toor dal from a single farm, cleaned and packed in a one-kilo pouch.'),
  ('Grocery', 'Malnad Estate Filter Coffee Powder 500g', 'Malnad', 42500, 'Medium-roast filter coffee powder, 80 percent coffee and 20 percent chicory.'),
  ('Fashion', 'Cotton Kurta for Men (Full Sleeve, White)', 'Loomcraft', 129900, 'A full-sleeve cotton kurta with a mandarin collar, machine washable.'),
  ('Fashion', 'Everyday Canvas Sneakers (Unisex)', 'Stride', 179900, 'Canvas sneakers with a cushioned insole and a rubber sole, unisex sizing.'),
  ('Books', 'The Quiet Algorithm (Paperback)', 'PageTurner', 49900, 'A readable introduction to how recommendation systems decide what you see.'),
  ('Gadgets', 'ArmorLite Clear Case for Orbit Nova X5', 'ArmorLite', 49900, 'A clear shockproof case with a matte back that works with wireless charging.'),
  ('Sports & Fitness', 'FlexGrip Yoga Mat 6mm with Carry Strap', 'FlexGrip', 129900, 'A 6 mm non-slip yoga mat with a carry strap, easy to wipe clean.'),
  ('Sports & Fitness', 'IronCore Adjustable Dumbbell Set 20kg', 'IronCore', 449900, 'A pair of adjustable dumbbells with plates, for home strength training.'),
  ('Toys & Baby', 'Wooden Stacking Rings (6 Pieces)', 'TinyNest', 74900, 'Six painted wooden rings on a peg, for toddlers learning size and order.'),
  ('Toys & Baby', 'Baby Muslin Swaddle Wrap (Pack of 3)', 'TinyNest', 99900, 'Three breathable cotton muslin wraps, soft after washing.'),
  ('Beauty & Personal Care', 'Gentle Face Wash for Oily Skin 150ml', 'ClearLeaf', 34900, 'A gel face wash with salicylic acid, fragrance free, for daily use.'),
  ('Beauty & Personal Care', 'Aloe Hydrating Gel 200ml', 'ClearLeaf', 27900, 'A light aloe gel for after sun and everyday moisturising.'),
  ('Kitchen Appliances', 'BrewMate Drip Coffee Maker 600ml', 'BrewMate', 199900, 'A 600 ml drip coffee maker with a keep-warm plate and a reusable filter.'),
  ('Kitchen Appliances', 'MixMate Hand Blender 300W', 'MixMate', 159900, 'A 300 watt hand blender with a whisk and a chopping attachment.'),
  ('Office & Stationery', 'A5 Hardbound Notebook (Dotted, 200 pages)', 'PaperMill', 39900, 'A dotted A5 notebook with a hard cover and a ribbon marker.'),
  ('Office & Stationery', 'Gel Pens, Pack of 10 (Blue)', 'PaperMill', 19900, 'Ten smooth gel pens with a 0.7 mm tip, blue ink.'),
  ('Pet Supplies', 'Stainless Steel Pet Bowl (Large)', 'PawCare', 44900, 'A one-litre stainless steel bowl with a non-slip rubber base.'),
  ('Pet Supplies', 'Rope Tug Toy for Dogs', 'PawCare', 24900, 'A braided cotton rope toy for tug and fetch, machine washable.'),
  ('Automotive', 'Car Phone Holder with Suction Mount', 'RoadMate', 69900, 'A suction-mount phone holder with a 360-degree ball joint.'),
  ('Automotive', 'Tyre Inflator with Digital Gauge', 'RoadMate', 189900, 'A portable tyre inflator with a digital gauge and an auto-stop pressure setting.'),
  ('Garden & Outdoor', 'Terracotta Planter Set (3 Sizes)', 'GreenLeaf', 89900, 'Three unglazed terracotta planters with drainage holes and saucers.'),
  ('Garden & Outdoor', 'Pruning Shears with Safety Lock', 'GreenLeaf', 59900, 'Bypass pruning shears with a steel blade and a thumb lock.'),
  ('Musical Instruments', 'Acoustic Guitar for Beginners (38 inch)', 'StringTown', 549900, 'A 38-inch acoustic guitar with a spruce top, a gig bag and a strap.'),
  ('Musical Instruments', 'Digital Keyboard 61 Keys', 'StringTown', 899900, 'A 61-key digital keyboard with 100 voices, a metronome and a headphone jack.');

INSERT INTO warehouses (code, name, city, kind, seller_id)
SELECT 'S-' || s.id, 'Dispatch ' || s.id, 'Bengaluru', 'seller_dispatch', s.id
FROM sellers s
WHERE s.id = 6 AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.seller_id = s.id);

INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, is_sample, created_at)
SELECT i.title, i.brand, i.category, i.description, '{}'::jsonb, '[]'::jsonb, 10, 'live', true, now()
FROM seed_items i
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.title = i.title);

-- The catalogue draws its own picture from the product id, so it is filled in once the row exists.
UPDATE products p SET images = to_jsonb(ARRAY['/img/p' || p.id || '-1.svg'])
WHERE (p.images = '[]'::jsonb OR p.images IS NULL)
  AND EXISTS (SELECT 1 FROM seed_items i WHERE i.title = p.title);

INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, updated_at)
SELECT p.id, 6, i.price_paise, ROUND(i.price_paise * 1.2), 'new', 'seller', 1, 'active', now()
FROM seed_items i JOIN products p ON p.title = i.title
ON CONFLICT (product_id, seller_id, condition) DO UPDATE
  SET price_paise = EXCLUDED.price_paise, status = 'active', updated_at = now();

INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved)
SELECT o.id, (SELECT id FROM warehouses WHERE seller_id = o.seller_id ORDER BY id LIMIT 1), 25, 0
FROM offers o
WHERE o.seller_id = 6 AND o.status = 'active'
ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = EXCLUDED.on_hand;

COMMIT;

SELECT COUNT(DISTINCT p.category) AS categories, COUNT(*) AS buyable
FROM products p
WHERE p.status = 'live' AND EXISTS (SELECT 1 FROM offers o WHERE o.product_id = p.id AND o.status = 'active');
