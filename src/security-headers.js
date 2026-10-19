// Security headers for every page. Netlify sends them from netlify.toml and the local
// server sends them itself; tests/security.test.js checks that both lists match.
//
// Content-Security-Policy: scripts only from this site and cdnjs (AngularJS, pinned with
// Subresource Integrity); no eval (the pages set ng-csp="no-unsafe-eval"); styles may be
// inline (style="" attributes and AngularJS's own); images from any https site, because
// sellers link product photos until Phase 11; nobody may frame the pages.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' https: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; "
    + "form-action 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), payment=(), microphone=(self)',
};
