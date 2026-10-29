// Seed the Java database with a small, real demo catalogue.
//
// The Java side needs PostgreSQL, while the marketplace's rich sample data lives in the Node PGlite
// file. Rather than translate every table, this seeds what a person needs to walk through the Java
// store: two sellers, six products, offers, stock and one demo customer whose password the Node and
// Java servers both understand.
//
// Run: node scripts/seed-java-db.mjs   (DATABASE_URL or the defaults below)
import crypto from 'node:crypto';
import pg from 'pg';

const url = process.env.JAVA_DB_URL_PG || 'postgres://equidron:equidron-local@127.0.0.1:5432/equidron';
const client = new pg.Client({ connectionString: url });

// scrypt in the Node format the Java checker reads: algo, hex salt, hex hash.
function password(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, 32, { N: 16384, r: 8, p: 5 });
  return { algo: 'scrypt:16384:8:5', salt: salt.toString('hex'), hash: key.toString('hex') };
}

const sellers = [
  { email: 'java.techbazaar@example.com', name: 'TechBazaar', city: 'Bengaluru', rating: 4.6, count: 812 },
  { email: 'java.greenleaf@example.com', name: 'GreenLeaf Home', city: 'Mumbai', rating: 4.3, count: 214 },
];

const products = [
  ['Orbit Nova X5 5G Smartphone', 'Orbit', 'Phones', 1899900, 2199900],
  ['Kestrel K20 Smartphone', 'Kestrel', 'Phones', 1249900, 1499900],
  ['Bassline Mini Bluetooth Speaker', 'Bassline', 'Audio', 349900, 449900],
  ['Aurora 14 Ultrabook (16GB)', 'Aurora', 'Laptops', 6299900, 6999900],
  ['Heritage Steel Pressure Cooker 5L', 'Heritage', 'Home & Kitchen', 219900, 259900],
  ['Organic Toor Dal, 1 kg', 'GreenLeaf', 'Grocery', 18900, 21000],
];

await client.connect();
const pw = password('equidron-demo');

for (const s of sellers) {
  await client.query(
    `INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at)
     VALUES ($1,$2,'seller',$3,$4,$5, now()) ON CONFLICT (email) DO NOTHING`,
    [s.email, s.name, pw.algo, pw.salt, pw.hash]);
  const user = await client.query('SELECT id FROM users WHERE email = $1', [s.email]);
  await client.query(
    `INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample)
     VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (user_id) DO NOTHING`,
    [user.rows[0].id, s.name, s.rating, s.count, s.city]);
  const shop = await client.query('SELECT id FROM sellers WHERE user_id = $1', [user.rows[0].id]);
  await client.query(
    `INSERT INTO warehouses (code, name, city, kind, seller_id)
     VALUES ($1,$2,$3,'seller_dispatch',$4) ON CONFLICT (code) DO NOTHING`,
    ['S-' + s.name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8), s.name + ' dispatch', s.city, shop.rows[0].id]);
}

const shops = await client.query(
  "SELECT s.id, w.id AS warehouse_id, w.city FROM sellers s JOIN users u ON u.id = s.user_id " +
  "JOIN warehouses w ON w.seller_id = s.id WHERE u.email LIKE 'java.%' ORDER BY s.id");
for (let i = 0; i < products.length; i++) {
  const [title, brand, category, price, mrp] = products[i];
  const shop = shops.rows[i % shops.rows.length];
  await client.query(
    `INSERT INTO products (title, brand, category, description, specs, images, return_window_days, status, is_sample, created_at)
     VALUES ($1,$2,$3,$4,'{}','[]',7,'live',true, now())`,
    [title, brand, category, `${title} — sample data for the Java store.`]);
  const product = await client.query('SELECT id FROM products WHERE title = $1 ORDER BY id DESC LIMIT 1', [title]);
  await client.query(
    `INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days, status, is_sample, updated_at)
     VALUES ($1,$2,$3,$4,'new','seller',1,'active',true, now())`,
    [product.rows[0].id, shop.id, price, mrp]);
  const offer = await client.query('SELECT id FROM offers WHERE product_id = $1 ORDER BY id DESC LIMIT 1', [product.rows[0].id]);
  await client.query(
    `INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved)
     VALUES ($1,$2,25,0) ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = 25`,
    [offer.rows[0].id, shop.warehouse_id]);
}

// One customer to sign in with, plus an address to check out to.
await client.query(
  `INSERT INTO users (email, name, role, pw_algo, pw_salt, pw_hash, created_at)
   VALUES ('java.customer@example.com','Java Demo Customer','customer',$1,$2,$3, now()) ON CONFLICT (email) DO NOTHING`,
  [pw.algo, pw.salt, pw.hash]);
const customer = await client.query("SELECT id FROM users WHERE email = 'java.customer@example.com'");
await client.query(
  `INSERT INTO addresses (user_id, name, line1, city, pincode, phone)
   SELECT $1,'Java Demo Customer','1 Demo Road','Bengaluru','560038','9800000001'
   WHERE NOT EXISTS (SELECT 1 FROM addresses WHERE user_id = $1)`, [customer.rows[0].id]);

const counts = await client.query(`SELECT
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM offers) AS offers,
  (SELECT count(*) FROM sellers) AS sellers,
  (SELECT count(*) FROM users) AS users,
  (SELECT count(*) FROM inventory) AS stock`);
console.log('seeded:', JSON.stringify(counts.rows[0]));
await client.end();