-- Return pickup scheduling: who collects the parcel, and when.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS pickup_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE returns ADD COLUMN IF NOT EXISTS pickup_at TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS pickup_courier TEXT;
