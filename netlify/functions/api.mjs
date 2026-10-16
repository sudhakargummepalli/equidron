// Netlify Function: the Equidron API and placeholder images, backed by a SQLite
// file stored in Netlify Blobs (see src/blob-backed.js).
import { getStore } from '@netlify/blobs';
import { makeBlobHandler } from '../../src/blob-backed.js';

const handle = makeBlobHandler(() => getStore({ name: 'equidron', consistency: 'strong' }));

export default (request) => handle(request);

export const config = { path: ['/api/*', '/img/*'] };
