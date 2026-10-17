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
