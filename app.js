/* Gardens Route Recorder — capture a real GPS walk, mark POIs/checkpoints,
 * and POST the route to the aisee-gardens-backend Apps Script API.
 *
 * No build step, no pasted config. The backend is a LOGIN PROXY: "Sign in with
 * Google" navigates the tab to the backend (Google-gated), which redirects back
 * with an HMAC session token in the URL fragment. We store that token and send
 * it on writes; the backend verifies it. The Maps key + projects come from the
 * backend's `bootstrap` after login.
 *
 * Geolocation needs a secure context: https:// or http://localhost. */

'use strict';

// The one platform backend (pinned /exec). Override only via advanced settings.
var BACKEND_URL  = 'https://script.google.com/macros/s/AKfycbyjH-U0ysuHbifKyMnbvimng4XrDALgsG89s-CU11nqdcKzPXnmw9WyD4zZOewnENHvbA/exec';
var SESSION_KEY  = 'aiseeRecorder.session';   // { email, name, token }
var NONCE_KEY    = 'aiseeRecorder.nonce';
var PROJECT_KEY  = 'aiseeRecorder.projectId';
var OVERRIDE_KEY = 'aiseeRecorder.backendOverride';

var $ = function (id) { return document.getElementById(id); };

function backendUrl() { try { return localStorage.getItem(OVERRIDE_KEY) || BACKEND_URL; } catch (e) { return BACKEND_URL; } }
function returnUrl()  { return location.href.split('#')[0].split('?')[0]; }
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} AUTH = null; }

/* ── State ───────────────────────────────────────────────── */
var AUTH = null;          // { email, name, token }
var mapsKey = '';
var map, meMarker, accCircle, trackPoly;
var trackPath = [];      // [{lat,lng}] raw GPS samples while recording
var marks = [];          // [{kind, lat, lng, accuracy_m, marker, name?, category?, briefing_md?, geofence_radius_m?}]
var recording = false, started = false, follow = true, lastFix = null, watchId = null, pendingPoi = null;

/* ── Boot ────────────────────────────────────────────────── */
window.addEventListener('load', function () {
  // Mobile-only: the recorder needs a phone's GPS. Desktops (except localhost
  // dev) get a friendly "open on your phone" screen with a QR to this URL.
  if (!isMobileDevice() && !isLocalDev()) { showDesktopBlock(); return; }
  wireUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  handleAuthCallback();          // catch #token=… coming back from the broker
  AUTH = loadSession();
  if (AUTH && AUTH.token) startAuthed();
  else showSignIn();
});

