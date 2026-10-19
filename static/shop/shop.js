/* Equidron storefront (customers). */
angular.module('shop', ['eqCommon']).controller('ShopCtrl', ['$scope', '$location', '$window', 'Api', 'Router', 'Toast', 'AssistantChat', 'AuthForm',
  function ($scope, $location, $window, Api, Router, Toast, AssistantChat, AuthForm) {
    var api = Api('shop');
    var vm = this;
    vm.STAGES = ['pending', 'picking', 'packed', 'shipped', 'in_transit', 'out_for_delivery', 'delivered'];
    vm.meta = {};
    vm.user = null;
    vm.cart = { items: [], count: 0, estimate: {} };
    vm.q = '';
    vm.category = '';
    vm.sort = 'relevance';
    vm.showFactors = false;
    vm.city = readCity();
    vm.auth = AuthForm(api, {
      register: true,
      demoAccounts: [{ email: 'asha@example.com' }, { email: 'rahul@example.com' }],
      signedIn: function (user) {
        vm.user = user;
        refreshCart(); loadAddresses(); loadNotes();
        $location.url(vm.route.search.next || '/');
      },
    });
    vm.auth.note = 'Customer accounts only. Sellers sign in at Seller Central (/seller/).';
    vm.co = {};
    vm.unread = 0;

    function readCity() { try { return $window.localStorage.getItem('eq.city'); } catch (e) { return null; } }
    function saveCity(c) { try { $window.localStorage.setItem('eq.city', c); } catch (e) { /* storage unavailable */ } }
    function fail(e) { vm.err = e.message; vm.loading = false; }

    api.get('/meta').then(function (m) { vm.meta = m; if (!vm.city) vm.city = 'Bengaluru'; });

    function loadMe() {
      return api.get('/me').then(function (r) {
        vm.user = r.user;
        vm.auth.demo = r.demo;
        if (vm.user) { refreshCart(); loadAddresses(); loadNotes(); }
      });
    }

    function refreshCart() { return api.get('/cart', { city: vm.city }).then(function (c) { vm.cart = c; }); }
    function loadNotes() {
      return api.get('/notifications').then(function (n) {
        vm.notes = n;
        vm.unread = n.filter(function (x) { return !x.is_read; }).length;
      });
    }
    function loadAddresses() {
      return api.get('/addresses').then(function (a) {
        vm.addresses = a;
        if (!readCity() && a.length) vm.city = a[0].city;
      });
    }

    function requireLogin() {
      if (vm.user) return true;
      $location.path('/login').search({ next: $location.url() });
      return false;
    }

    vm.setCity = function () { saveCity(vm.city); route(vm.route); if (vm.user) refreshCart(); };

    // ---------------------------------------------------------------- routing
    function route(r) {
      vm.route = r;
      vm.err = null;
      vm.notice = null;
      $window.scrollTo(0, 0);
      switch (r.name) {
        case '': case 'search': return runSearch(r.search);
        case 'product': return loadProduct(r.id);
        case 'cart': if (requireLogin()) refreshCart(); return;
        case 'checkout': if (requireLogin()) startCheckout(); return;
        case 'orders':
          if (!requireLogin()) return;
          if (r.id) {
            if (r.search.placed) vm.notice = 'Thank you! Your order is confirmed.';
            return loadOrder(r.id);
          }
          return api.get('/orders').then(function (o) { vm.orders = o; }, fail);
        case 'notifications':
          if (!requireLogin()) return;
          return loadNotes().then(function () { return api.post('/notifications/read'); }).then(function () { vm.unread = 0; });
        case 'support':
          if (!requireLogin()) return;
          vm.ticket = { order_id: r.search.order ? parseInt(r.search.order, 10) : null };
          return loadTickets();
        case 'login':
          if (vm.user) { $location.url(r.search.next || '/'); }
          return;
        case 'reset':
          vm.auth.startReset(r.search.code);
          return;
      }
    }

    loadMe().finally(function () { Router(route); });

    // ---------------------------------------------------------------- auth
    vm.logoutAll = function () { api.post('/logout-all').then(signedOut); };
    vm.logout = function () { api.post('/logout').then(signedOut); };
    function signedOut() {
      vm.user = null; vm.cart = { items: [], count: 0, estimate: {} }; vm.notes = []; vm.unread = 0;
      vm.chat.reset();
      $location.url('/');
    }

    // ---------------------------------------------------------------- search
    function runSearch(s) {
      vm.q = s.q || '';
      vm.category = s.category || '';
      vm.sort = s.sort || 'relevance';
      vm.loading = true;
      return api.get('/search', { q: vm.q, category: vm.category, sort: vm.sort, city: vm.city }).then(function (r) {
        vm.results = r.results;
        vm.loading = false;
      }, fail);
    }
    vm.search = function () {
      $location.path('/search').search({ q: vm.q || null, category: vm.category || null, sort: vm.sort !== 'relevance' ? vm.sort : null });
    };
    vm.pickCategory = function (c) { vm.category = c; vm.search(); };

    // ---------------------------------------------------------------- product
    function loadProduct(id) {
      vm.product = null;
      return api.get('/products/' + id, { city: vm.city }).then(function (p) {
        p.offers.forEach(function (o) { o.qty = 1; });
        vm.product = p;
        vm.mainImg = p.images[0];
        vm.featured = p.offers.filter(function (o) { return o.is_featured; })[0];
      }, fail);
    }
    vm.qtyOptions = function (o) {
      var out = [];
      for (var i = 1; i <= Math.min(10, o.available); i++) out.push(i);
      return out;
    };
    vm.addToCart = function (offer) {
      if (!requireLogin()) return;
      api.post('/cart', { offer_id: offer.id, qty: offer.qty || 1 }).then(function (c) {
        vm.cart = c;
        Toast.show('Added to cart: ' + vm.product.title.slice(0, 40) + '…');
      }, function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- cart
    vm.setQty = function (line, qty) {
      api.put('/cart/' + line.offer_id, { qty: qty }).then(function (c) { vm.cart = c; }, function (e) { Toast.show(e.message); });
    };
    vm.remove = function (line) { api.del('/cart/' + line.offer_id).then(function (c) { vm.cart = c; }); };

    // ---------------------------------------------------------------- checkout
    function startCheckout() {
      vm.co = { payment: null, preview: null, issues: null, newAddr: { city: vm.city } };
      refreshCart();
      loadAddresses().then(function () {
        var match = vm.addresses.filter(function (a) { return a.city === vm.city; })[0] || vm.addresses[0];
        vm.co.address_id = match ? match.id : null;
        vm.co.addingAddress = !vm.addresses.length;
        if (vm.co.address_id) vm.review();
      });
    }
    vm.addAddress = function () {
      vm.co.addrErrors = null;
      api.post('/addresses', vm.co.newAddr).then(function (list) {
        vm.addresses = list;
        vm.co.address_id = list[list.length - 1].id;
        vm.co.addingAddress = false;
        vm.review();
      }, function (e) { vm.co.addrErrors = (e.details && e.details.fields) || { name: e.message }; });
    };
    vm.review = function () {
      vm.co.declined = null;
      api.post('/checkout/preview', { address_id: vm.co.address_id }).then(function (p) {
        vm.co.preview = p;
        vm.co.issues = p.issues.length ? p.issues : null;
        refreshCart();
      }, fail);
    };
    vm.placeOrder = function () {
      if (!vm.co.payment) { vm.co.payError = 'Choose a payment option.'; return; }
      var token = vm.co.payment.reference ? String(vm.co.reference || '').trim() : vm.co.payment.token;
      if (vm.co.payment.reference && !token) { vm.co.payError = 'Enter the payment reference from your bank.'; return; }
      vm.co.payError = null;
      vm.co.placing = true;
      api.post('/orders', {
        address_id: vm.co.address_id,
        payment_method: vm.co.payment.method,
        payment_token: token
      }).then(function (order) {
        vm.co.placing = false;
        refreshCart(); loadNotes();
        $location.path('/orders/' + order.id).search({ placed: 1 });
      }, function (e) {
        vm.co.placing = false;
        if (e.status === 409) {
          // Checkout found changes since the cart was last reviewed: show them and re-preview.
          vm.co.issues = e.details.issues;
          vm.co.changedMessage = e.message;
          api.post('/checkout/preview', { address_id: vm.co.address_id }).then(function (p) { vm.co.preview = p; refreshCart(); });
        } else if (e.status === 402) {
          vm.co.declined = e.message;
          loadNotes();
        } else {
          vm.co.payError = e.message;
        }
      });
    };

    // ---------------------------------------------------------------- orders
    function loadOrder(id) {
      return api.get('/orders/' + id).then(function (o) { vm.order = o; vm.returnForm = {}; }, fail);
    }
    vm.stageDone = function (sh, stage) { return sh.stage_index >= vm.STAGES.indexOf(stage); };
    vm.cancelOrder = function () {
      if (!$window.confirm('Cancel order #' + vm.order.id + '?')) return;
      api.post('/orders/' + vm.order.id + '/cancel').then(function (o) { vm.order = o; vm.returnForm = {}; Toast.show('Order cancelled.'); loadNotes(); },
        function (e) { Toast.show(e.message); });
    };
    vm.openReturn = function (item) { vm.returnForm[item.id] = { qty: 1, reason: '' }; };
    vm.submitReturn = function (item) {
      var f = vm.returnForm[item.id];
      api.post('/orders/' + vm.order.id + '/returns', { order_item_id: item.id, qty: f.qty, reason: f.reason }).then(function (o) {
        vm.order = o; vm.returnForm = {}; Toast.show('Return requested. Pickup scheduled.'); loadNotes();
      }, function (e) { f.error = e.message; });
    };
    vm.confirmReceipt = function (sh) {
      api.post('/shipments/' + sh.id + '/confirm').then(function () { loadOrder(vm.order.id); Toast.show('Thanks for confirming.'); });
    };
    vm.range = function (n) { var a = []; for (var i = 1; i <= n; i++) a.push(i); return a; };

    // ---------------------------------------------------------------- support
    function loadTickets() { return api.get('/support').then(function (t) { vm.tickets = t; }, fail); }
    vm.createTicket = function () {
      vm.ticket.error = null;
      api.post('/support', vm.ticket).then(function (t) { vm.tickets = t; vm.ticket = {}; Toast.show('Support request sent.'); },
        function (e) { vm.ticket.error = e.message; });
    };
    vm.replyTicket = function (t) {
      api.post('/support/' + t.id + '/reply', { message: t.reply }).then(function (list) { vm.tickets = list; });
    };

    // ---------------------------------------------------------------- assistant
    // Panel text in English and Telugu; the panel itself is static/common/chat.html.
    vm.chat = AssistantChat({
      api: api,
      storageKey: 'eq.shop.lang',
      signedIn: function () { return vm.user; },
      showSignedOut: true,
      linkFor: function (p) { return '#/product/' + p.id; },
      params: function () { return { city: vm.city }; },
      texts: {
        en: {
          fab: 'Ask Equidron', title: 'Equidron assistant', close: 'Close assistant',
          hello: 'Hi! Ask me about products, prices, delivery, payments, returns or your orders.',
          suggestions: ['Best gaming laptop under ₹1,00,000?', 'Where is my latest order?', 'How do returns work?'],
          placeholder: 'Ask a question', listening: 'Listening…', send: 'Send', thinking: 'Looking that up…', linkPrefix: '',
          mic: 'Ask by voice', micStop: 'Stop listening', readAloud: 'Read replies aloud', handsFree: 'Hands-free',
          handsFreeHint: 'After each spoken reply, listen for the next question', stop: 'Stop speaking',
          signInBefore: 'Please', signInLink: 'sign in', signInAfter: ' to chat with the assistant.',
          unavailable: "The assistant isn't available right now.", supportLink: 'Customer service can help.',
          noVoice: 'This device has no English voice, so replies are shown as text only.',
          note: "Answers come from an AI and can be wrong. It can look things up but can't change your orders.",
          voiceNote: 'Voice input is turned into text by your browser.'
        },
        te: {
          fab: 'Equidron‌ని అడగండి', title: 'Equidron సహాయకుడు', close: 'సహాయకుడిని మూసివేయి',
          hello: 'నమస్కారం! ఉత్పత్తులు, ధరలు, డెలివరీ, చెల్లింపులు, రిటర్న్‌లు లేదా మీ ఆర్డర్ల గురించి నన్ను అడగండి.',
          suggestions: ['₹1,00,000 లోపు ఉత్తమ గేమింగ్ ల్యాప్‌టాప్ ఏది?', 'నా తాజా ఆర్డర్ ఎక్కడ ఉంది?', 'రిటర్న్‌లు ఎలా పనిచేస్తాయి?'],
          placeholder: 'ప్రశ్న అడగండి', listening: 'వింటున్నాను…', send: 'పంపు', thinking: 'చూస్తున్నాను…', linkPrefix: '',
          mic: 'వాయిస్‌తో అడగండి', micStop: 'వినడం ఆపు', readAloud: 'సమాధానాలు చదివి వినిపించు', handsFree: 'హ్యాండ్స్-ఫ్రీ',
          handsFreeHint: 'ప్రతి సమాధానం తర్వాత తదుపరి ప్రశ్న కోసం వింటుంది', stop: 'మాట్లాడటం ఆపు',
          signInBefore: 'సహాయకుడితో చాట్ చేయడానికి దయచేసి', signInLink: 'సైన్ ఇన్ చేయండి', signInAfter: '.',
          unavailable: 'సహాయకుడు ప్రస్తుతం అందుబాటులో లేదు.', supportLink: 'కస్టమర్ సర్వీస్ సహాయం చేస్తుంది.',
          noVoice: 'ఈ పరికరంలో తెలుగు వాయిస్ లేదు, కాబట్టి సమాధానాలు టెక్స్ట్‌గా మాత్రమే చూపబడతాయి. Edge బ్రౌజర్‌లో తెలుగు వాయిస్ ఉంటుంది.',
          note: 'సమాధానాలు AI నుండి వస్తాయి, తప్పులు ఉండవచ్చు. ఇది సమాచారం చూడగలదు కానీ మీ ఆర్డర్లను మార్చలేదు.',
          voiceNote: 'మీ వాయిస్‌ను మీ బ్రౌజర్ టెక్స్ట్‌గా మారుస్తుంది.'
        }
      }
    });
    vm.chat.load();
  }]);
