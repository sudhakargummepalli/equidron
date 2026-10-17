// SAMPLE DATA. Every seller, brand, product, customer and order in sample-data.json is fictional.
// Rows created here are flagged is_sample = 1 and the UI shows a "Sample data" banner.
// Demo accounts all use the password in DEMO_PASSWORD.
import { createUser } from './auth.js';
import { dumps, now, one, run, scalar, transaction } from './db.js';
import * as listings from './listings.js';
import * as orders from './orders.js';
import DATA from './sample-data.json' with { type: 'json' };

export const DEMO_PASSWORD = DATA.demo_password;

function offerId(db, titlePrefix, sellerName) {
  return one(db, `SELECT o.id FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id
                  WHERE p.title LIKE ? AND s.name = ?`, titlePrefix + '%', sellerName).id;
}

// Load the sample dataset into an empty database. Returns false if it already has data.
export function seed(db) {
  if (scalar(db, 'SELECT COUNT(*) FROM users')) return false;
  const ts = now();
  const sellers = {};
  const customerIds = {};
  transaction(db, () => {
    for (const [email, name] of DATA.ops) createUser(db, email, name, DEMO_PASSWORD, 'ops', true);
    for (const [email, name, addr] of DATA.customers) {
      const uid = createUser(db, email, name, DEMO_PASSWORD, 'customer', true);
      const [aName, line1, city, pincode, phone] = addr;
      orders.addAddress(db, uid, { name: aName, line1, city, pincode, phone });
      customerIds[email] = uid;
    }
    const warehouses = {};
    for (const [code, name, city] of DATA.fulfilment_centres) {
      warehouses[code] = run(db, "INSERT INTO warehouses (code, name, city, kind) VALUES (?,?,?, 'equidron_fc')", code, name, city);
    }
    for (const [key, email, store, city, rating, count] of DATA.sellers) {
      const uid = createUser(db, email, store + ' (sample)', DEMO_PASSWORD, 'seller', true);
      const sid = run(db, 'INSERT INTO sellers (user_id, name, rating, rating_count, city, is_sample) VALUES (?,?,?,?,?,1)',
        uid, store, rating, count, city);
      sellers[key] = sid;
      warehouses['seller:' + key] = run(db, "INSERT INTO warehouses (code, name, city, kind, seller_id) VALUES (?,?,?, 'seller_dispatch', ?)",
        'S-' + key.toUpperCase(), `${store} dispatch, ${city}`, city, sid);
    }
    for (const p of DATA.products) {
      const pid = run(db, `INSERT INTO products (title, brand, category, description, specs, images, rating, review_count,
                                                 return_window_days, status, is_sample, created_at) VALUES (?,?,?,?,?, '[]', ?,?,?, 'live', 1, ?)`,
      p.title, p.brand, p.category, p.description, dumps(p.specs), p.rating, p.reviews, p.category === 'Grocery' ? 0 : 10, ts);
      run(db, 'UPDATE products SET images = ? WHERE id = ?', dumps([1, 2, 3].map((n) => `/img/p${pid}-${n}.svg`)), pid);
      for (const o of p.offers) {
        const oid = run(db, `INSERT INTO offers (product_id, seller_id, price_paise, mrp_paise, condition, fulfilment, handling_days,
                                                 ships_to, status, is_sample, updated_at) VALUES (?,?,?,?,?,?,?,?, 'active', 1, ?)`,
        pid, sellers[o.seller], o.price * 100, o.mrp * 100, o.condition, o.fulfilment, o.handling_days, dumps(o.ships_to), ts);
        for (const [where, qty] of Object.entries(o.stock)) {
          const wid = where === 'seller' ? warehouses['seller:' + o.seller] : warehouses[where];
          run(db, 'INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved) VALUES (?,?,?,0)', oid, wid, qty);
        }
      }
    }
  });

  // A few things already in motion so every screen has something to show.
  transaction(db, () => {
    listings.submit(db, sellers.techbazaar, {
      title: 'Kestrel K20 5G Smartphone (8GB RAM, 256GB, Aurora Purple)', brand: 'Kestrel', category: 'Phones',
      description: "Kestrel's new mid-range 5G phone with a 64MP camera, 120Hz display and 5500 mAh battery.",
      specs: { Display: '6.7-inch AMOLED, 120Hz', RAM: '8 GB', Storage: '256 GB', Battery: '5500 mAh' },
      images: ['/img/new-kestrel-1.svg'], price: '21999', mrp: '24999', quantity: 25,
      handling_days: 1, fulfilment: 'seller', ships_to: ['ALL'],
    });
    const asha = customerIds['asha@example.com'];
    const addressId = one(db, 'SELECT id FROM addresses WHERE user_id = ?', asha).id;
    // Delivered order (returnable) and an order that is on its way.
    orders.addToCart(db, asha, offerId(db, 'Sonique Pulse', 'TechBazaar Hub'), 1);
    orders.addToCart(db, asha, offerId(db, 'The Monsoon Ledger', 'PageTurner Books'), 2);
    const delivered = orders.placeOrder(db, asha, addressId, 'card', 'tok_sim_visa_ok').order;
    for (const sh of delivered.shipments) for (let i = 0; i < 6; i++) orders.advanceShipment(db, sh.id, 'ops');
    orders.addToCart(db, asha, offerId(db, 'Kitchora 1.5L', 'GreenLeaf Home Store'), 1);
    const onWay = orders.placeOrder(db, asha, addressId, 'upi', 'upi_sim_ok@equidron').order;
    for (const sh of onWay.shipments) for (let i = 0; i < 4; i++) orders.advanceShipment(db, sh.id, 'ops');
  });
  return true;
}