/* ── Device gate (mobile-only) ───────────────────────────── */
function isLocalDev() {
  var h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '';
}
function isMobileDevice() {
  // Prefer the explicit hint when the browser provides it (Chromium).
  try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (e) {}
  var ua = navigator.userAgent || navigator.vendor || '';
  if (/Android|iPhone|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile/i.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari — detect the touch screen instead.
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}
function showDesktopBlock() {
  var url = location.origin + location.pathname;
  var a = $('dbUrl'); a.textContent = url; a.href = url;
  $('dbQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=' + encodeURIComponent(url);
  show('desktopBlock');
}

/* ── Login broker flow (AHL pattern; no Google Identity Services) ───── */
function showSignIn(msg) { $('signinMsg').textContent = msg || ''; show('signinSheet'); }

function startAuthed() {
  hide('signinSheet');
  setProfile(AUTH.name || AUTH.email || '', AUTH.email || '');
  bootstrap();
}

/* Fill the profile balloon's name + email. */
function setProfile(name, email) {
  $('popName').textContent = name || '(not signed in)';
  $('popEmail').textContent = email || '';
}

function signIn() {
  var nonce = randomNonce();
  try { localStorage.setItem(NONCE_KEY, nonce); }
  catch (e) { alert('Your browser blocked site storage; sign-in needs it (try a non-private window).'); return; }
  location.assign(backendUrl() + '?action=login&return=' + encodeURIComponent(returnUrl()) + '&nonce=' + encodeURIComponent(nonce));
}

function handleAuthCallback() {
  if (!location.hash || location.hash.indexOf('token=') === -1) return;
  var p = parseHash(location.hash);
  var expected = ''; try { expected = localStorage.getItem(NONCE_KEY) || ''; } catch (e) {}
  if (p.token && p.nonce && expected && p.nonce === expected) {
    try { localStorage.removeItem(NONCE_KEY); } catch (e) {}
    saveSession({ email: p.email || '', name: p.name || '', token: p.token });
  }
  history.replaceState(null, '', location.pathname + location.search); // strip the fragment
}

function parseHash(h) {
  var out = {};
  h.replace(/^#/, '').split('&').forEach(function (kv) {
    var i = kv.indexOf('='); if (i === -1) return;
    out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

function randomNonce() {
  try { var b = new Uint8Array(16); crypto.getRandomValues(b); return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  catch (e) { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
}

/* Post-login: fetch identity + Maps key + projects, then start the map. */
function bootstrap() {
  fetch(backendUrl() + '?action=bootstrap&auth=' + encodeURIComponent(AUTH.token))
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.ok) { clearSession(); showSignIn((res && res.error) || 'Session expired — please sign in again.'); return; }
      setProfile((res.user && (res.user.name || res.user.email)) || AUTH.name || AUTH.email,
                 (res.user && res.user.email) || AUTH.email || '');
      fillProjects(res.projects || [], res.defaultProjectId || '');
      mapsKey = res.mapsKey || '';
      if (!mapsKey) { showMapMsg('No Maps key set on the backend — run setMapsApiKey() in the editor.'); return; }
      ensureMaps(mapsKey, function (ok) {
        if (!ok) { showMapMsg('Google Maps failed to load — check the key, enabled APIs, and billing.'); return; }
        initMap(); startGeo();
      });
    })
    .catch(function (e) { showMapMsg('Could not reach the backend: ' + e.message); });
}

function fillProjects(projects, defaultProjectId) {
  var sel = $('projSel');
  while (sel.options.length > 1) sel.remove(1);
  projects.forEach(function (p) { var o = document.createElement('option'); o.value = p.project_id; o.textContent = p.name; sel.appendChild(o); });
  var saved = ''; try { saved = localStorage.getItem(PROJECT_KEY) || ''; } catch (e) {}
  sel.value = saved || defaultProjectId || ((projects[0] || {}).project_id) || '';
}

/* ── Google Maps loader ──────────────────────────────────── */
var mapsReady = false, mapsLoading = false, mapsCbs = [];
function ensureMaps(key, cb) {
  if (mapsReady) return cb(true);
  if (!key) return cb(false);
  mapsCbs.push(cb);
  if (mapsLoading) return;
  mapsLoading = true;
  window.__gmReady = function () { mapsReady = true; mapsCbs.splice(0).forEach(function (f) { f(true); }); };
  var s = document.createElement('script');
  s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=geometry&callback=__gmReady&loading=async';
  s.async = true;
  s.onerror = function () { mapsLoading = false; mapsCbs.splice(0).forEach(function (f) { f(false); }); };
  document.head.appendChild(s);
}

function showMapMsg(t) { $('map').innerHTML = '<div class="map-msg">' + t + '</div>'; }

function initMap() {
  map = new google.maps.Map($('map'), {
    center: { lat: 1.3066, lng: 103.8155 }, zoom: 17, mapTypeId: 'roadmap',
    disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy'
  });
  map.addListener('dragstart', function () { follow = false; });
  trackPoly = new google.maps.Polyline({ map: map, path: [], strokeColor: '#1B4332', strokeOpacity: .95, strokeWeight: 5 });
  meMarker = new google.maps.Marker({ map: map, zIndex: 999,
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#1769ff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 } });
  accCircle = new google.maps.Circle({ map: map, fillColor: '#1769ff', fillOpacity: .10, strokeColor: '#1769ff', strokeOpacity: .35, strokeWeight: 1 });
  $('hud').hidden = false;
}

/* ── Geolocation ─────────────────────────────────────────── */
function startGeo() {
  if (!navigator.geolocation) { toast('No geolocation on this device'); return; }
  watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function onErr(e) { setGps(null); toast('GPS error: ' + (e && e.message || e)); }
function onPos(pos) {
  var c = pos.coords;
  lastFix = { lat: c.latitude, lng: c.longitude, accuracy_m: Math.round(c.accuracy) };
  setGps(lastFix.accuracy_m);
  var ll = { lat: lastFix.lat, lng: lastFix.lng };
  if (meMarker) meMarker.setPosition(ll);
  if (accCircle) { accCircle.setCenter(ll); accCircle.setRadius(Math.max(c.accuracy, 3)); }
  if (recording) {
    trackPath.push(ll); trackPoly.setPath(trackPath); updateDist();
  }
  if (follow && map) map.panTo(ll);
}
function setGps(acc) {
  var dot = $('gpsDot'), txt = $('gpsText');
  if (acc == null) { dot.className = 'dot'; txt.textContent = 'no fix'; return; }
  dot.className = 'dot ' + (acc <= 10 ? 'ok' : acc <= 30 ? 'mid' : '');
  txt.textContent = '±' + acc + 'm';
}

/* ── Recording + marking ─────────────────────────────────── */
function setRecording(on) {
  recording = on;
  $('recBtn').classList.toggle('on', on);
  $('recBtn').querySelector('span:last-child').textContent = on ? 'Pause' : (started ? 'Resume' : 'Record');
  $('recDot').hidden = !on;
  if (on) {
    started = true;
    follow = true;
    ['cpBtn', 'poiBtn', 'finBtn'].forEach(function (id) { $(id).disabled = false; });
    if (lastFix) { trackPath.push({ lat: lastFix.lat, lng: lastFix.lng }); trackPoly.setPath(trackPath); }
  }
}

function addCheckpoint() {
  if (!lastFix) return toast('Waiting for GPS fix…');
  var m = { kind: 'checkpoint', lat: lastFix.lat, lng: lastFix.lng, accuracy_m: lastFix.accuracy_m };
  m.marker = new google.maps.Marker({ map: map, position: { lat: m.lat, lng: m.lng }, title: 'checkpoint',
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: '#2D6A4F', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
  marks.push(m); afterMark('Checkpoint dropped');
}

function openPoi() {
  if (!lastFix) return toast('Waiting for GPS fix…');
  pendingPoi = { lat: lastFix.lat, lng: lastFix.lng, accuracy_m: lastFix.accuracy_m };
  $('poiCoord').textContent = fmt(pendingPoi.lat) + ', ' + fmt(pendingPoi.lng) + '  (±' + pendingPoi.accuracy_m + 'm)';
  $('poiName').value = ''; $('poiCat').value = ''; $('poiBrief').value = ''; $('poiRad').value = '20';
  show('poiSheet'); setTimeout(function () { $('poiName').focus(); }, 50);
}
function savePoi() {
  var name = $('poiName').value.trim();
  if (!name) return toast('POI needs a name');
  var m = { kind: 'poi', lat: pendingPoi.lat, lng: pendingPoi.lng, accuracy_m: pendingPoi.accuracy_m,
    name: name, category: $('poiCat').value.trim(), briefing_md: $('poiBrief').value.trim(),
    geofence_radius_m: Number($('poiRad').value) || 20 };
  var n = marks.filter(function (x) { return x.kind === 'poi'; }).length + 1;
  m.marker = new google.maps.Marker({ map: map, position: { lat: m.lat, lng: m.lng }, title: name,
    label: { text: String(n), color: '#fff', fontSize: '11px', fontWeight: '700' } });
  new google.maps.Circle({ map: map, center: { lat: m.lat, lng: m.lng }, radius: m.geofence_radius_m,
    fillColor: '#2D6A4F', fillOpacity: .12, strokeColor: '#2D6A4F', strokeOpacity: .5, strokeWeight: 1 });
  marks.push(m); hide('poiSheet'); afterMark('POI “' + name + '” dropped');
}

function undo() {
  var m = marks.pop(); if (!m) return;
  if (m.marker) m.marker.setMap(null);
  afterMark('Removed ' + m.kind);
}
function afterMark(msg) { updateCounts(); $('undoBtn').disabled = !marks.length; toast(msg); }

function updateCounts() {
  var cp = marks.filter(function (m) { return m.kind === 'checkpoint'; }).length;
  var po = marks.filter(function (m) { return m.kind === 'poi'; }).length;
  $('counts').textContent = cp + ' checkpoint' + (cp === 1 ? '' : 's') + ' · ' + po + ' POI' + (po === 1 ? '' : 's');
}
function updateDist() {
  if (!google.maps.geometry || trackPath.length < 2) { $('dist').textContent = ''; return; }
  var m = google.maps.geometry.spherical.computeLength(trackPath.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }));
  $('dist').textContent = m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
}

/* ── Save to backend ─────────────────────────────────────── */
function openSave() {
  setRecording(false);
  var cp = marks.filter(function (m) { return m.kind === 'checkpoint'; }).length;
  var po = marks.filter(function (m) { return m.kind === 'poi'; }).length;
  var dist = (google.maps.geometry && trackPath.length > 1)
    ? Math.round(google.maps.geometry.spherical.computeLength(trackPath.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }))) : 0;
  $('saveSummary').textContent = trackPath.length + ' GPS points · ' + cp + ' checkpoints · ' + po + ' POIs · ' + dist + ' m';
  $('saveMsg').textContent = ''; $('rName').value = '';
  show('saveSheet'); setTimeout(function () { $('rName').focus(); }, 50);
}

function doSave() {
  var name = $('rName').value.trim();
  var msg = $('saveMsg'); msg.className = 'msg';
  if (!name) { msg.textContent = 'Route name is required.'; msg.className = 'msg err'; return; }
  if (!AUTH || !AUTH.token) { msg.textContent = 'Please sign in first.'; msg.className = 'msg err'; hide('saveSheet'); showSignIn(); return; }
  var projectId = $('projSel').value;
  if (!projectId) { msg.textContent = 'Pick a project (top bar) before saving.'; msg.className = 'msg err'; return; }

  var checkpoints = marks.filter(function (m) { return m.kind === 'checkpoint'; })
    .map(function (m) { return { lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m, segment_note: 'checkpoint' }; });
  var pois = marks.filter(function (m) { return m.kind === 'poi'; })
    .map(function (m) { return { name: m.name, category: m.category, lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m, geofence_radius_m: m.geofence_radius_m, briefing_md: m.briefing_md }; });

  var snap = $('rSnap').checked;
  msg.textContent = snap ? 'Snapping path…' : 'Saving…';

  buildTrack(snap, checkpoints, function (track, distM) {
    var start = trackPath[0] || (marks[0] ? { lat: marks[0].lat, lng: marks[0].lng } : null);
    var payload = {
      action: 'route.create', auth: AUTH.token, projectId: projectId,
      name: name, description: $('rDesc').value.trim(), status: $('rStatus').value, tracking_mode: $('rTracking').value,
      distance_m: distM, est_duration_min: distM ? Math.max(1, Math.round(distM / 80)) : '',
      start_lat: start ? start.lat : '', start_lng: start ? start.lng : '',
      track_polyline: track, waypoints: checkpoints, pois: pois
    };
    msg.textContent = 'Saving…';
    fetch(backendUrl(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error || 'backend rejected the route');
        hide('saveSheet'); showResult(res.routeId);
      })
      .catch(function (e) { msg.textContent = 'Failed: ' + e.message; msg.className = 'msg err'; });
  }, function (err) { msg.textContent = err; msg.className = 'msg err'; });
}

/* Produce the (encoded polyline, distance) to save. With snap=false, that's the
 * raw recorded GPS track. With snap=true, ask the Directions API for a WALKING
 * path through the checkpoints and use that instead (falls back with an error
 * message if Directions is unavailable). cb(track, distM); errCb(message). */
function buildTrack(snap, checkpoints, cb, errCb) {
  var encode = function (pts) { return google.maps.geometry.encoding.encodePath(pts.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); })); };
  var len = function (pts) { return Math.round(google.maps.geometry.spherical.computeLength(pts.map(function (c) { return new google.maps.LatLng(c.lat, c.lng); }))); };

  if (!snap) {
    var track = (google.maps.geometry && trackPath.length) ? encode(trackPath) : '';
    cb(track, trackPath.length > 1 ? len(trackPath) : '');
    return;
  }
  if (checkpoints.length < 2) { errCb('Need ≥2 checkpoints to snap a path.'); return; }
  var wp = checkpoints.slice(0, 25);
  new google.maps.DirectionsService().route({
    origin: { lat: wp[0].lat, lng: wp[0].lng },
    destination: { lat: wp[wp.length - 1].lat, lng: wp[wp.length - 1].lng },
    waypoints: wp.slice(1, -1).map(function (c) { return { location: { lat: c.lat, lng: c.lng }, stopover: false }; }),
    travelMode: google.maps.TravelMode.WALKING
  }, function (result, status) {
    if (status !== 'OK' || !result.routes[0]) { errCb('Directions failed (' + status + '). Enable the Directions API for this key, or uncheck snap.'); return; }
    var ov = result.routes[0].overview_path.map(function (ll) { return { lat: ll.lat(), lng: ll.lng() }; });
    cb(encode(ov), len(ov));
  });
}

