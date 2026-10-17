/* Equidron Ops: listing review, logistics simulator, returns, support, settlement. */
angular.module('ops', ['eqCommon']).controller('OpsCtrl', ['$location', '$window', 'Api', 'Router', 'Toast',
  function ($location, $window, Api, Router, Toast) {
    var api = Api('ops');
    var vm = this;
    vm.auth = { form: {} };
    vm.CONTENT = ['title', 'brand', 'category', 'description', 'specs', 'images'];

    function fail(e) { vm.err = e.message; }
    function refreshOverview() { return api.get('/overview').then(function (o) { vm.overview = o; }); }

    function route(r) {
      vm.route = r;
      vm.err = null;
      if (!vm.user && r.name !== 'login') { $location.path('/login'); return; }
      if (vm.user) refreshOverview();
      switch (r.name) {
        case '': case 'reviews': return loadReviews();
        case 'shipments': return loadShipments();
        case 'returns': return api.get('/returns').then(function (x) { vm.returns = x; }, fail);
        case 'support': return api.get('/support').then(function (x) { vm.tickets = x; }, fail);
        case 'settlement': return;
        case 'login': if (vm.user) $location.path('/'); return;
      }
    }

    api.get('/me').then(function (r) { vm.user = r.user; }).finally(function () { Router(route); });

    vm.login = function () {
      vm.auth.error = null;
      api.post('/login', vm.auth.form).then(function (r) { vm.user = r.user; vm.auth.form = {}; $location.path('/'); },
        function (e) { vm.auth.error = e.message; });
    };
    vm.useDemo = function () { vm.auth.form = { email: 'ops@example.com', password: 'equidron-demo' }; };
    vm.logout = function () { api.post('/logout').then(function () { vm.user = null; $location.path('/login'); }); };

    // ---------------------------------------------------------------- listing review
    function loadReviews() {
      vm.reviewStatus = vm.reviewStatus || 'pending';
      return api.get('/submissions', { status: vm.reviewStatus === 'all' ? null : vm.reviewStatus }).then(function (s) {
        s.forEach(function (x) { x.note = ''; });
        vm.subs = s;
      }, fail);
    }
    vm.loadReviews = loadReviews;
    vm.show = function (v) {
      if (v === null || v === undefined || v === '') return '—';
      if (angular.isArray(v)) return v.join(', ');
      if (angular.isObject(v)) return Object.keys(v).map(function (k) { return k + ': ' + v[k]; }).join('; ');
      return String(v);
    };
    vm.has = function (obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); };
    vm.changed = function (s, field) {
      if (!(field in s.payload)) return false;
      return !s.live_product || !angular.equals(s.payload[field], s.live_product[field]);
    };
    vm.decide = function (s, approve) {
      if (!approve && !s.note) { s.error = 'Add a note so the seller knows what to fix.'; return; }
      api.post('/submissions/' + s.id + '/decide', { approve: approve, note: s.note }).then(function () {
        Toast.show('Submission #' + s.id + (approve ? ' approved and live.' : ' rejected.'));
        loadReviews(); refreshOverview();
      }, function (e) { s.error = e.message; });
    };

    // ---------------------------------------------------------------- shipments
    function loadShipments() {
      return api.get('/shipments', { all: vm.allShipments ? 1 : null }).then(function (s) { vm.shipments = s; }, fail);
    }
    vm.loadShipments = loadShipments;
    vm.advance = function (s) {
      api.post('/shipments/' + s.id + '/advance').then(function () { loadShipments(); refreshOverview(); },
        function (e) { Toast.show(e.message); });
    };
    vm.advanceAll = function () {
      api.post('/shipments/advance-all').then(function (r) {
        Toast.show(r.advanced + ' shipment(s) moved one stage forward.');
        loadShipments(); refreshOverview();
      }, function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- returns
    vm.receive = function (r, restock) {
      api.post('/returns/' + r.id + '/receive', { restock: restock }).then(function (x) {
        Toast.show('Refunded ' + (x.refunded_paise / 100).toFixed(2) + ' to the customer.');
        route(vm.route);
      }, function (e) { Toast.show(e.message); });
    };
    vm.reject = function (r) {
      var note = $window.prompt('Reason for rejecting this return?');
      if (!note) return;
      api.post('/returns/' + r.id + '/reject', { note: note }).then(function () { route(vm.route); });
    };

    // ---------------------------------------------------------------- support
    vm.reply = function (t, close) {
      api.post('/support/' + t.id + '/reply', { message: t.reply, close: close }).then(function (x) { vm.tickets = x; refreshOverview(); },
        function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- settlement
    vm.settle = function () {
      api.post('/settlement/run').then(function (r) { vm.payouts = r.payouts; refreshOverview(); });
    };
  }]);
