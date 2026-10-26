/* Offline-reviewed candidate only. No Google project or trigger is authorized yet. */
var WW = { state: 'WANWU_STATE_V1', drill: 'WANWU_DRILL_V1', sends: 'WANWU_SENDS_V1', gap: 1200000 };

function wwProps_() { return PropertiesService.getScriptProperties(); }
function wwConfig_(p) {
  var c = { origin: p.getProperty('WANWU_TARGET_ORIGIN'), webhook: p.getProperty('FEISHU_WEBHOOK'),
    secret: p.getProperty('FEISHU_SIGNING_SECRET'), trigger: p.getProperty('WANWU_TRIGGER_ID') };
  if (p.getProperty('WANWU_APPROVED') !== 'true' || p.getProperty('WANWU_ENABLED') !== 'true' ||
      c.origin !== 'https://101.96.210.187' || !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]+$/i.test(c.webhook || '') || !c.secret) {
    throw new Error('CONFIG_DISABLED_OR_INVALID');
  }
  return c;
}
function wwLock_(fn) {
  var lock = LockService.getScriptLock();
  // A signed two-message drill can hold this shared lock for several seconds.
  if (!lock.tryLock(15000)) throw new Error('CONCURRENT_CHECK_BLOCKED');
  try { return fn(wwProps_()); } finally { lock.releaseLock(); }
}
function wwRoom_(p) {
  // Conservative UTF-8 bound under the 500KB script-properties quota. Never delete history.
  if (JSON.stringify(p.getProperties()).length * 3 > 360000) throw new Error('AUDIT_STORAGE_REVIEW_REQUIRED');
}
function wwNew_(now) {
  return { version: 1, sequence: 0, lastRun: now, failures: 0, successes: 0, down: false, pending: null, events: [] };
}
function wwLoad_(p, key) {
  var raw = p.getProperty(key);
  if (!raw) throw new Error('STATE_MISSING_NO_AUTO_RESET');
  var s;
  try { s = JSON.parse(raw); } catch (_) { throw new Error('STATE_CORRUPT_REVIEW_REQUIRED'); }
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.sequence) || s.sequence < 0 ||
      !Number.isFinite(s.lastRun) || !Number.isSafeInteger(s.failures) || s.failures < 0 ||
      !Number.isSafeInteger(s.successes) || s.successes < 0 || typeof s.down !== 'boolean' || !Array.isArray(s.events) ||
      !Object.prototype.hasOwnProperty.call(s, 'pending') || (s.pending !== null && typeof s.pending !== 'object')) {
    throw new Error('STATE_CORRUPT_REVIEW_REQUIRED');
  }
  return s;
}
function wwSave_(p, key, s, phase) {
  wwRoom_(p);
  var raw = JSON.stringify(s);
  if (raw.length > 8000) throw new Error('STATE_SIZE_REVIEW_REQUIRED');
  var prefix = key === WW.drill ? 'D_' : 'P_';
  var changes = {};changes[key] = raw;
  if (phase === 'sample' || phase === 'intent') {
    var day = Math.floor(s.lastRun / 86400000), sampleKey = 'WANWU_SAMPLES_' + prefix + day;
    var previous = p.getProperty(sampleKey), bucket;
    try { bucket = previous ? JSON.parse(previous) : { version: 1, day: day, last: -1, data: '' }; }
    catch (_) { throw new Error('SAMPLE_HISTORY_REVIEW_REQUIRED'); }
    if (!bucket || bucket.version !== 1 || bucket.day !== day || !Number.isFinite(bucket.last) ||
        bucket.last >= s.lastRun || typeof bucket.data !== 'string') throw new Error('SAMPLE_HISTORY_REVIEW_REQUIRED');
    var sample = s.events[s.events.length - 1];
    var kinds = ['', 'PUBLIC_PATH_UNEXPECTED', 'PUBLIC_PATH_NETWORK_OR_FORMAT', 'PROBE_RESPONSE_TOO_LARGE', 'PROBE_RESPONSE_INVALID', 'SYNTHETIC_UNREACHABLE'];
    var kind = kinds.indexOf(sample.codes.join(','));
    if (kind < 0 || sample.healthy !== (kind === 0)) throw new Error('SAMPLE_CODE_REVIEW_REQUIRED');
    bucket.last = s.lastRun;
    bucket.data += (s.lastRun - day * 86400000).toString(36) + ':' + kind + (s.down ? '1' : '0') + ';';
    var history = JSON.stringify(bucket);
    if (history.length > 8000) throw new Error('SAMPLE_SIZE_REVIEW_REQUIRED');
    changes[sampleKey] = history;
  }
  var auditKey = 'WANWU_AUDIT_' + prefix + s.lastRun + '_' + s.sequence + '_' + phase;
  var audit = JSON.stringify({ at: s.lastRun, phase: phase, sequence: s.sequence, down: s.down,
    event: s.pending || s.events[s.events.length - 1] || null });
  if (phase !== 'sample') {
    if (p.getProperty(auditKey) && p.getProperty(auditKey) !== audit) throw new Error('AUDIT_CONFLICT_REVIEW_REQUIRED');
    changes[auditKey] = audit;
  }
  p.setProperties(changes, false);
  if (Object.keys(changes).some(function (k) { return p.getProperty(k) !== changes[k]; })) throw new Error('STATE_WRITE_REVIEW_REQUIRED');
}
function wwProbe_(c) {
  var urls = [c.origin + '/partner', c.origin + '/partner/api/v1/auth/me'];
  try {
    var rows = UrlFetchApp.fetchAll(urls.map(function (url) {
      return { url: url, method: 'get', followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true };
    }));
    if (rows.length !== 2) return { healthy: false, codes: ['PROBE_RESPONSE_INVALID'] };
    var html = rows[0].getContentText(), text = rows[1].getContentText();
    if (html.length > 32768 || text.length > 32768) return { healthy: false, codes: ['PROBE_RESPONSE_TOO_LARGE'] };
    var auth = JSON.parse(text);
    var ok = rows[0].getResponseCode() === 200 && html.indexOf('万物伙伴') >= 0 &&
      rows[1].getResponseCode() === 401 && auth && typeof auth === 'object' && !!auth.error;
    return { healthy: !!ok, codes: ok ? [] : ['PUBLIC_PATH_UNEXPECTED'] };
  } catch (_) { return { healthy: false, codes: ['PUBLIC_PATH_NETWORK_OR_FORMAT'] }; }
}
function wwSend_(c, event, now) {
  var timestamp = String(Math.floor(now / 1000));
  var sign = Utilities.base64Encode(Utilities.computeHmacSha256Signature('', timestamp + '\n' + c.secret));
  var payload = { timestamp: timestamp, sign: sign, msg_type: 'text', content: { text:
    '[万物伙伴运维通知]\n' + (event.drill ? '合成演练\n' : '') + '状态码：' + event.code + '\n事件：' + event.id + '\n来源：独立外部检测' } };
  try {
    var response = UrlFetchApp.fetch(c.webhook, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true });
    var raw = response.getContentText();
    if (raw.length > 8192) throw new Error();
    var body = JSON.parse(raw);
    if (response.getResponseCode() !== 200 || (body.code === undefined ? body.StatusCode : body.code) !== 0) throw new Error();
  } catch (_) { throw new Error('DELIVERY_UNKNOWN_OR_FAILED_REVIEW_REQUIRED'); }
}
function wwReserveSend_(p, now) {
  var raw = p.getProperty(WW.sends), previous;
  try { if (!raw) throw new Error(); previous = JSON.parse(raw); } catch (_) { throw new Error('SEND_LEDGER_REVIEW_REQUIRED'); }
  if (!Array.isArray(previous) || previous.some(function (n) { return !Number.isFinite(n) || n > now; })) throw new Error('SEND_LEDGER_REVIEW_REQUIRED');
  var recent = previous.filter(function (n) { return now - n < 86400000; });
  if (recent.length >= 24) throw new Error('DAILY_SEND_LIMIT_REVIEW_REQUIRED');
  recent.push(now);var next = JSON.stringify(recent);p.setProperty(WW.sends, next);
  if (p.getProperty(WW.sends) !== next) throw new Error('SEND_LEDGER_REVIEW_REQUIRED');
}
function wwApply_(p, key, s, result, c, now, drill) {
  if (s.pending) throw new Error('PENDING_DELIVERY_NO_AUTOMATIC_RETRY');
  if (now <= s.lastRun) throw new Error('CLOCK_OR_DUPLICATE_REVIEW_REQUIRED');
  var late = now - s.lastRun > WW.gap;
  if (late) { s.failures = 0; s.successes = 0; }
  s.lastRun = now;s.failures = result.healthy ? 0 : s.failures + 1;s.successes = result.healthy ? s.successes + 1 : 0;
  var code = late ? 'EXTERNAL_CHECK_DELAYED' : null;
  if (!s.down && s.failures >= 2) { s.down = true; code = 'PUBLIC_SERVICE_UNREACHABLE'; }
  else if (s.down && s.successes >= 2) { s.down = false; code = 'PUBLIC_SERVICE_RECOVERED'; }
  s.events.push({ at: now, healthy: result.healthy, codes: result.codes, eventCode: code });s.events = s.events.slice(-20);
  if (!code) { wwSave_(p, key, s, 'sample');return s; }
  wwReserveSend_(p, now);s.sequence += 1;
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key + ':' + s.sequence + ':' + now + ':' + code);
  var id = bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('').slice(0,16);
  s.pending = { id: id, code: code, at: now, drill: drill, delivery: 'intent_saved' };
  wwSave_(p, key, s, 'intent');wwSend_(c, s.pending, now);
  s.pending = null;s.events.push({ at: now, delivered: id, code: code, drill: drill });
  wwSave_(p, key, s, 'delivered');return s;
}
function initializeWanwuMonitor() {
  return wwLock_(function (p) {
    var c = wwConfig_(p);wwRoom_(p);
    if (p.getProperty(WW.state)) throw new Error('ALREADY_INITIALIZED_NO_RESET');
    if (p.getProperty(WW.sends) || p.getProperty(WW.drill)) throw new Error('PRIOR_HISTORY_NO_AUTO_RESET');
    var result = wwProbe_(c);
    if (!result.healthy) throw new Error('BOOTSTRAP_PROBE_FAILED');
    p.setProperty(WW.sends, '[]');
    wwSave_(p, WW.state, wwNew_(Date.now()), 'initialized');return 'INITIALIZED';
  });
}
function runWanwuMonitor(event) {
  return wwLock_(function (p) {
    var c = wwConfig_(p);wwRoom_(p);
    if (!c.trigger || !event || String(event.triggerUid) !== c.trigger) throw new Error('AUTOMATIC_TRIGGER_REQUIRED');
    var s = wwLoad_(p, WW.state);
    if (s.pending) throw new Error('PENDING_DELIVERY_NO_AUTOMATIC_RETRY');
    wwApply_(p, WW.state, s, wwProbe_(c), c, Date.now(), false);return 'CHECK_COMPLETE';
  });
}
function installWanwuMonitorTrigger() {
  return wwLock_(function (p) {
    wwConfig_(p);var s = wwLoad_(p, WW.state);
    if (s.pending) throw new Error('PENDING_DELIVERY_NO_AUTOMATIC_RETRY');
    var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'runWanwuMonitor'; });
    if (triggers.length) {
      if (triggers.length !== 1 || p.getProperty('WANWU_TRIGGER_ID') !== triggers[0].getUniqueId()) throw new Error('TRIGGER_REVIEW_REQUIRED');
      return 'ALREADY_INSTALLED';
    }
    if (p.getProperty('WANWU_TRIGGER_ID')) throw new Error('TRIGGER_MISSING_NO_AUTO_RECREATE');
    var t = ScriptApp.newTrigger('runWanwuMonitor').timeBased().everyMinutes(5).create();
    p.setProperty('WANWU_TRIGGER_ID', t.getUniqueId());return 'INSTALLED';
  });
}
function runWanwuSyntheticDrill() {
  return wwLock_(function (p) {
    var c = wwConfig_(p);wwRoom_(p);
    wwLoad_(p, WW.state);
    if (p.getProperty(WW.drill)) throw new Error('DRILL_ALREADY_ATTEMPTED_NO_REPLAY');
    var s = wwNew_(Date.now());wwSave_(p, WW.drill, s, 'initialized');
    [false,false,true,true].forEach(function (healthy) {
      s = wwApply_(p, WW.drill, s, { healthy: healthy, codes: healthy ? [] : ['SYNTHETIC_UNREACHABLE'] }, c, Math.max(Date.now(),s.lastRun+1), true);
    });return 'DRILL_COMPLETE';
  });
}
