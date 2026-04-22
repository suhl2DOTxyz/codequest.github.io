(() => {
  const canvas = document.getElementById('gameCanvas');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11141a);
  scene.fog = new THREE.Fog(0x11141a, 28, 120);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 500);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const light = new THREE.DirectionalLight(0xffffff, 1.05);
  light.position.set(35, 50, 20);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0x8fa8c6, 0.5));

  const BLOCK = {
    AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAF: 5, IRON: 6
  };

  const BLOCK_DEF = {
    [BLOCK.GRASS]: { name: 'Grass', color: 0x4ca957, solid: true },
    [BLOCK.DIRT]: { name: 'Dirt', color: 0x7e5332, solid: true },
    [BLOCK.STONE]: { name: 'Stone', color: 0x7e8287, solid: true },
    [BLOCK.WOOD]: { name: 'Wood', color: 0x9a7246, solid: true },
    [BLOCK.LEAF]: { name: 'Leaf', color: 0x2f7f44, solid: true },
    [BLOCK.IRON]: { name: 'Iron', color: 0x6ba4c7, solid: true }
  };

  const mats = Object.fromEntries(Object.entries(BLOCK_DEF).map(([id, def]) => [id, new THREE.MeshLambertMaterial({ color: def.color })]));
  const geo = new THREE.BoxGeometry(1, 1, 1);

  const world = new Map();
  const meshByKey = new Map();
  const generatedChunks = new Set();
  const CHUNK = 16;
  const VIEW_RADIUS = 2;
  const overrides = { placed: new Map(), removed: new Set() };
  const oreHighlights = [];

  const key = (x, y, z) => `${x},${y},${z}`;
  const fromKey = (k) => k.split(',').map(Number);

  function hash2(x, z) {
    const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function heightAt(x, z) {
    const n = Math.sin(x * 0.09) * 3 + Math.cos(z * 0.08) * 3 + Math.sin((x + z) * 0.03) * 4;
    return Math.floor(12 + n);
  }

  function getGeneratedType(x, y, z) {
    const h = heightAt(x, z);
    if (y > h) return BLOCK.AIR;
    if (y === h) return BLOCK.GRASS;
    if (y >= h - 3) return BLOCK.DIRT;
    if (y < h - 7 && hash2(x * 2, z * 2) > 0.86) return BLOCK.IRON;
    return BLOCK.STONE;
  }

  function getBlock(x, y, z) {
    const k = key(x, y, z);
    if (overrides.removed.has(k)) return BLOCK.AIR;
    if (overrides.placed.has(k)) return overrides.placed.get(k);
    return world.get(k) ?? BLOCK.AIR;
  }

  function addBlockMesh(x, y, z, type) {
    if (!BLOCK_DEF[type]) return;
    const k = key(x, y, z);
    if (meshByKey.has(k)) return;
    const mesh = new THREE.Mesh(geo, mats[type]);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pos = { x, y, z };
    scene.add(mesh);
    meshByKey.set(k, mesh);
  }

  function removeBlockMesh(x, y, z) {
    const k = key(x, y, z);
    const mesh = meshByKey.get(k);
    if (!mesh) return;
    scene.remove(mesh);
    meshByKey.delete(k);
  }

  function setBlock(x, y, z, type, source = 'world') {
    const k = key(x, y, z);
    if (type === BLOCK.AIR) {
      world.delete(k);
      removeBlockMesh(x, y, z);
      return;
    }
    world.set(k, type);
    addBlockMesh(x, y, z, type);
    if (source === 'player-place') {
      overrides.placed.set(k, type);
      overrides.removed.delete(k);
    } else if (source === 'player-mine') {
      overrides.placed.delete(k);
      overrides.removed.add(k);
    }
  }

  function maybeSpawnTree(x, y, z) {
    if (hash2(x + 40, z - 22) < 0.985) return;
    const h = 3 + Math.floor(hash2(x, z) * 3);
    for (let i = 1; i <= h; i++) setBlock(x, y + i, z, BLOCK.WOOD);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = h - 1; dy <= h + 1; dy++) {
          if (Math.abs(dx) + Math.abs(dz) < 4) {
            if (getBlock(x + dx, y + dy, z + dz) === BLOCK.AIR) setBlock(x + dx, y + dy, z + dz, BLOCK.LEAF);
          }
        }
      }
    }
  }

  function chunkId(cx, cz) { return `${cx},${cz}`; }

  function generateChunk(cx, cz) {
    const id = chunkId(cx, cz);
    if (generatedChunks.has(id)) return;
    generatedChunks.add(id);

    const sx = cx * CHUNK;
    const sz = cz * CHUNK;
    for (let x = sx; x < sx + CHUNK; x++) {
      for (let z = sz; z < sz + CHUNK; z++) {
        const h = heightAt(x, z);
        for (let y = 0; y <= h; y++) {
          setBlock(x, y, z, getGeneratedType(x, y, z));
        }
        if (h > 6) maybeSpawnTree(x, h, z);
      }
    }
  }

  function ensureChunksAround(px, pz) {
    const ccx = Math.floor(px / CHUNK);
    const ccz = Math.floor(pz / CHUNK);
    for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
      for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) generateChunk(ccx + dx, ccz + dz);
    }
  }

  const state = {
    vel: new THREE.Vector3(),
    pos: new THREE.Vector3(0, 22, 0),
    yaw: 0,
    pitch: 0,
    onGround: false,
    health: 100,
    energy: 100,
    time: 480,
    selected: 0,
    terminalOpen: false
  };

  const inventory = [
    { type: BLOCK.GRASS, count: 20 },
    { type: BLOCK.DIRT, count: 30 },
    { type: BLOCK.STONE, count: 40 },
    { type: BLOCK.WOOD, count: 16 },
    { type: BLOCK.IRON, count: 4 }
  ];

  const keys = new Set();
  let pointerLocked = false;

  function solidAt(x, y, z) {
    const t = getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    return BLOCK_DEF[t]?.solid === true;
  }

  function collides(px, py, pz) {
    const w = 0.32;
    const minX = px - w, maxX = px + w;
    const minY = py, maxY = py + 1.8;
    const minZ = pz - w, maxZ = pz + w;
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          if (BLOCK_DEF[getBlock(x, y, z)]?.solid) return true;
        }
      }
    }
    return false;
  }

  function moveAndCollide(dt) {
    state.vel.y -= 23 * dt;
    if (state.onGround && state.vel.y < 0) state.vel.y = -0.2;

    const speed = keys.has('ShiftLeft') ? 7.5 : 5.4;
    const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.add(forward);
    if (keys.has('KeyS')) move.sub(forward);
    if (keys.has('KeyA')) move.sub(right);
    if (keys.has('KeyD')) move.add(right);
    move.normalize();

    const friction = state.onGround ? 16 : 6;
    state.vel.x += (move.x * speed - state.vel.x) * Math.min(1, friction * dt);
    state.vel.z += (move.z * speed - state.vel.z) * Math.min(1, friction * dt);

    const nx = state.pos.x + state.vel.x * dt;
    if (!collides(nx, state.pos.y, state.pos.z)) {
      state.pos.x = nx;
    } else {
      state.vel.x = 0;
    }

    const nz = state.pos.z + state.vel.z * dt;
    if (!collides(state.pos.x, state.pos.y, nz)) {
      state.pos.z = nz;
    } else {
      state.vel.z = 0;
    }

    const ny = state.pos.y + state.vel.y * dt;
    if (!collides(state.pos.x, ny, state.pos.z)) {
      state.pos.y = ny;
      state.onGround = false;
    } else {
      if (state.vel.y < 0) state.onGround = true;
      state.vel.y = 0;
    }

    if (state.pos.y < -5) {
      state.health = Math.max(0, state.health - 22 * dt);
      state.pos.set(0, 24, 0);
      state.vel.set(0, 0, 0);
    }
  }

  const raycaster = new THREE.Raycaster();
  let target = null;

  function pickTarget() {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const meshes = Array.from(meshByKey.values());
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length || hits[0].distance > 7) {
      target = null;
      return;
    }
    target = hits[0];
  }

  function mineBlock() {
    if (!target) return;
    const p = target.object.userData.pos;
    const t = getBlock(p.x, p.y, p.z);
    if (t === BLOCK.AIR || p.y <= 0) return;
    setBlock(p.x, p.y, p.z, BLOCK.AIR, 'player-mine');
    const slot = inventory.find((s) => s.type === t);
    if (slot) slot.count += 1;
    else inventory[state.selected] = { type: t, count: 1 };
    renderHotbar();
  }

  function placeBlock() {
    if (!target) return;
    const slot = inventory[state.selected];
    if (!slot || slot.count <= 0) return;
    const p = target.object.userData.pos;
    const n = target.face.normal;
    const nx = p.x + n.x, ny = p.y + n.y, nz = p.z + n.z;
    if (getBlock(nx, ny, nz) !== BLOCK.AIR) return;
    if (collides(nx + 0.5, ny, nz + 0.5)) return;
    setBlock(nx, ny, nz, slot.type, 'player-place');
    slot.count -= 1;
    renderHotbar();
  }

  const hotbarEl = document.getElementById('hotbar');
  const hpEl = document.getElementById('healthBar');
  const enEl = document.getElementById('energyBar');

  function renderHotbar() {
    hotbarEl.innerHTML = '';
    inventory.forEach((slot, i) => {
      const el = document.createElement('div');
      el.className = `slot ${i === state.selected ? 'selected' : ''}`;
      el.innerHTML = `<div>${BLOCK_DEF[slot.type]?.name ?? 'Empty'}</div><div class="count">${slot.count}</div><div>${i + 1}</div>`;
      hotbarEl.appendChild(el);
    });
    hpEl.style.width = `${state.health}%`;
    enEl.style.width = `${state.energy}%`;
  }

  const termEl = document.getElementById('terminal');
  const termLog = document.getElementById('terminalLog');
  const termInput = document.getElementById('terminalInput');

  function termPrint(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    termLog.appendChild(line);
    termLog.scrollTop = termLog.scrollHeight;
  }

  function clearScan() {
    oreHighlights.forEach((m) => scene.remove(m));
    oreHighlights.length = 0;
  }

  function cmdScan() {
    clearScan();
    const p = state.pos;
    let found = 0;
    for (let x = Math.floor(p.x) - 12; x <= Math.floor(p.x) + 12; x++) {
      for (let y = Math.max(1, Math.floor(p.y) - 8); y <= Math.floor(p.y) + 8; y++) {
        for (let z = Math.floor(p.z) - 12; z <= Math.floor(p.z) + 12; z++) {
          if (getBlock(x, y, z) === BLOCK.IRON) {
            found++;
            const marker = new THREE.Mesh(new THREE.BoxGeometry(1.04, 1.04, 1.04), new THREE.MeshBasicMaterial({ color: 0x39f6f6, wireframe: true }));
            marker.position.set(x + 0.5, y + 0.5, z + 0.5);
            scene.add(marker);
            oreHighlights.push(marker);
          }
        }
      }
    }
    termPrint(`Scan complete: ${found} iron nodes marked.`);
  }

  function gameTimeText() {
    const total = Math.floor(state.time % 1440);
    const h = String(Math.floor(total / 60)).padStart(2, '0');
    const m = String(total % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  function handleCommand(raw) {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    termPrint(`> ${cmd}`);
    if (cmd === 'help') {
      termPrint('Commands: help, status, scan, time, clear');
    } else if (cmd === 'status') {
      termPrint(`HP ${state.health.toFixed(0)} | EN ${state.energy.toFixed(0)} | POS ${state.pos.x.toFixed(1)}, ${state.pos.y.toFixed(1)}, ${state.pos.z.toFixed(1)}`);
    } else if (cmd === 'scan') {
      cmdScan();
    } else if (cmd === 'time') {
      termPrint(`In-game time ${gameTimeText()}`);
    } else if (cmd === 'clear') {
      termLog.innerHTML = '';
    } else {
      termPrint('Unknown command. Type help.');
    }
  }

  function toggleTerminal(open) {
    state.terminalOpen = open;
    termEl.classList.toggle('hidden', !open);
    if (open) {
      document.exitPointerLock();
      setTimeout(() => termInput.focus(), 0);
      termPrint('Terminal online. Type help.');
    } else {
      termInput.blur();
    }
  }

  termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleCommand(termInput.value);
      termInput.value = '';
    }
  });

  function saveGame() {
    const data = {
      pos: state.pos.toArray(),
      vel: state.vel.toArray(),
      health: state.health,
      energy: state.energy,
      time: state.time,
      inventory,
      selected: state.selected,
      placed: Array.from(overrides.placed.entries()),
      removed: Array.from(overrides.removed.values())
    };
    localStorage.setItem('codequest-save-v1', JSON.stringify(data));
  }

  function loadGame() {
    const raw = localStorage.getItem('codequest-save-v1');
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data.pos)) state.pos.fromArray(data.pos);
      if (Array.isArray(data.vel)) state.vel.fromArray(data.vel);
      if (Array.isArray(data.inventory)) {
        data.inventory.forEach((v, i) => {
          if (inventory[i]) inventory[i] = v;
        });
      }
      state.health = data.health ?? 100;
      state.energy = data.energy ?? 100;
      state.time = data.time ?? 480;
      state.selected = data.selected ?? 0;
      overrides.placed.clear();
      overrides.removed.clear();
      (data.placed ?? []).forEach(([k, v]) => overrides.placed.set(k, v));
      (data.removed ?? []).forEach((k) => overrides.removed.add(k));
      return true;
    } catch {
      return false;
    }
  }

  function applyOverrides() {
    overrides.removed.forEach((k) => {
      const [x, y, z] = fromKey(k);
      setBlock(x, y, z, BLOCK.AIR);
    });
    overrides.placed.forEach((type, k) => {
      const [x, y, z] = fromKey(k);
      setBlock(x, y, z, type);
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'Tab' || e.code === 'KeyT') {
      e.preventDefault();
      toggleTerminal(!state.terminalOpen);
      return;
    }
    if (state.terminalOpen) return;
    keys.add(e.code);
    if (e.code === 'Space' && state.onGround) {
      state.vel.y = 8.8;
      state.onGround = false;
    }
    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < inventory.length) {
      state.selected = idx;
      renderHotbar();
    }
  });

  window.addEventListener('keyup', (e) => keys.delete(e.code));

  canvas.addEventListener('click', () => {
    if (!state.terminalOpen) canvas.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
  });

  window.addEventListener('mousemove', (e) => {
    if (!pointerLocked || state.terminalOpen) return;
    state.yaw -= e.movementX * 0.0022;
    state.pitch -= e.movementY * 0.0022;
    state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch));
  });

  window.addEventListener('mousedown', (e) => {
    if (state.terminalOpen) return;
    if (e.button === 0) mineBlock();
    if (e.button === 2) placeBlock();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('beforeunload', saveGame);
  setInterval(saveGame, 10000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  ensureChunksAround(0, 0);
  loadGame();
  ensureChunksAround(state.pos.x, state.pos.z);
  applyOverrides();
  renderHotbar();

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!state.terminalOpen) {
      moveAndCollide(dt);
      state.energy = Math.min(100, state.energy + (state.onGround ? 6 : 2) * dt);
    }

    ensureChunksAround(state.pos.x, state.pos.z);
    state.time = (state.time + dt * 3.2) % 1440;

    camera.position.copy(state.pos).add(new THREE.Vector3(0, 1.62, 0));
    camera.rotation.order = 'YXZ';
    camera.rotation.y = state.yaw;
    camera.rotation.x = state.pitch;

    const sunlight = 0.25 + Math.max(0, Math.sin((state.time / 1440) * Math.PI * 2)) * 0.9;
    light.intensity = sunlight;

    pickTarget();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
