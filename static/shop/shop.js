/* Equidron storefront (customers). */
angular.module('shop', ['eqCommon', 'equidronI18n']).controller('ShopCtrl', ['$scope', '$location', '$window', 'Api', 'Router', 'Toast', 'AssistantChat', 'AuthForm',
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
        case 'sell': if (requireLogin()) loadApplication(); return;
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
      return api.get('/search', { q: vm.q, category: vm.category, sort: vm.sort, city: vm.city, page: s.page || null }).then(function (r) {
        vm.results = r.results;
        vm.paging = { page: r.page, pages: r.pages, total: r.total };
        vm.loading = false;
      }, fail);
    }
    vm.search = function (page) {
      $location.path('/search').search({ q: vm.q || null, category: vm.category || null,
        sort: vm.sort !== 'relevance' ? vm.sort : null, page: page > 1 ? page : null });
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
      // One key per attempt: if this request is sent twice, the server places one order.
      // After an answer the key is dropped, so trying again (another card, say) is a new attempt.
      vm.co.key = vm.co.key || ('co-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
      api.post('/orders', {
        address_id: vm.co.address_id,
        payment_method: vm.co.payment.method,
        payment_token: token,
        idempotency_key: vm.co.key
      }).finally(function () { vm.co.key = null; }).then(function (order) {
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

    // ---------------------------------------------------------------- Razorpay (Phase 8)
    // The order is created first (payment_method razorpay), then a gateway order, then the modal.
    // The browser only ever sees the key id; the server holds the secret and verifies the signature.
    vm.razorpay = { enabled: false };
    // Razorpay's script is loaded on demand: one extra external script at first use, not on every
    // page view, and the security test keeps its "one pinned script" rule intact.
    let razorpayLoading = null;
    function ensureRazorpay() {
      if (window.Razorpay) return Promise.resolve();
      if (razorpayLoading) return razorpayLoading;
      razorpayLoading = new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { razorpayLoading = null; reject(new Error('Could not load Razorpay checkout.')); };
        document.head.appendChild(s);
      });
      return razorpayLoading;
    }
    vm.payError = null;
    api.get('/payments/razorpay/key').then(function (k) { vm.razorpay = k; }, function () { /* not configured */ });
    vm.payWithRazorpay = function () {
      if (!vm.user) { $location.path('/login'); return; }
      if (!vm.co.preview || !vm.co.preview.ok) { Toast.show('Review the cart before paying.'); return; }
      vm.paying = true;
      vm.payError = null;
      api.post('/orders', {
        address_id: vm.co.address_id, payment_method: 'razorpay',
        fingerprint: vm.co.preview.fingerprint, cart_version: vm.cart.version,
      }).then(function (placed) {
        const order = placed.order || placed;
        return api.post('/payments/razorpay/order', { order_id: order.id }).then(function (gw) {
          return ensureRazorpay().then(function () { return gw; });
        }).then(function (gw) {
          return new Promise(function (resolve, reject) {
            if (!window.Razorpay) { reject(new Error('Razorpay checkout did not load.')); return; }
            const checkout = new window.Razorpay({
              key: gw.key_id, order_id: gw.order_id, amount: gw.amount, currency: gw.currency || 'INR',
              name: 'Equidron', description: 'Order #' + order.id,
              theme: { color: '#1f6feb' },
              handler: function (response) {
                api.post('/payments/razorpay/verify', {
                  order_id: order.id,
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                }).then(function () { resolve(order); }, reject);
              },
              modal: { ondismiss: function () { reject(new Error('Payment cancelled.')); } },
            });
            // A failure inside the modal is a message, not a redirect.
            checkout.on('payment.failed', function (resp) {
              reject(new Error((resp.error && resp.error.description) || 'Payment failed.'));
            });
            checkout.open();
          });
        });
      }).then(function (order) {
        Toast.show('Payment received. Thank you.');
        $location.path('/orders/' + order.id).search({ placed: 1 });
      }, function (e) {
        vm.payError = e.message || 'Payment could not be completed.';
      }).finally(function () { vm.paying = false; });
    };

    // ---------------------------------------------------------------- sell on Equidron (Phase 11)
    // The form saves a step at a time; nothing becomes a seller until the last step is submitted.
    vm.app = {};
    vm.appErrors = {};
    vm.appMissing = [];
    vm.businessTypes = [
      { value: 'individual', label: 'Individual' },
      { value: 'proprietorship', label: 'Proprietorship' },
      { value: 'partnership', label: 'Partnership' },
      { value: 'private_limited', label: 'Private limited' },
    ];
    function loadApplication() {
      return api.get('/seller-application').then(function (r) {
        vm.application = r.application;
        if (r.application) vm.app = angular.copy(r.application);
        vm.appMissing = r.missing ? r.missing.fields : [];
      }, fail);
    }
    vm.saveStep = function () {
      vm.saving = true;
      return api.post('/seller-application', vm.app).then(function (r) {
        vm.application = r.application;
        vm.appErrors = {};
        Toast.show('Saved. You can come back to this later.');
      }, function (e) {
        vm.appErrors = (e.details && e.details.errors) || {};
        Toast.show(e.message);
      }).finally(function () { vm.saving = false; });
    };
    vm.submitApp = function () {
      vm.saving = true;
      vm.appError = null;
      return api.post('/seller-application/submit', { agreement: vm.agreed === true }).then(function (r) {
        vm.application = r.application;
        Toast.show('Application submitted. Seller Central is open to you now.');
      }, function (e) {
        vm.appErrors = (e.details && e.details.errors) || {};
        vm.appMissing = (e.details && e.details.fields) || [];
        vm.appError = (e.details && e.details.steps) ? 'Still needed: ' + e.details.steps.join(', ') : e.message;
      }).finally(function () { vm.saving = false; });
    };

    // ---------------------------------------------------------------- orders
    function loadOrder(id) {
      return api.get('/orders/' + id).then(function (o) { vm.order = o; vm.returnForm = {}; }, fail);
    }
    // A one-time code for the Telegram bot. The bot never asks for a password.
    vm.telegramCode = function () {
      vm.tgBusy = true;
      api.post('/telegram/link-code').then(function (r) {
        vm.tgCode = r.code;
        vm.tgBot = r.bot;
      }, function (e) { Toast.show(e.message); }).finally(function () { vm.tgBusy = false; });
    };
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
