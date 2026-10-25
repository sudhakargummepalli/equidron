// Two-language support for the store and Seller Central.
//
// The strings are plain JS files under /i18n, so they load with the page (no fetch, no eval, and
// nothing for the CSP to object to). The chosen language lives in localStorage and the page
// reloads on a change: a full reload is the simplest way to guarantee that nothing was left in the
// old language, which is exactly what a half-translated interface looks like.
(function () {
  'use strict';
  var LANG_KEY = 'equidron.lang';
  var LANGS = ['en', 'te'];
  var strings = window.EQ_STRINGS || {};

  function current() {
    try {
      var saved = window.localStorage.getItem(LANG_KEY);
      if (saved && LANGS.indexOf(saved) >= 0) return saved;
    } catch (e) { /* private mode: fall through to the document language */ }
    var doc = (document.documentElement.getAttribute('lang') || 'en').slice(0, 2);
    return LANGS.indexOf(doc) >= 0 ? doc : 'en';
  }

  // Missing key: fall back to English, then to the key itself, so a gap shows up as a readable
  // word rather than an empty space (and the test still catches it).
  function t(key, vars) {
    var lang = current();
    var table = strings[lang] || {};
    var value = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : (strings.en || {})[key];
    if (value == null) return key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        value = value.split('{' + k + '}').join(String(vars[k]));
      });
    }
    return value;
  }

  // The area ('shop' or 'seller') decides which route saves the choice; when nobody is signed in
  // the call fails and the interface still switches, which is the right behaviour.
  function setLang(next, area) {
    if (LANGS.indexOf(next) < 0) return;
    try { window.localStorage.setItem(LANG_KEY, next); } catch (e) { /* ignore */ }
    if (!area) { window.location.reload(); return; }
    window.fetch('/api/' + area + '/language', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: next }),
    }).catch(function () { /* offline or signed out: the interface still switches */ })
      .then(function () { window.location.reload(); });
  }

  window.eqT = t;
  window.eqLang = current;
  window.eqSetLang = setLang;

  var app = angular.module('equidronI18n', []);
  app.filter('t', function () { return function (key, vars) { return t(key, vars); }; });
  // A language picker any header can drop in: <span eq-lang-switch></span>
  app.directive('eqLangSwitch', function () {
    return {
      restrict: 'A',
      template: '<select class="eq-lang" ng-model="lang" ng-change="change()" aria-label="Language">'
        + '<option value="en">English</option><option value="te">తెలుగు</option></select>',
      link: function (scope, element, attrs) {
        scope.lang = current();
        scope.change = function () { setLang(scope.lang, attrs.eqLangSwitch || null); };
      },
    };
  });
})();
