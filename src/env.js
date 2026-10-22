// Load a local .env file, if there is one. Nothing is loaded in the library modules: only the
// entry points call this, so a test never picks up a developer's real secrets by accident.
//
// Format: one KEY=value per line. Blank lines and lines starting with # are ignored. A value may
// be wrapped in single or double quotes. A variable that is already set in the environment wins,
// so `TELEGRAM_BOT_TOKEN=... node app.js` behaves as expected.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function loadEnv(file = path.join(process.cwd(), '.env')) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return 0; // no .env is normal
  }
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || /^\s*#/.test(raw)) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  return loaded;
}
