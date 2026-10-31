-- Restore stock for offers that have none, at the seller's dispatch warehouse.
--
-- Written after a cleanup removed demo inventory along with the test accounts it was targeting, leaving a
-- marketplace with offers and nothing to sell. Safe to run twice: it sets a level rather than adding one.
INSERT INTO inventory (offer_id, warehouse_id, on_hand, reserved)
SELECT o.id, MIN(w.id), 25, 0
FROM offers o JOIN warehouses w ON w.seller_id = o.seller_id
WHERE o.status = 'active'
GROUP BY o.id
ON CONFLICT (offer_id, warehouse_id) DO UPDATE SET on_hand = EXCLUDED.on_hand;