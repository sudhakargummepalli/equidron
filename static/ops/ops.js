/* Equidron Ops: listing review, logistics simulator, returns, support, settlement. */
angular.module('ops', ['eqCommon']).controller('OpsCtrl', ['$location', '$window', 'Api', 'Router', 'Toast', 'AuthForm', 'SecurityPanel',
  function ($location, $window, Api, Router, Toast, AuthForm, SecurityPanel) {
    var api = Api('ops');
    var vm = this;
    vm.auth = AuthForm(api, {
      demoAccounts: [{ email: 'ops@example.com', label: 'ops@example.com (admin)' },
        { email: 'support@example.com', label: 'support@example.com' }, { email: 'finance@example.com', label: 'finance@example.com' }],
      signedIn: function (user) { vm.user = user; $location.path('/'); },
    });
    vm.auth.note = 'Internal reviewers and operations staff only.';
    vm.security = SecurityPanel(api, signedOut);
    // Mirrors auth.hasPermission on the server, which is what actually enforces it.
    vm.can = function (p) { var ps = (vm.user && vm.user.permissions) || []; return ps.indexOf('admin') >= 0 || ps.indexOf(p) >= 0; };
    vm.CONTENT = ['title', 'brand', 'category', 'description', 'specs', 'images'];

    function fail(e) { vm.err = e.message; }
    function refreshOverview() { return api.get('/overview').then(function (o) { vm.overview = o; }); }

    function route(r) {
      vm.route = r;
      vm.err = null;
      if (!vm.user && r.name !== 'login' && r.name !== 'reset') { $location.path('/login'); return; }
      if (vm.user) refreshOverview();
      switch (r.name) {
        case '': return vm.can('catalog') ? loadReviews() : null;
        case 'reviews': return loadReviews();
        case 'shipments': return loadShipments();
        case 'returns': return api.get('/returns').then(function (x) { vm.returns = x; }, fail);
        case 'support': return api.get('/support').then(function (x) { vm.tickets = x; }, fail);
        case 'settlement': return loadSettlement();
        case 'login': if (vm.user) $location.path('/'); return;
        case 'reset': vm.auth.startReset(r.search.code); return;
        case 'security': return vm.security.load();
        case 'staff': return loadStaff();
        case 'audit': return api.get('/audit').then(function (x) { vm.audit = x; }, fail);
        case 'outbox': return api.get('/outbox').then(function (x) { vm.outbox = x; }, fail);
        case 'system': return vm.loadSystem();
        case 'approvals': return loadApprovals();
        case 'agents': return loadAgents();
        case 'runs': return loadRuns();
        case 'tasks': return loadTasks();
        case 'guardrails': return loadGuardrails();
        case 'incidents': return loadIncidents();
        case 'analytics': return loadAnalytics();
      }
    }

    api.get('/me').then(function (r) { vm.user = r.user; vm.auth.demo = r.demo; }).finally(function () { Router(route); });

    function signedOut() { vm.user = null; $location.path('/login'); }
    vm.logout = function () { api.post('/logout').then(signedOut); };

    // ---------------------------------------------------------------- system (admin)
    vm.loadSystem = function () { return api.get('/system').then(function (x) { vm.system = x; }, fail); };
    vm.setSetting = function (key) {
      api.post('/settings', { key: key, value: vm.system.settings[key] }).then(function (s) {
        vm.system.settings = s; Toast.show('Saved.');
      }, function (e) { Toast.show(e.message); vm.loadSystem(); });
    };
    vm.retryJob = function (j) {
      api.post('/jobs/' + j.id + '/retry').then(function () { Toast.show('Job #' + j.id + ' will run again.'); vm.loadSystem(); },
        function (e) { Toast.show(e.message); });
    };
    vm.testError = function () {
      api.post('/system/test-error').then(null, function (e) { Toast.show('Test error sent: ' + e.message); vm.loadSystem(); });
    };

    // ---------------------------------------------------------------- staff (admin)
    function loadStaff() {
      return api.get('/staff').then(function (x) {
        x.staff.forEach(function (s) {
          s.edit = {};
          s.permissions.forEach(function (p) { s.edit[p] = true; });
        });
        vm.staff = x;
      }, fail);
    }
    vm.savePermissions = function (s) {
      var chosen = vm.staff.permissions.filter(function (p) { return s.edit[p]; });
      api.post('/staff/' + s.id + '/permissions', { permissions: chosen }).then(function () {
        s.error = null; Toast.show('Permissions saved for ' + s.name + '.');
      }, function (e) { s.error = e.message; });
    };

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
    // Building a batch moves no money; approving it does. That is the whole point of the split.
    function loadSettlement() {
      return api.get('/settlement').then(function (x) { vm.settlement = x; }, fail);
    }
    vm.settle = function () {
      vm.busy = true;
      api.post('/settlement/run').then(function (r) {
        vm.batch = r.batch;
        Toast.show('Batch #' + r.batch.id + ' built. Nothing has been paid yet.');
        loadSettlement();
        refreshOverview();
      }, function (e) { Toast.show(e.message); }).finally(function () { vm.busy = false; });
    };
    vm.decideBatch = function (id, approve) {
      var path = '/settlement/batches/' + id + (approve ? '/approve' : '/reject');
      api.post(path, approve ? {} : { note: 'Rejected in Ops.' }).then(function (b) {
        vm.batch = b;
        Toast.show(approve ? 'Approved. The payouts are in the ledger.' : 'Rejected. Nothing was paid.');
        loadSettlement();
        refreshOverview();
      }, function (e) { Toast.show(e.message); });
    };

    // ---------------------------------------------------------------- approvals
    function loadApprovals() {
      return api.get('/approvals', { status: 'pending' }).then(function (x) {
        vm.approvals = x.approvals;
        vm.pendingApprovals = x.pending;
      }, fail);
    }
    vm.loadApprovals = loadApprovals;
    vm.decideApproval = function (a, approve) {
      api.post('/approvals/' + a.id + '/decide', { approve: approve, note: a.decision_note }).then(function (r) {
        Toast.show('Approval #' + a.id + (approve ? ' approved; the action ran.' : ' rejected.'));
        vm.approvalResult = r;
        loadApprovals(); refreshOverview();
      }, function (e) { Toast.show(e.message); loadApprovals(); });
    };

    // ---------------------------------------------------------------- agents
    function loadAgents() {
      return api.get('/agents').then(function (x) {
        vm.agents = x.agents;
        vm.agentsPaused = x.paused;
        vm.levelList = Object.keys(x.levels).map(function (k) { return { value: Number(k), label: 'L' + k + ' · ' + x.levels[k] }; });
        vm.spentTodayUsd = x.spent_today_usd;
        vm.brief = x.brief;
        vm.openTasks = x.open_tasks;
      }, fail);
    }
    vm.loadAgents = loadAgents;
    vm.saveAgent = function (a) {
      api.post('/agents/' + a.id, {
        enabled: a.enabled, autonomy_level: a.autonomy_level, model: a.model,
        daily_budget_usd: a.daily_budget_usd, max_steps: a.max_steps,
      }).then(function (saved) {
        a.enabled = saved.enabled; a.autonomy_level = saved.autonomy_level; a.model = saved.model;
        a.daily_budget_usd = saved.daily_budget_usd; a.max_steps = saved.max_steps;
        Toast.show(a.name + ' saved.');
        refreshOverview();
      }, function (e) { Toast.show(e.message); loadAgents(); });
    };
    vm.pauseAll = function (paused) {
      api.post('/agents/pause-all', { paused: paused }).then(function (r) {
        vm.agentsPaused = r.paused;
        Toast.show(r.paused ? 'All agents paused.' : 'Agents unpaused.');
        refreshOverview();
      }, function (e) { Toast.show(e.message); });
    };
    vm.runAgent = function (a) {
      a.run_message = 'Running...';
      api.post('/agents/' + a.id + '/run', { task: a.task }).then(function (run) {
        a.run_message = 'Run #' + run.id + ': ' + run.status + (run.summary ? ' — ' + run.summary : '');
        Toast.show('Run #' + run.id + ' ' + run.status + '.');
        loadAgents(); refreshOverview();
      }, function (e) {
        a.run_message = e.message;
        Toast.show(e.message);
      });
    };

    // ---------------------------------------------------------------- agent runs
    function loadRuns() {
      return api.get('/agent-runs').then(function (x) { vm.runs = x.runs; }, fail);
    }
    vm.loadRuns = loadRuns;
    vm.openRun = function (r) {
      api.get('/agent-runs/' + r.id).then(function (x) { vm.runDetail = x; }, fail);
    };

    // ---------------------------------------------------------------- tasks
    function loadTasks() {
      return api.get('/tasks').then(function (x) { vm.tasks = x.tasks; vm.doneTasks = x.done; }, fail);
    }
    vm.loadTasks = loadTasks;
    vm.closeTask = function (t) {
      api.post('/tasks/' + t.id + '/done').then(function () {
        Toast.show('Task closed.');
        loadTasks(); refreshOverview();
      }, function (e) { Toast.show(e.message); loadTasks(); });
    };

    // ---------------------------------------------------------------- guardrails
    function loadGuardrails() {
      return api.get('/guardrails').then(function (x) { vm.guardEvents = x.events; vm.guardCounts = x.counts; }, fail);
    }
    vm.loadGuardrails = loadGuardrails;

    // ---------------------------------------------------------------- incidents
    function loadIncidents() {
      return api.get('/incidents').then(function (x) { vm.incidents = x; }, fail);
    }
    vm.loadIncidents = loadIncidents;

    // ---------------------------------------------------------------- analytics
    vm.aMonths = 12;
    function loadAnalytics(months) {
      vm.aMonths = months || vm.aMonths;
      return api.get('/analytics', { months: vm.aMonths }).then(function (x) { vm.analytics = x; }, fail);
    }
    vm.loadAnalytics = loadAnalytics;
  }]);
