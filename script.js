(() => {
  const SAVE_KEY = 'codequest-save-v2';
  const canvas = document.getElementById('gameCanvas');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f141d);
  scene.fog = new THREE.Fog(0x0f141d, 35, 135);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 600);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(35, 52, 20);
  sun.castShadow = false;
  const hemi = new THREE.HemisphereLight(0x9cc9ff, 0x1e2530, 0.62);
  scene.add(sun, hemi);

  const hud = {
    health: document.getElementById('healthBar'),
    energy: document.getElementById('energyBar'),
    level: document.getElementById('levelText'),
    credits: document.getElementById('creditsText'),
    hotbar: document.getElementById('hotbar'),
    objective: document.getElementById('objectiveText'),
    notification: document.getElementById('notification')
  };

  const terminal = {
    root: document.getElementById('terminal'),
    log: document.getElementById('terminalLog'),
    input: document.getElementById('terminalInput')
  };

  const BLOCK = { AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4, LEAF: 5, IRON: 6 };
  const BLOCK_DEF = {
    [BLOCK.GRASS]: { name: 'Grass', color: 0x4eb05c, solid: true },
    [BLOCK.DIRT]: { name: 'Dirt', color: 0x82573a, solid: true },
    [BLOCK.STONE]: { name: 'Stone', color: 0x7f878e, solid: true },
    [BLOCK.WOOD]: { name: 'Wood', color: 0x9d7447, solid: true },
    [BLOCK.LEAF]: { name: 'Leaf', color: 0x2d7e46, solid: true },
    [BLOCK.IRON]: { name: 'Iron', color: 0x78bce8, solid: true, emissive: 0x0b2e4a }
  };

  const chunkSize = 16;
  const viewRadius = 3;
  const unloadRadius = viewRadius + 2;
  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  const mats = Object.fromEntries(Object.entries(BLOCK_DEF).map(([id, def]) => {
    const m = new THREE.MeshLambertMaterial({ color: def.color });
    if (def.emissive) {
      m.emissive = new THREE.Color(def.emissive);
      m.emissiveIntensity = 0.9;
    }
    return [id, m];
  }));

  const world = new Map();
  const meshByKey = new Map();
  const chunkIndex = new Map();
  const loadedChunks = new Set();
  const generatedChunks = new Set();
  const placed = new Map();
  const removed = new Set();

  const state = {
    pos: new THREE.Vector3(0, 22, 0),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    onGround: false,
    terminalOpen: false,
    health: 100,
    energy: 100,
    time: 480,
    xp: 0,
    level: 1,
    credits: 0,
    selected: 0,
    miningCooldown: 0
  };

  const inventory = [
    { type: BLOCK.GRASS, count: 24 },
    { type: BLOCK.DIRT, count: 36 },
    { type: BLOCK.STONE, count: 48 },
    { type: BLOCK.WOOD, count: 18 },
    { type: BLOCK.IRON, count: 8 }
  ];

  const control = { keys: new Set(), locked: false };
  const oreMarkers = [];
  const termHistory = [];
  let termHistoryPos = -1;
  let target = null;

  const blockOutline = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
    new THREE.LineBasicMaterial({ color: 0x5ef3ff })
  );
  blockOutline.visible = false;
  scene.add(blockOutline);

  const chunkId = (cx, cz) => `${cx},${cz}`;
  const key = (x, y, z) => `${x},${y},${z}`;

  function notify(msg) {
    hud.notification.textContent = msg;
    hud.notification.classList.add('show');
    clearTimeout(notify._timer);
    notify._timer = setTimeout(() => hud.notification.classList.remove('show'), 1600);
  }

  function hash2(x, z) {
    const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function terrainHeight(x, z) {
    const n1 = Math.sin(x * 0.09) * 3.2;
    const n2 = Math.cos(z * 0.075) * 2.8;
    const n3 = Math.sin((x + z) * 0.035) * 4.1;
    return Math.floor(12 + n1 + n2 + n3);
  }

  function generatedType(x, y, z) {
    const h = terrainHeight(x, z);
    if (y > h) return BLOCK.AIR;
    if (y === h) return BLOCK.GRASS;
    if (y >= h - 3) return BLOCK.DIRT;
    if (y < h - 7 && hash2(x * 2, z * 2) > 0.86) return BLOCK.IRON;
    return BLOCK.STONE;
  }

  function getBlock(x, y, z) {
    const k = key(x, y, z);
    if (removed.has(k)) return BLOCK.AIR;
    if (placed.has(k)) return placed.get(k);
    return world.get(k) ?? BLOCK.AIR;
  }

  function pushChunkKey(cx, cz, k) {
    const cid = chunkId(cx, cz);
    let list = chunkIndex.get(cid);
    if (!list) {
      list = [];
      chunkIndex.set(cid, list);
    }
    list.push(k);
  }

  function addMesh(x, y, z, type, cx, cz) {
    if (!BLOCK_DEF[type]) return;
    const k = key(x, y, z);
    if (meshByKey.has(k)) return;
    const mesh = new THREE.Mesh(blockGeo, mats[type]);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.userData.pos = { x, y, z };
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
    meshByKey.set(k, mesh);
    pushChunkKey(cx, cz, k);
  }

  function removeMeshAtKey(k) {
    const mesh = meshByKey.get(k);
    if (!mesh) return;
    scene.remove(mesh);
    meshByKey.delete(k);
  }

  function setBlock(x, y, z, type, source = 'world') {
    const k = key(x, y, z);

    if (source === 'player-mine') {
      placed.delete(k);
      removed.add(k);
    } else if (source === 'player-place') {
      removed.delete(k);
      placed.set(k, type);
    }

    if (type === BLOCK.AIR) {
      world.delete(k);
      removeMeshAtKey(k);
      return;
    }

    world.set(k, type);
    const cx = Math.floor(x / chunkSize);
    const cz = Math.floor(z / chunkSize);
    addMesh(x, y, z, type, cx, cz);
  }

  function maybeTree(x, y, z) {
    if (hash2(x + 40, z - 22) < 0.986) return;
    const h = 3 + Math.floor(hash2(x, z) * 3);
    for (let i = 1; i <= h; i++) setBlock(x, y + i, z, BLOCK.WOOD);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = h - 1; dy <= h + 1; dy++) {
          if (Math.abs(dx) + Math.abs(dz) < 4 && getBlock(x + dx, y + dy, z + dz) === BLOCK.AIR) {
            setBlock(x + dx, y + dy, z + dz, BLOCK.LEAF);
          }
        }
      }
    }
  }

  function generateChunk(cx, cz) {
    const cid = chunkId(cx, cz);
    if (generatedChunks.has(cid)) return;
    generatedChunks.add(cid);
    loadedChunks.add(cid);

    const sx = cx * chunkSize;
    const sz = cz * chunkSize;

    for (let x = sx; x < sx + chunkSize; x++) {
      for (let z = sz; z < sz + chunkSize; z++) {
        const h = terrainHeight(x, z);
        for (let y = 0; y <= h; y++) {
          const t = generatedType(x, y, z);
          if (t !== BLOCK.AIR && !removed.has(key(x, y, z))) setBlock(x, y, z, t);
        }
        if (h > 6) maybeTree(x, h, z);
      }
    }
  }

  function unloadChunk(cx, cz) {
    const cid = chunkId(cx, cz);
    const list = chunkIndex.get(cid);
    if (!list) return;
    for (const k of list) {
      removeMeshAtKey(k);
      world.delete(k);
    }
    chunkIndex.delete(cid);
    loadedChunks.delete(cid);
  }

  function ensureWorldAround(px, pz) {
    const ccx = Math.floor(px / chunkSize);
    const ccz = Math.floor(pz / chunkSize);

    for (let dx = -viewRadius; dx <= viewRadius; dx++) {
      for (let dz = -viewRadius; dz <= viewRadius; dz++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        const cid = chunkId(cx, cz);
        if (!generatedChunks.has(cid)) generateChunk(cx, cz);
        else if (!loadedChunks.has(cid)) {
          // regenerate deterministically when returning.
          generatedChunks.delete(cid);
          generateChunk(cx, cz);
        }
      }
    }

    for (const cid of Array.from(loadedChunks)) {
      const [cx, cz] = cid.split(',').map(Number);
      if (Math.abs(cx - ccx) > unloadRadius || Math.abs(cz - ccz) > unloadRadius) unloadChunk(cx, cz);
    }
  }

  function collides(px, py, pz) {
    const w = 0.32;
    const minX = Math.floor(px - w), maxX = Math.floor(px + w);
    const minY = Math.floor(py), maxY = Math.floor(py + 1.8);
    const minZ = Math.floor(pz - w), maxZ = Math.floor(pz + w);

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (BLOCK_DEF[getBlock(x, y, z)]?.solid) return true;
        }
      }
    }
    return false;
  }

  function move(dt) {
    state.vel.y -= 23 * dt;
    if (state.onGround && state.vel.y < -0.3) state.vel.y = -0.3;

    const speed = control.keys.has('ShiftLeft') ? 7.6 : 5.5;
    const forward = new THREE.Vector3(Math.sin(state.yaw), 0, Math.cos(state.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);
    const wish = new THREE.Vector3();

    if (control.keys.has('KeyW')) wish.add(forward);
    if (control.keys.has('KeyS')) wish.sub(forward);
    if (control.keys.has('KeyA')) wish.sub(right);
    if (control.keys.has('KeyD')) wish.add(right);
    if (wish.lengthSq() > 0) wish.normalize();

    const friction = state.onGround ? 16 : 5;
    state.vel.x += (wish.x * speed - state.vel.x) * Math.min(1, friction * dt);
    state.vel.z += (wish.z * speed - state.vel.z) * Math.min(1, friction * dt);

    const nx = state.pos.x + state.vel.x * dt;
    if (!collides(nx, state.pos.y, state.pos.z)) state.pos.x = nx;
    else state.vel.x = 0;

    const nz = state.pos.z + state.vel.z * dt;
    if (!collides(state.pos.x, state.pos.y, nz)) state.pos.z = nz;
    else state.vel.z = 0;

    const ny = state.pos.y + state.vel.y * dt;
    if (!collides(state.pos.x, ny, state.pos.z)) {
      state.pos.y = ny;
      state.onGround = false;
    } else {
      if (state.vel.y < 0) state.onGround = true;
      state.vel.y = 0;
    }

    if (state.pos.y < -5) {
      state.health = Math.max(0, state.health - 15 * dt);
      state.pos.set(0, 26, 0);
      state.vel.set(0, 0, 0);
      notify('Respawned after void fall.');
    }
  }

  function voxelRaycast(maxDist = 7, step = 0.1) {
    const origin = camera.position;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);

    let prev = null;
    for (let t = 0; t < maxDist; t += step) {
      const px = origin.x + dir.x * t;
      const py = origin.y + dir.y * t;
      const pz = origin.z + dir.z * t;
      const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
      if (prev && prev.x === bx && prev.y === by && prev.z === bz) continue;
      prev = { x: bx, y: by, z: bz };
      const block = getBlock(bx, by, bz);
      if (block !== BLOCK.AIR) {
        const before = { x: Math.floor(px - dir.x * step), y: Math.floor(py - dir.y * step), z: Math.floor(pz - dir.z * step) };
        return { block: prev, before, type: block };
      }
    }
    return null;
  }

  function addXP(amount) {
    state.xp += amount;
    while (state.xp >= state.level * 30) {
      state.xp -= state.level * 30;
      state.level++;
      state.credits += 20;
      notify(`Level up! Operator Lv.${state.level}`);
    }
  }

  function mineTarget() {
    if (!target || state.miningCooldown > 0) return;
    const { x, y, z } = target.block;
    if (y <= 0) return;
    const t = getBlock(x, y, z);
    if (t === BLOCK.AIR) return;

    setBlock(x, y, z, BLOCK.AIR, 'player-mine');
    const slot = inventory.find((s) => s.type === t);
    if (slot) slot.count++;
    else inventory[state.selected] = { type: t, count: 1 };

    state.miningCooldown = 0.12;
    state.energy = Math.max(0, state.energy - 0.4);
    addXP(t === BLOCK.IRON ? 6 : 2);
    renderHud();
  }

  function placeTarget() {
    if (!target) return;
    const slot = inventory[state.selected];
    if (!slot || slot.count <= 0) return;

    const p = target.before;
    if (getBlock(p.x, p.y, p.z) !== BLOCK.AIR) return;
    if (collides(p.x + 0.5, p.y, p.z + 0.5)) return;

    setBlock(p.x, p.y, p.z, slot.type, 'player-place');
    slot.count--;
    addXP(1);
    renderHud();
  }

  function clearMarkers() {
    for (const m of oreMarkers) scene.remove(m);
    oreMarkers.length = 0;
  }

  function scanNearby() {
    clearMarkers();
    let found = 0;
    const px = Math.floor(state.pos.x), py = Math.floor(state.pos.y), pz = Math.floor(state.pos.z);
    for (let x = px - 12; x <= px + 12; x++) {
      for (let y = Math.max(1, py - 10); y <= py + 10; y++) {
        for (let z = pz - 12; z <= pz + 12; z++) {
          if (getBlock(x, y, z) === BLOCK.IRON) {
            found++;
            const marker = new THREE.Mesh(
              new THREE.BoxGeometry(1.06, 1.06, 1.06),
              new THREE.MeshBasicMaterial({ color: 0x3cf7ff, wireframe: true })
            );
            marker.position.set(x + 0.5, y + 0.5, z + 0.5);
            scene.add(marker);
            oreMarkers.push(marker);
          }
        }
      }
    }
    state.energy = Math.max(0, state.energy - 8);
    state.credits += Math.min(20, found);
    addXP(found > 0 ? 10 : 2);
    notify(found ? `Scan found ${found} iron nodes.` : 'No iron in scan radius.');
    return found;
  }

  function gameTime() {
    const total = Math.floor(state.time % 1440);
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function renderHud() {
    hud.health.style.width = `${Math.max(0, state.health)}%`;
    hud.energy.style.width = `${Math.max(0, state.energy)}%`;
    hud.level.textContent = `${state.level} · XP ${Math.floor(state.xp)}`;
    hud.credits.textContent = `${state.credits} credits`;

    hud.hotbar.innerHTML = '';
    inventory.forEach((slot, i) => {
      const el = document.createElement('div');
      el.className = `slot ${i === state.selected ? 'selected' : ''}`;
      el.innerHTML = `<div>${BLOCK_DEF[slot.type]?.name ?? 'Empty'}</div><div class="count">${slot.count}</div><div>${i + 1}</div>`;
      hud.hotbar.appendChild(el);
    });
  }

  function termPrint(msg) {
    const line = document.createElement('div');
    line.textContent = msg;
    terminal.log.appendChild(line);
    terminal.log.scrollTop = terminal.log.scrollHeight;
  }

  function setObjective(text) {
    hud.objective.innerHTML = text;
  }

  function termCommand(raw) {
    const cmd = raw.trim().toLowerCase();
    if (!cmd) return;
    termPrint(`> ${cmd}`);

    if (cmd === 'help') {
      termPrint('Core: help, status, scan, time, clear');
      termPrint('Progression: missions, hack, ping, uptime');
      setObjective('Mine and place blocks to gain XP, then run <b>scan</b> for credits.');
    } else if (cmd === 'status') {
      termPrint(`HP ${state.health.toFixed(0)} | EN ${state.energy.toFixed(0)} | LV ${state.level} | XP ${state.xp.toFixed(0)} | CR ${state.credits}`);
      termPrint(`POS ${state.pos.x.toFixed(1)}, ${state.pos.y.toFixed(1)}, ${state.pos.z.toFixed(1)}`);
    } else if (cmd === 'scan') {
      const found = scanNearby();
      termPrint(`Scan complete -> ${found} iron signatures.`);
    } else if (cmd === 'time') {
      termPrint(`In-world time: ${gameTime()}`);
    } else if (cmd === 'missions') {
      termPrint('1) Prospecting: Run scan and mine 5 stone.');
      termPrint('2) Builder Protocol: Place 10 blocks.');
      termPrint('3) Neon Wealth: Reach 100 credits.');
    } else if (cmd === 'hack') {
      if (state.energy < 12) termPrint('Not enough energy. Required 12.');
      else {
        state.energy -= 12;
        const gain = 10 + Math.floor(Math.random() * 25);
        state.credits += gain;
        addXP(8);
        termPrint(`Hack successful. +${gain} credits siphoned.`);
        notify(`Hack payout +${gain} credits`);
      }
    } else if (cmd === 'ping') {
      termPrint(`world.meshes=${meshByKey.size} loaded_chunks=${loadedChunks.size} markers=${oreMarkers.length}`);
    } else if (cmd === 'uptime') {
      termPrint(`Session time ${Math.floor(performance.now() / 1000)}s`);
    } else if (cmd === 'clear') {
      terminal.log.innerHTML = '';
    } else {
      termPrint('Unknown command. Try help.');
    }

    renderHud();
  }

  function toggleTerminal(next) {
    state.terminalOpen = next;
    terminal.root.classList.toggle('hidden', !next);
    if (next) {
      document.exitPointerLock();
      terminal.input.focus();
      termPrint('Neon shell online. Type help to view command matrix.');
    } else {
      terminal.input.blur();
    }
  }

  function saveGame() {
    const payload = {
      pos: state.pos.toArray(),
      vel: state.vel.toArray(),
      yaw: state.yaw,
      pitch: state.pitch,
      health: state.health,
      energy: state.energy,
      time: state.time,
      xp: state.xp,
      level: state.level,
      credits: state.credits,
      selected: state.selected,
      inventory,
      placed: Array.from(placed.entries()),
      removed: Array.from(removed.values())
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  }

  function loadGame() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    try {
      const d = JSON.parse(raw);
      if (Array.isArray(d.pos)) state.pos.fromArray(d.pos);
      if (Array.isArray(d.vel)) state.vel.fromArray(d.vel);
      state.yaw = d.yaw ?? state.yaw;
      state.pitch = d.pitch ?? state.pitch;
      state.health = d.health ?? state.health;
      state.energy = d.energy ?? state.energy;
      state.time = d.time ?? state.time;
      state.xp = d.xp ?? state.xp;
      state.level = d.level ?? state.level;
      state.credits = d.credits ?? state.credits;
      state.selected = d.selected ?? state.selected;
      if (Array.isArray(d.inventory)) d.inventory.forEach((s, i) => { if (inventory[i]) inventory[i] = s; });
      placed.clear();
      removed.clear();
      (d.placed ?? []).forEach(([k, v]) => placed.set(k, v));
      (d.removed ?? []).forEach((k) => removed.add(k));
    } catch {
      notify('Save file invalid, starting fresh.');
    }
  }

  function applyPlacedOverridesInLoadedChunks() {
    for (const [k, type] of placed.entries()) {
      const [x, y, z] = k.split(',').map(Number);
      const cx = Math.floor(x / chunkSize);
      const cz = Math.floor(z / chunkSize);
      if (loadedChunks.has(chunkId(cx, cz))) setBlock(x, y, z, type);
    }
  }

  function updateDayNight(dt) {
    state.time = (state.time + dt * 3.2) % 1440;
    const f = Math.sin((state.time / 1440) * Math.PI * 2);
    const daylight = 0.2 + Math.max(0, f) * 0.95;
    sun.intensity = daylight;
    hemi.intensity = 0.25 + daylight * 0.45;

    const nightColor = new THREE.Color(0x0b1020);
    const dayColor = new THREE.Color(0x7ab2e3);
    const mix = Math.max(0, Math.min(1, daylight));
    scene.background = nightColor.clone().lerp(dayColor, mix * 0.9);
    scene.fog.color.copy(scene.background);
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'Tab' || e.code === 'KeyT') {
      e.preventDefault();
      toggleTerminal(!state.terminalOpen);
      return;
    }

    if (state.terminalOpen) return;

    control.keys.add(e.code);
    if (e.code === 'Space' && state.onGround) {
      state.vel.y = 8.8;
      state.onGround = false;
    }

    const idx = Number(e.key) - 1;
    if (idx >= 0 && idx < inventory.length) {
      state.selected = idx;
      renderHud();
    }
  });

  window.addEventListener('keyup', (e) => control.keys.delete(e.code));
  canvas.addEventListener('click', () => { if (!state.terminalOpen) canvas.requestPointerLock(); });
  document.addEventListener('pointerlockchange', () => { control.locked = document.pointerLockElement === canvas; });
  window.addEventListener('mousemove', (e) => {
    if (!control.locked || state.terminalOpen) return;
    state.yaw -= e.movementX * 0.0022;
    state.pitch -= e.movementY * 0.0022;
    state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch));
  });

  window.addEventListener('mousedown', (e) => {
    if (state.terminalOpen) return;
    if (e.button === 0) mineTarget();
    if (e.button === 2) placeTarget();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  terminal.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const txt = terminal.input.value;
      if (txt.trim()) termHistory.push(txt.trim());
      termHistoryPos = termHistory.length;
      termCommand(txt);
      terminal.input.value = '';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (termHistory.length === 0) return;
      termHistoryPos = Math.max(0, termHistoryPos - 1);
      terminal.input.value = termHistory[termHistoryPos] ?? '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termHistory.length === 0) return;
      termHistoryPos = Math.min(termHistory.length, termHistoryPos + 1);
      terminal.input.value = termHistory[termHistoryPos] ?? '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const cmds = ['help', 'status', 'scan', 'time', 'clear', 'missions', 'hack', 'ping', 'uptime'];
      const v = terminal.input.value.toLowerCase();
      const match = cmds.find((c) => c.startsWith(v));
      if (match) terminal.input.value = match;
    }
  });

  window.addEventListener('beforeunload', saveGame);
  setInterval(saveGame, 10000);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  loadGame();
  ensureWorldAround(state.pos.x, state.pos.z);
  applyPlacedOverridesInLoadedChunks();
  renderHud();
  setObjective('Boot complete. Open terminal (<b>T</b>) and run <b>help</b>.');

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!state.terminalOpen) {
      move(dt);
      state.energy = Math.min(100, state.energy + (state.onGround ? 6 : 2.5) * dt);
    }

    state.miningCooldown = Math.max(0, state.miningCooldown - dt);
    ensureWorldAround(state.pos.x, state.pos.z);
    applyPlacedOverridesInLoadedChunks();
    updateDayNight(dt);

    camera.position.copy(state.pos).add(new THREE.Vector3(0, 1.62, 0));
    camera.rotation.order = 'YXZ';
    camera.rotation.y = state.yaw;
    camera.rotation.x = state.pitch;

    target = voxelRaycast(7, 0.1);
    if (target) {
      blockOutline.visible = true;
      blockOutline.position.set(target.block.x + 0.5, target.block.y + 0.5, target.block.z + 0.5);
    } else {
      blockOutline.visible = false;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
