/* Equidron Seller Central. */
angular.module('seller', ['eqCommon']).controller('SellerCtrl', ['$location', '$window', '$timeout', 'Api', 'Router', 'Toast', 'Voice',
  function ($location, $window, $timeout, Api, Router, Toast, Voice) {
    var api = Api('seller');
    var vm = this;
    vm.user = null;
    vm.meta = {};
    vm.auth = { form: {} };
    vm.unread = 0;

    function fail(e) { vm.err = e.message; }

    function loadMe() {
      return api.get('/me').then(function (r) {
        vm.user = r.user;
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
      if (!vm.user && r.name !== 'login') { $location.path('/login'); return; }
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
      }
    }

    loadMe().finally(function () { Router(route); });

    vm.login = function () {
      vm.auth.error = null;
      api.post('/login', vm.auth.form).then(function (r) {
        vm.user = r.user;
        vm.auth.form = {};
        api.get('/meta').then(function (m) { vm.meta = m; });
        loadNotes();
        loadChat();
        $location.path('/');
      }, function (e) { vm.auth.error = e.message; });
    };
    vm.useDemo = function (email) { vm.auth.form = { email: email, password: 'equidron-demo' }; };
    vm.logout = function () {
      api.post('/logout').then(function () { vm.closeChat(); vm.user = null; vm.chat.messages = []; $location.path('/login'); });
    };

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
    vm.advance = function (item) {
      api.post('/shipments/' + item.shipment_id + '/advance').then(function () {
        Toast.show('Shipment #' + item.shipment_id + ' marked ' + item.next_stage.replace(/_/g, ' ') + '.');
        loadOrders();
      }, function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- assistant
    vm.chat = {
      open: false, messages: [], input: '', sending: false, available: true,
      suggestions: ['Why is my latest change waiting for review?', 'Which orders do I need to ship?', 'What is my unsettled balance?']
    };
    function loadChat() { api.get('/assistant').then(function (r) { vm.chat.available = r.available; }); }
    function scrollChat() {
      $timeout(function () { var log = $window.document.getElementById('chat-log'); if (log) log.scrollTop = log.scrollHeight; });
    }
    // byVoice: the question was spoken, so the reply is read aloud and kept short.
    vm.sendChat = function (text, byVoice) {
      text = String(text || vm.chat.input || '').trim();
      if (!text || vm.chat.sending) return;
      vm.chat.error = null;
      vm.chat.messages.push({ role: 'user', content: text });
      vm.chat.input = '';
      vm.chat.sending = true;
      scrollChat();
      var history = vm.chat.messages.map(function (m) { return { role: m.role, content: m.content }; });
      api.post('/assistant', { messages: history, voice: !!byVoice }).then(function (r) {
        vm.chat.messages.push({ role: 'assistant', content: r.reply, products: r.products });
        if (byVoice || vm.voice.readAloud) speakReply(r.reply);
      }, function (e) {
        // Keep the conversation alternating: take the unanswered question back into the box.
        vm.chat.messages.pop();
        vm.chat.input = text;
        vm.chat.error = e.message;
        vm.voice.handsFree = false;
      }).finally(function () { vm.chat.sending = false; scrollChat(); });
    };

    // ---------------------------------------------------------------- voice
    // Mic: speech becomes the question and is sent when the seller stops talking.
    // Hands-free: after each spoken reply, listen for the next question.
    vm.voice = { canListen: Voice.canListen, canSpeak: Voice.canSpeak, listening: false, speaking: false, readAloud: false, handsFree: false };

    function startListening() {
      if (!vm.chat.open || vm.chat.sending) return;
      vm.stopSpeaking();
      vm.chat.error = null;
      vm.voice.listening = Voice.listen({
        interim: function (t) { vm.chat.input = t; },
        final: function (t) { vm.chat.input = ''; vm.sendChat(t, true); },
        end: function () { vm.voice.listening = false; },
        error: function (msg) { vm.chat.error = msg; vm.voice.handsFree = false; }
      });
    }
    function stopListening() { Voice.stopListening(); vm.voice.listening = false; }
    function speakReply(text) {
      if (!vm.voice.canSpeak) return;
      vm.voice.speaking = true;
      Voice.speak(text, function () {
        if (!vm.voice.speaking) return; // stopped by the seller
        vm.voice.speaking = false;
        if (vm.voice.handsFree) startListening();
      });
    }
    vm.toggleMic = function () {
      if (vm.voice.listening) { stopListening(); vm.voice.handsFree = false; } else startListening();
    };
    vm.stopSpeaking = function () { vm.voice.speaking = false; Voice.stopSpeaking(); };
    vm.readAloudChanged = function () {
      if (!vm.voice.readAloud) { vm.voice.handsFree = false; vm.stopSpeaking(); }
    };
    vm.handsFreeChanged = function () {
      if (vm.voice.handsFree) {
        vm.voice.readAloud = true;
        if (!vm.voice.listening && !vm.voice.speaking) startListening();
      } else {
        stopListening();
      }
    };
    vm.closeChat = function () {
      vm.voice.handsFree = false;
      stopListening();
      vm.stopSpeaking();
      vm.chat.open = false;
    };
  }]);
