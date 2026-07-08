'use strict';
/*
 * Cardboard VR player.
 * Renders the <video> onto the inside of a sphere (or a floating plane),
 * side-by-side for the headset lenses, with gyroscope head tracking.
 * The video src is always /stream on this same server — the Mac proxies
 * the actual bytes, so this page never talks to the video site.
 */
(function () {
  var vid = document.getElementById('vid');
  var canvas = document.getElementById('cv');
  var gate = document.getElementById('gate');
  var enterBtn = document.getElementById('enter');
  var gateStatus = document.getElementById('gate-status');
  var hud = document.getElementById('hud');
  var titleEl = document.getElementById('title');
  var toastEl = document.getElementById('toast');

  var projection = '360'; // '360' | '180' | 'flat'
  var stereo = 'mono';    // 'mono' | 'sbs'  | 'tb'
  var gotGyro = false;
  var firstGyro = true;

  // ------------------------------------------------------------- three.js
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  var camera = new THREE.PerspectiveCamera(80, 1, 0.1, 1000);

  var texture = new THREE.VideoTexture(vid);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  var meshL = null, meshR = null;

  function makeGeometry(proj) {
    var g;
    if (proj === '360') {
      g = new THREE.SphereGeometry(50, 64, 44);
      g.scale(-1, 1, 1);
    } else if (proj === '180') {
      // hemisphere in front of the viewer
      g = new THREE.SphereGeometry(50, 64, 44, Math.PI, Math.PI);
      g.scale(-1, 1, 1);
    } else {
      g = new THREE.PlaneGeometry(24, 13.5);
      g.translate(0, 0, -16);
    }
    return g;
  }

  // For stereoscopic sources each eye sees half the frame; remap UVs so both
  // eyes share ONE video texture (a single GPU upload per frame).
  function remapUV(geom, eye, mode) {
    if (mode === 'mono') return geom;
    var uv = geom.attributes.uv;
    for (var i = 0; i < uv.count; i++) {
      var u = uv.getX(i), v = uv.getY(i);
      if (mode === 'sbs') {
        u = u * 0.5 + (eye === 'R' ? 0.5 : 0);
      } else { // top/bottom: top half of the frame = left eye
        v = v * 0.5 + (eye === 'L' ? 0.5 : 0);
      }
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
    return geom;
  }

  function rebuild() {
    if (meshL) { scene.remove(meshL); meshL.geometry.dispose(); }
    if (meshR) { scene.remove(meshR); meshR.geometry.dispose(); }
    var mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    meshL = new THREE.Mesh(remapUV(makeGeometry(projection), 'L', stereo), mat);
    meshR = new THREE.Mesh(remapUV(makeGeometry(projection), 'R', stereo), mat);
    meshL.layers.set(1);
    meshR.layers.set(2);
    scene.add(meshL);
    scene.add(meshR);
  }
  rebuild();

  // ------------------------------------------------------ head orientation
  // Standard deviceorientation -> quaternion conversion (the classic
  // DeviceOrientationControls algorithm).
  var zee = new THREE.Vector3(0, 0, 1);
  var yAxis = new THREE.Vector3(0, 1, 0);
  var euler = new THREE.Euler();
  var q0 = new THREE.Quaternion();
  var qScreen = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
  var deviceQuat = new THREE.Quaternion();
  var yawOffset = new THREE.Quaternion();
  var manualYaw = 0, manualPitch = 0;

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return window.orientation || 0;
  }

  function onDeviceOrientation(e) {
    if (e.alpha === null || e.alpha === undefined) return;
    var alpha = THREE.MathUtils.degToRad(e.alpha);
    var beta = THREE.MathUtils.degToRad(e.beta || 0);
    var gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    var orient = THREE.MathUtils.degToRad(screenAngle());
    euler.set(beta, alpha, -gamma, 'YXZ');
    deviceQuat.setFromEuler(euler);
    deviceQuat.multiply(qScreen);
    deviceQuat.multiply(q0.setFromAxisAngle(zee, -orient));
    gotGyro = true;
    if (firstGyro) { firstGyro = false; recenter(); }
  }

  function recenter() {
    if (gotGyro) {
      var f = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuat);
      var yaw = Math.atan2(f.x, f.z);
      yawOffset.setFromAxisAngle(yAxis, Math.PI - yaw);
    } else {
      manualYaw = 0;
      manualPitch = 0;
    }
  }

  function updateCamera() {
    if (gotGyro) {
      camera.quaternion.multiplyQuaternions(yawOffset, deviceQuat);
    } else {
      camera.quaternion.setFromEuler(new THREE.Euler(manualPitch, manualYaw, 0, 'YXZ'));
    }
  }

  // drag-to-look fallback (desktop testing / gyro denied)
  var dragging = false, px = 0, py = 0;
  canvas.addEventListener('pointerdown', function (e) { dragging = true; px = e.clientX; py = e.clientY; });
  window.addEventListener('pointermove', function (e) {
    if (!dragging || gotGyro) return;
    manualYaw += (e.clientX - px) * 0.005;
    manualPitch += (e.clientY - py) * 0.005;
    manualPitch = Math.max(-1.5, Math.min(1.5, manualPitch));
    px = e.clientX; py = e.clientY;
  });
  window.addEventListener('pointerup', function () { dragging = false; });

  // ----------------------------------------------------------- render loop
  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }
  window.addEventListener('resize', onResize);
  onResize();

  function animate() {
    requestAnimationFrame(animate);
    updateCamera();
    var w = window.innerWidth, h = window.innerHeight;
    var half = Math.floor(w / 2);
    camera.aspect = half / h;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    // left eye
    camera.layers.set(1);
    renderer.setViewport(0, 0, half, h);
    renderer.setScissor(0, 0, half, h);
    renderer.render(scene, camera);
    // right eye
    camera.layers.set(2);
    renderer.setViewport(half, 0, w - half, h);
    renderer.setScissor(half, 0, w - half, h);
    renderer.render(scene, camera);
  }
  animate();

  // ------------------------------------------------------------ UI wiring
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function setStatus(msg) { gateStatus.textContent = msg; }

  function bindGroup(id, apply) {
    var grp = document.getElementById(id);
    grp.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      grp.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      apply(b.dataset.v);
      rebuild();
    });
  }
  bindGroup('proj', function (v) { projection = v; });
  bindGroup('stereo', function (v) { stereo = v; });

  var qualityGrp = document.getElementById('quality');
  qualityGrp.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    qualityGrp.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
    b.classList.add('on');
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'quality', height: Number(b.dataset.h) }));
      showToast(b.dataset.h === '0' ? 'Quality: auto (best)' : 'Quality: ' + b.textContent);
    } else {
      showToast('Not connected to Mac');
    }
  });

  function qLabel(h) { return h >= 4320 ? '8K' : h >= 2160 ? '4K' : h >= 1440 ? '2K' : h + 'p'; }

  // The quality menu reflects what THIS video actually offers.
  function buildQualityMenu(heights, active) {
    qualityGrp.innerHTML = '';
    var mk = function (h, label) {
      var b = document.createElement('button');
      b.dataset.h = h;
      b.textContent = label;
      if (Number(h) === Number(active)) b.classList.add('on');
      qualityGrp.appendChild(b);
    };
    mk(0, 'Auto');
    heights.slice(0, 6).forEach(function (h) { mk(h, qLabel(h)); });
    if (!qualityGrp.querySelector('.on')) qualityGrp.firstChild.classList.add('on');
  }

  // True fullscreen works on iPhone Safari since iOS 16.4. On older iOS the
  // call is a no-op — "Add to Home Screen" gives fullscreen there instead.
  function goFullscreen() {
    try {
      var el = document.documentElement;
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req) return;
      var p = req.call(el);
      if (p && p.catch) p.catch(function () {});
      if (screen.orientation && screen.orientation.lock) {
        var q = screen.orientation.lock('landscape');
        if (q && q.catch) q.catch(function () {});
      }
    } catch (e) { /* unsupported */ }
  }

  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }

  document.getElementById('fs').addEventListener('click', function () {
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    goFullscreen();
    setTimeout(function () {
      if (!fsElement()) {
        showToast('Fullscreen needs iOS 16.4+. Alternative: Share → Add to Home Screen, then open from that icon');
      }
    }, 700);
  });

  document.getElementById('recenter').addEventListener('click', recenter);
  document.getElementById('playpause').addEventListener('click', togglePlay);
  document.getElementById('back30').addEventListener('click', function () { skipBy(-5); });
  document.getElementById('fwd30').addEventListener('click', function () { skipBy(5); });

  function skipBy(dt) { seekTo(baseOffset + vid.currentTime + dt); }

  function seekTo(t) {
    t = Math.max(0, t);
    if (mode !== 'merge') {
      try { vid.currentTime = t; } catch (e) { /* ignore */ }
      return;
    }
    // within the already-transcoded region Safari can seek natively (HLS);
    // only jumps beyond it need a transcoder restart at the new offset
    var rel = t - baseOffset;
    try {
      for (var i = 0; i < vid.seekable.length; i++) {
        if (rel >= vid.seekable.start(i) && rel <= vid.seekable.end(i)) {
          vid.currentTime = rel;
          return;
        }
      }
    } catch (e) { /* fall through to reload */ }
    baseOffset = Math.floor(t);
    vid.src = '/stream?v=' + Date.now() + '&t=' + baseOffset;
    vid.load();
    attemptPlay();
  }

  // commands arriving from the Mac's /remote page
  function handleControl(msg) {
    if (msg.action === 'toggle') togglePlay();
    else if (msg.action === 'play') vid.play().catch(function () {});
    else if (msg.action === 'pause') vid.pause();
    else if (msg.action === 'skip') skipBy(Number(msg.value) || 0);
    else if (msg.action === 'seek') seekTo(Number(msg.value) || 0);
  }

  function togglePlay() {
    if (vid.paused) vid.play().catch(function () {});
    else vid.pause();
  }

  // single tap: toggle HUD; double tap: play/pause
  var lastTap = 0, tapTimer = null;
  canvas.addEventListener('click', function () {
    var now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer);
      togglePlay();
    } else {
      tapTimer = setTimeout(function () { hud.classList.toggle('show'); }, 320);
    }
    lastTap = now;
  });

  // ---------------------------------------------------------- entry gate
  enterBtn.addEventListener('click', function () {
    // fullscreen must be requested synchronously in the tap — the permission
    // dialog below consumes the gesture
    goFullscreen();
    var ready = Promise.resolve();
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      ready = DeviceOrientationEvent.requestPermission().then(function (r) {
        if (r !== 'granted') showToast('Gyroscope denied — drag to look around');
      }).catch(function () {});
    }
    ready.then(function () {
      window.addEventListener('deviceorientation', onDeviceOrientation);
      gate.style.display = 'none';
      if (vid.src) attemptPlay();
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').catch(function () {});
      }
    });
  });

  function attemptPlay() {
    var p = vid.play();
    if (p && p.catch) {
      p.catch(function () {
        // autoplay blocked — reuse the gate as a tap-to-play surface
        enterBtn.innerHTML = '&#9654;&nbsp; Tap to play';
        gate.style.display = 'flex';
      });
    }
  }

  vid.addEventListener('error', function () {
    var err = vid.error;
    showToast('Video error' + (err ? ' (code ' + err.code + ')' : ''));
  });
  vid.addEventListener('playing', function () { showToast('Playing'); });

  // -------------------------------------------------------------- WebSocket
  var ws;
  function connect() {
    ws = new WebSocket('wss://' + location.host + '/ws');
    ws.onopen = function () { setStatus('Connected — click "Send to VR" on your Mac'); };
    ws.onclose = function () {
      setStatus('Disconnected from Mac — retrying…');
      setTimeout(connect, 2000);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'status') { setStatus(msg.message); showToast(msg.message); }
      else if (msg.type === 'error') { setStatus('Error: ' + msg.message); showToast('⚠️ ' + msg.message); }
      else if (msg.type === 'video') loadVideo(msg);
      else if (msg.type === 'control') handleControl(msg);
    };
  }
  connect();

  // let the Mac's remote page mirror playback state
  setInterval(function () {
    if (!ws || ws.readyState !== 1 || !lastTitle) return;
    ws.send(JSON.stringify({
      type: 'state',
      title: lastTitle,
      t: baseOffset + (vid.currentTime || 0),
      duration: totalDuration || vid.duration || 0,
      paused: vid.paused,
    }));
  }, 1000);

  var lastTitle = null;
  var mode = 'direct';   // 'direct' (proxied file/HLS) | 'merge' (ffmpeg pipe)
  var baseOffset = 0;    // seconds already skipped server-side in merge mode
  var totalDuration = 0; // from yt-dlp (vid.duration is unusable in merge mode)

  function loadVideo(msg) {
    totalDuration = Number(msg.duration) || 0;
    // same video pushed again (e.g. quality change): resume where we were
    var resumeAt = (msg.title === lastTitle && !vid.ended && (baseOffset + vid.currentTime) > 1)
      ? baseOffset + vid.currentTime : 0;
    lastTitle = msg.title;
    mode = (msg.kind === 'merge' || msg.kind === 'transcode') ? 'merge' : 'direct';
    buildQualityMenu(msg.heights || [], msg.quality || 0);
    titleEl.textContent = msg.title || '';
    setStatus('Loading: ' + (msg.title || 'video'));
    showToast('▶ ' + (msg.title || 'video') + (msg.kind === 'merge' ? ' (hi-res)' : ''));

    var src = msg.src + '?v=' + Date.now(); // cache-bust so Safari refetches
    baseOffset = 0;
    if (mode === 'merge' && resumeAt > 2) {
      baseOffset = Math.floor(resumeAt - 1);
      src += '&t=' + baseOffset;
    }
    vid.src = src;
    vid.load();
    if (mode !== 'merge' && resumeAt > 2) {
      vid.addEventListener('loadedmetadata', function once() {
        vid.removeEventListener('loadedmetadata', once);
        try { vid.currentTime = Math.max(0, resumeAt - 1); } catch (e) { /* ignore */ }
      });
    }
    if (gate.style.display === 'none') attemptPlay();
  }
})();
