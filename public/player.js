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
  var viewMode = 'vr';    // 'vr' (headset: stereo + lens correction) | '360' (handheld magic window)
  var gotGyro = false;
  var firstGyro = true;

  // ------------------------------------------------------------- three.js
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3)); // full Retina — 2x visibly softens video
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  var camera = new THREE.PerspectiveCamera(80, 1, 0.1, 1000);

  var texture = new THREE.VideoTexture(vid);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy(); // sharp at glancing angles on the sphere

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
  // --- Cardboard lens-correction pipeline --------------------------------
  // Each eye renders to a texture; a barrel-distortion pass then counteracts
  // the pincushion distortion of the headset lenses (the round "fisheye"
  // viewports real Cardboard apps show). k1/k2 are Cardboard v2-ish
  // coefficients; FOV is widened to optics scale so the world feels 1:1.
  var VR_FOV = 96;
  var IPD = 0.064; // metres between the eye cameras (real depth on 3D content)

  var rtL = null, rtR = null;
  var distScene = new THREE.Scene();
  var distCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  var distMat = new THREE.ShaderMaterial({
    uniforms: { tex: { value: null }, k1: { value: 0.34 }, k2: { value: 0.55 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'varying vec2 vUv;',
      'uniform sampler2D tex; uniform float k1; uniform float k2;',
      'void main() {',
      '  vec2 uv = vUv * 2.0 - 1.0;',
      '  float r2 = dot(uv, uv);',
      '  float f = (1.0 + k1 * r2 + k2 * r2 * r2) / (1.0 + k1 + k2);',
      '  vec2 suv = uv * f * 0.5 + 0.5;',
      '  if (suv.x <= 0.001 || suv.x >= 0.999 || suv.y <= 0.001 || suv.y >= 0.999) {',
      '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return;',
      '  }',
      '  float vig = smoothstep(1.0, 0.92, length(uv));',
      '  gl_FragColor = vec4(texture2D(tex, suv).rgb * vig, 1.0);',
      '}',
    ].join('\n'),
    depthTest: false,
    depthWrite: false,
  });
  distScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), distMat));

  var eyeShift = new THREE.Vector3();

  function allocTargets() {
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var tw = Math.max(2, Math.floor(window.innerWidth / 2 * dpr * 1.15)); // slight supersample:
    var th = Math.max(2, Math.floor(window.innerHeight * dpr * 1.15));    // distortion magnifies the centre
    if (rtL) rtL.dispose();
    if (rtR) rtR.dispose();
    rtL = new THREE.WebGLRenderTarget(tw, th, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    rtR = new THREE.WebGLRenderTarget(tw, th, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }

  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    allocTargets();
  }
  window.addEventListener('resize', onResize);
  onResize();

  function renderEye(layer, sign, rt) {
    camera.layers.set(layer);
    eyeShift.set(sign * IPD / 2, 0, 0).applyQuaternion(camera.quaternion);
    camera.position.copy(eyeShift);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  }

  function animate() {
    requestAnimationFrame(animate);
    updateCamera();
    if (typeof reticle !== 'undefined' && reticle) updateGaze(viewMode !== '360');
    var w = window.innerWidth, h = window.innerHeight;

    if (viewMode === '360') {
      // magic window: one fullscreen undistorted view, look around by moving the phone
      camera.layers.set(1);
      camera.position.set(0, 0, 0);
      camera.fov = 80;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.render(scene, camera);
      return;
    }

    var half = Math.floor(w / 2);
    camera.fov = VR_FOV;
    camera.aspect = half / h;
    camera.updateProjectionMatrix();
    renderEye(1, -1, rtL);
    renderEye(2, 1, rtR);
    renderer.setScissorTest(true);
    distMat.uniforms.tex.value = rtL.texture;
    renderer.setViewport(0, 0, half, h);
    renderer.setScissor(0, 0, half, h);
    renderer.render(distScene, distCam);
    distMat.uniforms.tex.value = rtR.texture;
    renderer.setViewport(half, 0, w - half, h);
    renderer.setScissor(half, 0, w - half, h);
    renderer.render(distScene, distCam);
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

  function setGroup(id, val) {
    document.getElementById(id).querySelectorAll('button').forEach(function (x) {
      x.classList.toggle('on', x.dataset.v === val);
    });
  }

  function bindGroup(id, key, apply) {
    var grp = document.getElementById(id);
    grp.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      setGroup(id, b.dataset.v);
      apply(b.dataset.v);
      try { localStorage.setItem('vrp.' + key, b.dataset.v); } catch (err) { /* private mode */ }
      rebuild();
    });
    // restore last-used setting
    var saved = null;
    try { saved = localStorage.getItem('vrp.' + key); } catch (err) { /* private mode */ }
    if (saved && grp.querySelector('[data-v="' + saved + '"]')) {
      setGroup(id, saved);
      apply(saved);
    }
  }

  var divider = document.getElementById('divider');
  function updateDivider() { divider.style.display = viewMode === 'vr' ? '' : 'none'; }

  bindGroup('proj', 'projection', function (v) { projection = v; });
  bindGroup('stereo', 'stereo', function (v) { stereo = v; });
  bindGroup('view', 'view', function (v) { viewMode = v; updateDivider(); });
  updateDivider();
  rebuild();

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

  // ------------------------------------------------- gaze (dwell) VR menu
  // In-headset controls: look at a button and hold your gaze — a ring fills
  // around the reticle and the button triggers. No touch needed.
  var DWELL_MS = 1500; // hold-to-select time

  scene.add(camera); // so the reticle can ride on the camera

  function uiRoundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function labelTexture(text, active) {
    var c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    var g = c.getContext('2d');
    g.fillStyle = active ? 'rgba(58, 128, 190, 0.95)' : 'rgba(16, 20, 28, 0.85)';
    uiRoundRect(g, 6, 14, 244, 100, 24);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.lineWidth = 3;
    uiRoundRect(g, 6, 14, 244, 100, 24);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '600 44px -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 66);
    return new THREE.CanvasTexture(c);
  }

  function makeButton(label, action, w) {
    var mat = new THREE.MeshBasicMaterial({ map: labelTexture(label, false), transparent: true });
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w || 0.55, 0.28), mat);
    m.userData = { action: action, tex: mat.map, texHover: labelTexture(label, true) };
    m.layers.enable(1);
    m.layers.enable(2);
    return m;
  }

  var vrUI = { panelOpen: false, gazeTarget: null, gazeStart: 0, lastPanelUse: 0, buttons: [], toggleBtn: null };

  // "menu" pill floating off to the right of your view — out of the way of
  // the video, one glance away. It holds still while you look at it and only
  // re-parks to your right when you've turned far away.
  var OPENER_OFFSET = 0.75; // ~43° to the right
  var opener = makeButton('☰ Menu', 'open', 0.6);
  opener.position.set(0, -0.55, -1.98); // ~16° below the group's facing
  var openerGroup = new THREE.Group();
  openerGroup.rotation.y = -OPENER_OFFSET;
  openerGroup.add(opener);
  scene.add(openerGroup);

  var panel = new THREE.Group();
  [
    ['↩ 5s', 'back', -0.62, 0],
    ['▶', 'toggle', 0, 0],
    ['5s ↪', 'fwd', 0.62, 0],
    ['⟳ Recenter', 'recenter', -0.33, -0.34],
    ['✕ Close', 'close', 0.33, -0.34],
  ].forEach(function (d) {
    var b = makeButton(d[0], d[1], 0.55);
    b.position.set(d[2], d[3] - 0.45, -2);
    panel.add(b);
    vrUI.buttons.push(b);
    if (d[1] === 'toggle') vrUI.toggleBtn = b;
  });
  // gaze-seekable timeline: a marker follows your gaze along the bar; hold
  // steady and it seeks to that time
  var seekCanvas = document.createElement('canvas');
  seekCanvas.width = 512;
  seekCanvas.height = 80;
  var seekCtx = seekCanvas.getContext('2d');
  var seekTex = new THREE.CanvasTexture(seekCanvas);
  var seekBar3D = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 0.26),
    new THREE.MeshBasicMaterial({ map: seekTex, transparent: true })
  );
  seekBar3D.position.set(0, -0.12, -2);
  seekBar3D.userData = { action: 'seekbar' };
  seekBar3D.layers.enable(1);
  seekBar3D.layers.enable(2);
  panel.add(seekBar3D);
  vrUI.buttons.push(seekBar3D);

  function fmtT(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60), sec = ('0' + (s % 60)).slice(-2);
    return Math.floor(m / 60) ? Math.floor(m / 60) + ':' + ('0' + (m % 60)).slice(-2) + ':' + sec : m + ':' + sec;
  }

  function drawSeekBar(gazeFrac) {
    var g = seekCtx, W = 512, H = 80;
    var dur = totalDuration || vid.duration || 0;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(16,20,28,0.85)';
    uiRoundRect(g, 2, 46, W - 4, 22, 11);
    g.fill();
    if (dur) {
      var pos = Math.min(1, (baseOffset + (vid.currentTime || 0)) / dur);
      if (pos > 0.01) {
        g.fillStyle = '#4b8fd4';
        uiRoundRect(g, 2, 46, Math.max(12, pos * (W - 4)), 22, 11);
        g.fill();
      }
      if (gazeFrac !== null && gazeFrac !== undefined) {
        var x = Math.max(8, Math.min(W - 8, gazeFrac * W));
        g.fillStyle = '#fff';
        g.fillRect(x - 2, 40, 4, 34);
        g.font = '600 28px -apple-system, sans-serif';
        g.textAlign = 'center';
        g.fillText(fmtT(gazeFrac * dur), Math.max(40, Math.min(W - 40, x)), 28);
      }
    }
    seekTex.needsUpdate = true;
  }
  drawSeekBar(null);

  panel.visible = false;
  scene.add(panel);

  function refreshToggleLabel() {
    var label = vid.paused ? '▶ Play' : '❘❘ Pause';
    var b = vrUI.toggleBtn;
    b.userData.tex = labelTexture(label, false);
    b.userData.texHover = labelTexture(label, true);
    b.material.map = (vrUI.gazeTarget === b) ? b.userData.texHover : b.userData.tex;
  }
  vid.addEventListener('play', refreshToggleLabel);
  vid.addEventListener('pause', refreshToggleLabel);

  // reticle dot + dwell progress ring, fixed at the centre of vision
  var reticle = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false })
  );
  reticle.position.set(0, 0, -1.5);
  reticle.renderOrder = 999;
  reticle.layers.enable(1);
  reticle.layers.enable(2);
  camera.add(reticle);

  var ring = new THREE.Mesh(
    new THREE.RingGeometry(0.016, 0.027, 32),
    new THREE.MeshBasicMaterial({ color: 0x6cb2f7, transparent: true, opacity: 0.95, depthTest: false })
  );
  ring.position.set(0, 0, -1.49);
  ring.renderOrder = 1000;
  ring.visible = false;
  ring.layers.enable(1);
  ring.layers.enable(2);
  camera.add(ring);

  function setRingProgress(frac) {
    ring.geometry.dispose();
    ring.geometry = new THREE.RingGeometry(0.016, 0.027, 32, 1, -Math.PI / 2, Math.max(0.001, frac * Math.PI * 2));
  }

  function yawOf(quat) {
    var f = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    return Math.atan2(-f.x, -f.z);
  }

  function showPanel() {
    panel.rotation.y = yawOf(camera.quaternion); // open facing the user
    vrUI.panelOpen = true;
    vrUI.lastPanelUse = Date.now();
  }
  function hidePanel() { vrUI.panelOpen = false; }

  function gazeAction(action) {
    if (action === 'open') showPanel();
    else if (action === 'close') hidePanel();
    else if (action === 'toggle') togglePlay();
    else if (action === 'back') skipBy(-5);
    else if (action === 'fwd') skipBy(5);
    else if (action === 'recenter') recenter();
    if (action !== 'open' && action !== 'close') vrUI.lastPanelUse = Date.now();
  }

  var raycaster = new THREE.Raycaster();
  var gazeOrigin = new THREE.Vector3();
  var gazeDir = new THREE.Vector3();

  function updateGaze(inVR) {
    reticle.visible = inVR;
    openerGroup.visible = inVR && !vrUI.panelOpen;
    panel.visible = inVR && vrUI.panelOpen;
    if (!inVR) { ring.visible = false; return; }

    // re-park the pill to your right only when you've turned well away from
    // it — a dead zone keeps it still while you're looking at or near it
    if (openerGroup.visible) {
      var desired = yawOf(camera.quaternion) - OPENER_OFFSET;
      var cur = openerGroup.rotation.y;
      var d = Math.atan2(Math.sin(desired - cur), Math.cos(desired - cur));
      if (Math.abs(d) > 1.2) openerGroup.rotation.y = cur + d * 0.08;
    }
    if (vrUI.panelOpen && Date.now() - vrUI.lastPanelUse > 12000) hidePanel();

    var targets = vrUI.panelOpen ? vrUI.buttons : [opener];
    gazeDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    raycaster.set(gazeOrigin.set(0, 0, 0), gazeDir);
    var hit = raycaster.intersectObjects(targets, false)[0];
    var btn = hit ? hit.object : null;
    var onSeekbar = btn && btn.userData.action === 'seekbar';

    if (btn !== vrUI.gazeTarget) {
      var prev = vrUI.gazeTarget;
      if (prev && prev.userData.tex) prev.material.map = prev.userData.tex;
      vrUI.gazeTarget = btn;
      vrUI.gazeStart = Date.now();
      if (onSeekbar) vrUI.seekFrac = hit.uv.x;
      if (btn) {
        if (btn.userData.texHover) btn.material.map = btn.userData.texHover;
        vrUI.lastPanelUse = Date.now();
        setRingProgress(0);
      }
      ring.visible = !!btn;
    } else if (btn) {
      vrUI.lastPanelUse = Date.now();
      if (onSeekbar) {
        // dwell restarts whenever the gaze slides along the bar — it only
        // fires after holding STILL on one spot
        var f = hit.uv.x;
        if (Math.abs(f - vrUI.seekFrac) > 0.035) {
          vrUI.seekFrac = f;
          vrUI.gazeStart = Date.now();
        }
      }
      var frac = (Date.now() - vrUI.gazeStart) / DWELL_MS;
      setRingProgress(Math.min(1, frac));
      if (frac >= 1) {
        if (onSeekbar) {
          var dur = totalDuration || vid.duration || 0;
          if (dur) {
            seekTo(vrUI.seekFrac * dur);
            showToast('▶ ' + fmtT(vrUI.seekFrac * dur));
          }
          vrUI.gazeStart = Date.now(); // re-arm without leaving the bar
          setRingProgress(0);
        } else {
          if (btn.userData.tex) btn.material.map = btn.userData.tex;
          gazeAction(btn.userData.action);
          vrUI.gazeTarget = null;
          ring.visible = false;
        }
      }
    }

    // live progress + gaze marker on the timeline while the panel is open
    if (vrUI.panelOpen) drawSeekBar(onSeekbar ? vrUI.seekFrac : null);
  }

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