function showResult(routeId) {
  $('resTitle').textContent = 'Route saved';
  $('resBody').textContent = 'Created “' + routeId + '”. It now renders on the dashboard map.';
  $('resOpen').href = backendUrl() || '#';
  show('resultSheet');
}
function resetRoute() {
  marks.forEach(function (m) { if (m.marker) m.marker.setMap(null); });
  marks = []; trackPath = []; if (trackPoly) trackPoly.setPath([]);
  recording = false; started = false;
  $('recBtn').classList.remove('on'); $('recBtn').querySelector('span:last-child').textContent = 'Record'; $('recDot').hidden = true;
  ['cpBtn', 'poiBtn', 'finBtn', 'undoBtn'].forEach(function (id) { $(id).disabled = true; });
  updateCounts(); $('dist').textContent = '';
}

/* ── Profile balloon (identity + sign out) ──── */
function toggleProfile() {
  var pop = $('profilePop');
  if (!pop.hidden) { pop.hidden = true; return; }
  setProfile((AUTH && (AUTH.name || AUTH.email)) || '', (AUTH && AUTH.email) || '');
  pop.hidden = false;
}
function signOut() { clearSession(); hide('profilePop'); showSignIn('Signed out.'); }

/* ── UI wiring ───────────────────────────────────────────── */
function wireUi() {
  $('recBtn').addEventListener('click', function () { setRecording(!recording); });
  $('cpBtn').addEventListener('click', addCheckpoint);
  $('poiBtn').addEventListener('click', openPoi);
  $('undoBtn').addEventListener('click', undo);
  $('finBtn').addEventListener('click', openSave);
  $('profileBtn').addEventListener('click', toggleProfile);
  $('helpBtn').addEventListener('click', function () { show('helpScreen'); });
  $('helpClose').addEventListener('click', function () { hide('helpScreen'); });
  $('projSel').addEventListener('change', function () { try { localStorage.setItem(PROJECT_KEY, this.value); } catch (e) {} });
  $('poiSave').addEventListener('click', savePoi);
  $('saveGo').addEventListener('click', doSave);
  $('signinBtn').addEventListener('click', signIn);
  $('signOutBtn').addEventListener('click', signOut);
  $('resNew').addEventListener('click', resetRoute);
  document.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { hide(b.getAttribute('data-close')); });
  });

  // Dismiss the profile balloon on an outside click or Escape.
  document.addEventListener('click', function (e) {
    if ($('profilePop').hidden) return;
    if (e.target.closest('#profilePop') || e.target.closest('#profileBtn')) return;
    $('profilePop').hidden = true;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { $('profilePop').hidden = true; hide('helpScreen'); }
  });
}

/* ── Tiny helpers ────────────────────────────────────────── */
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
function fmt(n) { return Number(n).toFixed(5); }
var toastT;
function toast(t) { var el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 1900); }
