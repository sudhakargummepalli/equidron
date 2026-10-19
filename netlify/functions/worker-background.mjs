// Background function (the "-background" name makes it one: up to 15 minutes, answered at once
// with 202, retried by Netlify if it crashes). It runs ready jobs for about 13 minutes.
// Only the tick may start it: see src/worker.js for the secret check and the copy limit.
import { netlifyDatabase } from '../../src/netlify-db.js';
import { handleWorkerRequest } from '../../src/worker.js';

export default async (request) => handleWorkerRequest(request, { db: await netlifyDatabase() });
