/* Equidron Seller Central. */
angular.module('seller', ['eqCommon', 'equidronI18n']).controller('SellerCtrl', ['$location', '$window', 'Api', 'Router', 'Toast', 'AssistantChat', 'AuthForm', 'SecurityPanel',
  function ($location, $window, Api, Router, Toast, AssistantChat, AuthForm, SecurityPanel) {
    var api = Api('seller');
    var vm = this;
    vm.user = null;
    vm.meta = {};
    vm.auth = AuthForm(api, {
      demoAccounts: [
        { email: 'lakshmi.seller@example.com', label: 'Lakshmi Mobiles & Electronics' },
        { email: 'techbazaar.seller@example.com', label: 'TechBazaar Hub' },
        { email: 'urbancart.seller@example.com', label: 'UrbanCart Retail' },
        { email: 'greenleaf.seller@example.com', label: 'GreenLeaf Home Store' },
        { email: 'pageturner.seller@example.com', label: 'PageTurner Books' },
      ],
      signedIn: function (user) {
        vm.user = user;
        api.get('/meta').then(function (m) { vm.meta = m; });
        loadNotes();
        loadChat();
        $location.path('/');
      },
    });
    vm.auth.note = 'For Equidron sellers. Shopping? Go to the Equidron store (/shop/).';
    vm.security = SecurityPanel(api, signedOut);
    vm.unread = 0;

    function fail(e) { vm.err = e.message; }

    function loadMe() {
      return api.get('/me').then(function (r) {
        vm.user = r.user;
        vm.auth.demo = r.demo;
        if (vm.user) {
          api.get('/meta').then(function (m) { vm.meta = m; });
          loadNotes();
          loadChat();
        }
      });
    }
    function loadNotes() {
      return api.get('/notifications').then(function (n) {
        vm.notes = n;
        vm.unread = n.filter(function (x) { return !x.is_read; }).length;
      });
    }

    function route(r) {
      vm.route = r;
      vm.err = null;
      $window.scrollTo(0, 0);
      if (!vm.user && r.name !== 'login' && r.name !== 'reset') { $location.path('/login'); return; }
      switch (r.name) {
        case '': return api.get('/dashboard').then(function (d) { vm.dash = d; }, fail);
        case 'inventory': return loadListings();
        case 'edit': return startEdit(r.parts[1]);
        case 'submissions': return api.get('/submissions').then(function (s) { vm.submissions = s; }, fail);
        case 'orders': return loadOrders();
        case 'payments': return api.get('/ledger').then(function (l) { vm.ledger = l; }, fail);
        case 'notifications':
          return loadNotes().then(function () { return api.post('/notifications/read'); }).then(function () { vm.unread = 0; });
        case 'login': if (vm.user) $location.path('/'); return;
        case 'reset': vm.auth.startReset(r.search.code); return;
        case 'security': return vm.security.load();
      }
    }

    loadMe().finally(function () { Router(route); });

    function signedOut() { vm.chat.reset(); vm.user = null; $location.path('/login'); }
    vm.logout = function () { api.post('/logout').then(signedOut); };

    // ---------------------------------------------------------------- inventory
    function loadListings() {
      return api.get('/listings').then(function (l) { vm.listings = l; }, fail);
    }

    // ---------------------------------------------------------------- add / edit listing
    function blankForm() {
      return {
        mode: null, specsList: [{ k: '', v: '' }], images: [''], condition: 'new', fulfilment: 'equidron',
        handling_days: 1, quantity: 0, shipsAll: true, cities: {}
      };
    }

    function startEdit(which) {
      vm.result = null;
      vm.fieldErrors = {};
      vm.f = blankForm();
      vm.lookup = { q: '', results: null };
      if (which === 'new') return;
      return api.get('/listings').then(function (l) {
        var o = l.offers.filter(function (x) { return x.id === parseInt(which, 10); })[0];
        if (!o) { vm.err = 'Listing not found.'; return; }
        var f = vm.f;
        f.mode = 'update';
        f.offer_id = o.id;
        f.listing = o;
        f.title = o.title; f.brand = o.brand; f.category = o.category; f.description = o.description;
        f.specsList = Object.keys(o.specs).map(function (k) { return { k: k, v: o.specs[k] }; });
        if (!f.specsList.length) f.specsList.push({ k: '', v: '' });
        f.images = o.images.slice();
        f.price = (o.price_paise / 100).toFixed(2);
        f.mrp = o.mrp_paise ? (o.mrp_paise / 100).toFixed(2) : '';
        f.quantity = o.home_available;
        f.handling_days = o.handling_days;
        f.condition = o.condition;
        f.fulfilment = o.fulfilment;
        f.shipsAll = o.ships_to.indexOf('ALL') >= 0;
        f.cities = {};
        o.ships_to.forEach(function (c) { if (c !== 'ALL') f.cities[c] = true; });
      }, fail);
    }

    vm.searchCatalog = function () {
      api.get('/catalog', { q: vm.lookup.q }).then(function (r) { vm.lookup.results = r; });
    };
    vm.pickProduct = function (p) {
      vm.f.mode = 'new_offer';
      vm.f.product_id = p.id;
      vm.f.product = p;
    };
    vm.newProduct = function () { vm.f.mode = 'new_product'; vm.f.images = ['']; };
    vm.addSpec = function () { vm.f.specsList.push({ k: '', v: '' }); };
    vm.addImage = function () { vm.f.images.push(''); };
    vm.removeAt = function (list, i) { list.splice(i, 1); };

    function payload() {
      var f = vm.f;
      var data = {
        price: f.price, mrp: f.mrp, quantity: f.quantity, handling_days: f.handling_days, condition: f.condition,
        ships_to: f.shipsAll ? ['ALL'] : Object.keys(f.cities).filter(function (c) { return f.cities[c]; })
      };
      if (f.mode !== 'update') data.fulfilment = f.fulfilment;
      if (f.mode === 'update') data.offer_id = f.offer_id;
      if (f.mode === 'new_offer') data.product_id = f.product_id;
      if (f.mode !== 'new_offer') {
        var specs = {};
        f.specsList.forEach(function (s) { if (s.k && s.v) specs[s.k] = s.v; });
        angular.extend(data, {
          title: f.title, brand: f.brand, category: f.category, description: f.description, specs: specs,
          images: f.images.filter(function (i) { return i && i.trim(); })
        });
      }
      return data;
    }

    vm.submit = function () {
      vm.fieldErrors = {};
      vm.formError = null;
      vm.saving = true;
      api.post('/submissions', payload()).then(function (s) {
        vm.saving = false;
        vm.result = s;
        $window.scrollTo(0, 0);
        loadNotes();
      }, function (e) {
        vm.saving = false;
        vm.formError = e.message;
        vm.fieldErrors = (e.details && e.details.fields) || {};
      });
    };

    // ---------------------------------------------------------------- orders
    function loadOrders() { return api.get('/orders').then(function (o) { vm.orders = o; }, fail); }
    // A one-time code for the Telegram bot. The bot never asks for a password.
    vm.telegramCode = function () {
      vm.tgBusy = true;
      api.post('/telegram/link-code').then(function (r) {
        vm.tgCode = r.code;
        vm.tgBot = r.bot;
      }, function (e) { Toast.show(e.message); }).finally(function () { vm.tgBusy = false; });
    };
    vm.advance = function (item) {
      api.post('/shipments/' + item.shipment_id + '/advance').then(function () {
        Toast.show('Shipment #' + item.shipment_id + ' marked ' + item.next_stage.replace(/_/g, ' ') + '.');
        loadOrders();
      }, function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- assistant
    // Panel text in English and Telugu; the panel itself is static/common/chat.html.
    vm.chat = AssistantChat({
      api: api,
      storageKey: 'eq.seller.lang',
      signedIn: function () { return vm.user; },
      linkFor: function (p) { return '#/edit/' + p.id; },
      texts: {
        en: {
          fab: 'Seller help', title: 'Seller Central assistant', close: 'Close assistant',
          hello: 'Hi! Ask me about listing rules and reviews, your inventory, orders to dispatch, or payments.',
          suggestions: ['Why is my latest change waiting for review?', 'Which orders do I need to ship?', 'What is my unsettled balance?'],
          placeholder: 'Ask a question', listening: 'Listening…', send: 'Send', thinking: 'Looking that up…', linkPrefix: 'Edit: ',
          mic: 'Ask by voice', micStop: 'Stop listening', readAloud: 'Read replies aloud', handsFree: 'Hands-free',
          handsFreeHint: 'After each spoken reply, listen for the next question', stop: 'Stop speaking',
          unavailable: "The assistant isn't available right now.",
          noVoice: 'This device has no English voice, so replies are shown as text only.',
          note: "Answers come from an AI and can be wrong. It can look things up but can't change your listings or orders.",
          voiceNote: 'Voice input is turned into text by your browser.'
        },
        te: {
          fab: 'సెల్లర్ సహాయం', title: 'సెల్లర్ సెంట్రల్ సహాయకుడు', close: 'సహాయకుడిని మూసివేయి',
          hello: 'నమస్కారం! లిస్టింగ్ నియమాలు, రివ్యూలు, మీ ఇన్వెంటరీ, పంపాల్సిన ఆర్డర్లు లేదా చెల్లింపుల గురించి నన్ను అడగండి.',
          suggestions: ['నా తాజా మార్పు రివ్యూలో ఎందుకు ఉంది?', 'నేను ఏ ఆర్డర్లు పంపాలి?', 'నా సెటిల్ కాని బ్యాలెన్స్ ఎంత?'],
          placeholder: 'ప్రశ్న అడగండి', listening: 'వింటున్నాను…', send: 'పంపు', thinking: 'చూస్తున్నాను…', linkPrefix: 'సవరించు: ',
          mic: 'వాయిస్‌తో అడగండి', micStop: 'వినడం ఆపు', readAloud: 'సమాధానాలు చదివి వినిపించు', handsFree: 'హ్యాండ్స్-ఫ్రీ',
          handsFreeHint: 'ప్రతి సమాధానం తర్వాత తదుపరి ప్రశ్న కోసం వింటుంది', stop: 'మాట్లాడటం ఆపు',
          unavailable: 'సహాయకుడు ప్రస్తుతం అందుబాటులో లేదు.',
          noVoice: 'ఈ పరికరంలో తెలుగు వాయిస్ లేదు, కాబట్టి సమాధానాలు టెక్స్ట్‌గా మాత్రమే చూపబడతాయి. Edge బ్రౌజర్‌లో తెలుగు వాయిస్ ఉంటుంది.',
          note: 'సమాధానాలు AI నుండి వస్తాయి, తప్పులు ఉండవచ్చు. ఇది సమాచారం చూడగలదు కానీ మీ లిస్టింగ్‌లు లేదా ఆర్డర్లను మార్చలేదు.',
          voiceNote: 'మీ వాయిస్‌ను మీ బ్రౌజర్ టెక్స్ట్‌గా మారుస్తుంది.'
        }
      }
    });
    function loadChat() { vm.chat.load(); }
  }]);
