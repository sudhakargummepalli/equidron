/* Shared AngularJS pieces for the three Equidron interfaces. */
angular.module('eqCommon', [])
  .config(['$locationProvider', '$qProvider', function ($locationProvider, $qProvider) {
    $locationProvider.hashPrefix('');
    $qProvider.errorOnUnhandledRejections(false);
  }])

  // Api('shop') -> client for /api/shop. Rejections are {status, message, details}.
  .factory('Api', ['$http', '$q', function ($http, $q) {
    return function (area) {
      var base = '/api/' + area;
      function ok(r) { return r.data; }
      function fail(r) {
        return $q.reject({
          status: r.status,
          message: (r.data && r.data.error) || (r.status <= 0 ? 'Cannot reach the Equidron server. Is it running?' : 'Request failed.'),
          details: r.data && r.data.details
        });
      }
      return {
        get: function (path, params) { return $http.get(base + path, { params: params }).then(ok, fail); },
        post: function (path, body) { return $http.post(base + path, body || {}).then(ok, fail); },
        put: function (path, body) { return $http.put(base + path, body || {}).then(ok, fail); },
        del: function (path) { return $http.delete(base + path).then(ok, fail); }
      };
    };
  }])

  // Parses the hash into {name, id, parts}: "#/orders/12" -> {name: 'orders', id: 12}
  .factory('Router', ['$location', '$rootScope', function ($location, $rootScope) {
    return function (onChange) {
      function parse() {
        var parts = $location.path().split('/').filter(Boolean);
        onChange({ name: parts[0] || '', id: parts[1] ? parseInt(parts[1], 10) : null, parts: parts, search: $location.search() });
      }
      $rootScope.$on('$locationChangeSuccess', parse);
      parse();
    };
  }])

  .filter('inr', function () {
    var fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
    return function (paise) { return paise === null || paise === undefined ? '' : fmt.format(paise / 100); };
  })
  .filter('label', function () {
    return function (s) {
      s = String(s || '').replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
  })
  .filter('tone', function () {
    var good = ['delivered', 'completed', 'captured', 'approved', 'refunded', 'cod_collected', 'active', 'live', 'answered', 'closed', 'receipt_confirmed'];
    var bad = ['declined', 'cancelled', 'rejected', 'payment_failed', 'voided', 'inactive', 'out_of_stock', 'not_deliverable', 'unavailable'];
    var info = ['shipped', 'in_transit', 'out_for_delivery', 'partially_shipped', 'partially_delivered', 'partially_captured', 'partially_refunded', 'pickup_scheduled', 'received'];
    return function (s) {
      if (good.indexOf(s) >= 0) return 'good';
      if (bad.indexOf(s) >= 0) return 'bad';
      if (info.indexOf(s) >= 0) return 'info';
      return 'warn';
    };
  })
  .filter('stars', function () {
    return function (r) {
      var n = Math.round(r || 0);
      return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
    };
  })
  .filter('when', function () {
    return function (ts) {
      if (!ts) return '';
      var d = new Date(String(ts).replace(' ', 'T'));
      return isNaN(d) ? ts : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    };
  })
  .filter('day', function () {
    return function (ts) {
      if (!ts) return '';
      var d = new Date(String(ts).slice(0, 10) + 'T00:00:00');
      return isNaN(d) ? ts : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    };
  })

  // Voice in and out with the browser's Web Speech API (no server involved).
  // Languages: 'en' (Indian English) and 'te' (Telugu).
  // Voice.canListen: speech recognition exists (Chrome, Edge, Safari; not Firefox).
  // Voice.canSpeak: speech synthesis exists. Voice.hasVoice(lang): this device has a voice
  // for that language (Telugu voices are built into Edge; elsewhere they may be missing).
  // Callbacks run inside an Angular digest.
  .factory('Voice', ['$window', '$rootScope', function ($window, $rootScope) {
    var Recognition = $window.SpeechRecognition || $window.webkitSpeechRecognition;
    var synth = $window.speechSynthesis;
    var LANGS = {
      en: {
        code: 'en-IN', rupees: 'rupees', quantity: 'quantity', link: 'a link',
        blocked: 'Microphone access is blocked. Allow it in the browser to use voice.',
        noSpeech: 'I didn\'t hear anything. Tap the mic and try again.',
        stopped: 'Voice input stopped'
      },
      te: {
        code: 'te-IN', rupees: 'రూపాయలు', quantity: 'పరిమాణం', link: 'ఒక లింక్',
        blocked: 'మైక్రోఫోన్ అనుమతి లేదు. వాయిస్ కోసం బ్రౌజర్‌లో మైక్‌ను అనుమతించండి.',
        noSpeech: 'ఏమీ వినిపించలేదు. మైక్ నొక్కి మళ్లీ ప్రయత్నించండి.',
        stopped: 'వాయిస్ ఇన్‌పుట్ ఆగిపోయింది'
      }
    };
    var current = null;
    function lang(l) { return LANGS[l] || LANGS.en; }
    function apply(fn) { return function (arg) { if (fn) $rootScope.$applyAsync(function () { fn(arg); }); }; }
    // Voices load after the page; refresh bindings such as hasVoice() when they arrive.
    if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', function () { $rootScope.$applyAsync(); });

    // Read ₹ amounts and a few symbols the way a person would say them.
    function speakable(text, l) {
      var L = lang(l);
      return String(text || '')
        .replace(/₹\s?([\d,]+(?:\.\d+)?)/g, '$1 ' + L.rupees)
        .replace(/\s×\s?(\d+)/g, ', ' + L.quantity + ' $1')
        .replace(/https?:\/\/\S+/g, L.link)
        .replace(/[*_#`>]/g, '');
    }
    function voiceFor(l) {
      if (!synth) return null;
      var code = lang(l).code.toLowerCase();
      var prefix = code.slice(0, 2);
      var voices = synth.getVoices();
      var norm = function (v) { return String(v.lang || '').replace('_', '-').toLowerCase(); };
      return voices.filter(function (v) { return norm(v) === code; })[0] ||
        voices.filter(function (v) { return norm(v).slice(0, 2) === prefix; })[0] || null;
    }

    return {
      canListen: !!Recognition,
      canSpeak: !!synth,
      hasVoice: function (l) { return !!voiceFor(l); },
      // handlers: { interim(text), final(text), end(), error(message) }. Returns false if unsupported.
      listen: function (handlers, l) {
        if (!Recognition) return false;
        var L = lang(l);
        this.stopListening();
        var r = new Recognition();
        r.lang = L.code;
        r.interimResults = true;
        r.continuous = false;
        r.maxAlternatives = 1;
        var finalText = '';
        r.onresult = function (e) {
          var interim = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
            else interim += e.results[i][0].transcript;
          }
          apply(handlers.interim)((finalText + interim).trim());
        };
        r.onerror = function (e) {
          var msg = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? L.blocked
            : e.error === 'no-speech' ? L.noSpeech
              : e.error === 'aborted' ? null : L.stopped + ' (' + e.error + ').';
          if (msg) apply(handlers.error)(msg);
        };
        r.onend = function () {
          if (current === r) current = null;
          if (finalText.trim()) apply(handlers.final)(finalText.trim());
          apply(handlers.end)();
        };
        current = r;
        r.start();
        return true;
      },
      stopListening: function () { if (current) { current.abort(); current = null; } },
      // Returns false (and calls nothing) when the device has no voice for the language.
      speak: function (text, onEnd, l) {
        var v = voiceFor(l);
        if (!synth || !v) return false;
        synth.cancel();
        var u = new $window.SpeechSynthesisUtterance(speakable(text, l));
        u.lang = lang(l).code;
        u.voice = v;
        u.onend = apply(onEnd);
        u.onerror = apply(onEnd);
        synth.speak(u);
        return true;
      },
      stopSpeaking: function () { if (synth) synth.cancel(); },
      speakable: speakable
    };
  }])

  // Small toast helper: Toast.show('Saved')
  .factory('Toast', ['$timeout', '$rootScope', function ($timeout, $rootScope) {
    var t;
    return {
      show: function (msg) {
        $rootScope.toast = msg;
        if (t) $timeout.cancel(t);
        t = $timeout(function () { $rootScope.toast = null; }, 3500);
      }
    };
  }]);
