/* ---------------------------------------------------------
   Blare Alarm Clock — for people who sleep through everything
   Vanilla JS, no dependencies, no external audio files.
--------------------------------------------------------- */

const STORAGE_KEY = "blare_alarms_v1";
const STREAK_KEY = "blare_streak_v1";
const SETTINGS_KEY = "blare_settings_v1";
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------------- Wake-Up Stakes ----------------
   $2.99/mo subscription (Stripe Checkout) unlocks a $5 stake per alarm.
   The hold is placed when the alarm actually rings, released on a clean
   dismiss, and captured (charged) if you snooze a 3rd time or never
   resolve the alarm at all (server-side safety net for that last case).
   Fixed at $5 for now — see plan doc for future higher tiers. */
const STAKES_API_BASE = "https://blare-stakes-worker.gymnathan03.workers.dev";
const STAKES_CUSTOMER_KEY = "blare_stripe_customer_v1";
const MAX_SNOOZES_BEFORE_CHARGE = 3;

/* ---------------- State ---------------- */
let alarms = loadAlarms();
let streak = loadStreak();
let settings = loadSettings();
let editingAlarmId = null;
let activeRingingAlarm = null;
let snoozeUntilMap = {}; // alarmId -> timestamp ms when snooze ends
let checkTimer = null;

let stripeCustomerId = localStorage.getItem(STAKES_CUSTOMER_KEY) || null;
let subscribed = false;
let activeStakeIntentId = null; // payment_intent_id for the currently-ringing alarm's hold
let snoozeCount = 0;

/* ---------------- Storage ---------------- */
function loadAlarms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveAlarms() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
}

function loadStreak() {
  try {
    const raw = localStorage.getItem(STREAK_KEY);
    return raw ? JSON.parse(raw) : { count: 0, best: 0, lastSuccessDate: null };
  } catch (e) {
    return { count: 0, best: 0, lastSuccessDate: null };
  }
}
function saveStreak() {
  localStorage.setItem(STREAK_KEY, JSON.stringify(streak));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : { use24Hour: false };
  } catch (e) {
    return { use24Hour: false };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- DOM refs ---------------- */
const mainScreen = document.getElementById("main-screen");
const editScreen = document.getElementById("edit-screen");
const ringingScreen = document.getElementById("ringing-screen");
const settingsScreen = document.getElementById("settings-screen");
const settingsBtn = document.getElementById("settings-btn");
const closeSettingsBtn = document.getElementById("close-settings-btn");
const use24hToggle = document.getElementById("use24h-toggle");

const liveClock = document.getElementById("live-clock");
const liveDate = document.getElementById("live-date");
const alarmListEl = document.getElementById("alarm-list");
const emptyState = document.getElementById("empty-state");
const nextAlarmBanner = document.getElementById("next-alarm-banner");
const nextAlarmText = document.getElementById("next-alarm-text");
const streakBanner = document.getElementById("streak-banner");

const addAlarmBtn = document.getElementById("add-alarm-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const saveAlarmBtn = document.getElementById("save-alarm-btn");
const deleteAlarmBtn = document.getElementById("delete-alarm-btn");
const editTitle = document.getElementById("edit-title");

const timeInput = document.getElementById("time-input");
const labelInput = document.getElementById("label-input");
const soundSelect = document.getElementById("sound-select");
const rampSelect = document.getElementById("ramp-select");
const snoozeSelect = document.getElementById("snooze-select");
const gameToggle = document.getElementById("game-toggle");
const gameDifficultyRow = document.getElementById("game-difficulty-row");
const gameDifficultySelect = document.getElementById("game-difficulty-select");
const dayToggles = document.querySelectorAll(".day-btn");
const previewSoundBtn = document.getElementById("preview-sound-btn");

const stakesToggle = document.getElementById("stakes-toggle");
const stakesLockedHint = document.getElementById("stakes-locked-hint");
const stakesLoadingEl = document.getElementById("stakes-loading");
const stakesNotSubscribedEl = document.getElementById("stakes-not-subscribed");
const stakesSubscribedEl = document.getElementById("stakes-subscribed");
const subscribeBtn = document.getElementById("subscribe-btn");
const stakesBadge = document.getElementById("stakes-badge");

const ringingInfo = document.getElementById("ringing-info");
const ringingTime = document.getElementById("ringing-time");
const ringingLabel = document.getElementById("ringing-label");
const snoozeBtn = document.getElementById("snooze-btn");
const dismissBtn = document.getElementById("dismiss-btn");

const reflexGame = document.getElementById("reflex-game");
const reflexStreakEl = document.getElementById("reflex-streak");
const reflexFeedbackEl = document.getElementById("reflex-feedback");
const reflexZone = document.getElementById("reflex-zone");

const toastEl = document.getElementById("toast");

/* ---------------- Clock ---------------- */
function pad(n) { return n.toString().padStart(2, "0"); }

// Raw 24-hour "HH:MM" — required by <input type="time">.value regardless of display settings.
function fmtTimeValue(h, m) {
  return `${pad(h)}:${pad(m)}`;
}

function fmtTime(h, m) {
  if (settings.use24Hour) return fmtTimeValue(h, m);
  const period = h >= 12 ? "PM" : "AM";
  let displayHour = h % 12;
  if (displayHour === 0) displayHour = 12;
  return `${displayHour}:${pad(m)} ${period}`;
}

function renderBigTime(el, h, m) {
  if (settings.use24Hour) {
    el.textContent = fmtTimeValue(h, m);
    return;
  }
  const period = h >= 12 ? "PM" : "AM";
  let displayHour = h % 12;
  if (displayHour === 0) displayHour = 12;
  el.innerHTML = `${displayHour}:${pad(m)}<span class="ampm">${period}</span>`;
}

function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayStr() { return dateStr(new Date()); }
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateStr(d);
}

/* ---------------- Streak ---------------- */
function checkStreakOnLoad() {
  if (!streak.lastSuccessDate) return;
  if (streak.lastSuccessDate === todayStr() || streak.lastSuccessDate === yesterdayStr()) return;
  streak.count = 0;
  saveStreak();
}

function recordSuccessfulWake() {
  const today = todayStr();
  if (streak.lastSuccessDate === today) return; // already counted today
  streak.count = streak.lastSuccessDate === yesterdayStr() ? streak.count + 1 : 1;
  streak.best = Math.max(streak.best || 0, streak.count);
  streak.lastSuccessDate = today;
  saveStreak();
  renderStreak();
  setTimeout(() => showToast(`🔥 ${streak.count} day${streak.count === 1 ? "" : "s"} in a row!`), 300);
}

function renderStreak() {
  if (streak.count > 0) {
    streakBanner.classList.remove("hidden");
    streakBanner.textContent = `🔥 ${streak.count} day${streak.count === 1 ? "" : "s"} in a row`;
  } else {
    streakBanner.classList.add("hidden");
  }
}

function updateLiveClock() {
  const now = new Date();
  renderBigTime(liveClock, now.getHours(), now.getMinutes());
  liveDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric"
  });
}

/* ---------------- Rendering alarm list ---------------- */
function renderAlarmList() {
  alarmListEl.innerHTML = "";
  if (alarms.length === 0) {
    emptyState.classList.remove("hidden");
    alarmListEl.classList.add("hidden");
  } else {
    emptyState.classList.add("hidden");
    alarmListEl.classList.remove("hidden");
  }

  const sorted = [...alarms].sort((a, b) => {
    return a.hour * 60 + a.minute - (b.hour * 60 + b.minute);
  });

  for (const alarm of sorted) {
    const li = document.createElement("li");
    li.className = "alarm-card" + (alarm.enabled ? "" : " disabled");

    const main = document.createElement("div");
    main.className = "alarm-card-main";
    main.addEventListener("click", () => openEditScreen(alarm.id));

    const timeEl = document.createElement("div");
    timeEl.className = "alarm-card-time";
    timeEl.textContent = fmtTime(alarm.hour, alarm.minute);

    const metaEl = document.createElement("div");
    metaEl.className = "alarm-card-meta";
    metaEl.textContent = buildMetaText(alarm);

    main.appendChild(timeEl);
    main.appendChild(metaEl);

    const label = document.createElement("label");
    label.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = alarm.enabled;
    input.addEventListener("change", () => {
      alarm.enabled = input.checked;
      saveAlarms();
      renderAlarmList();
      updateNextAlarmBanner();
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(input);
    label.appendChild(slider);

    li.appendChild(main);
    li.appendChild(label);
    alarmListEl.appendChild(li);
  }
}

function buildMetaText(alarm) {
  const parts = [];
  if (alarm.label) parts.push(alarm.label);
  if (alarm.days && alarm.days.length > 0) {
    if (alarm.days.length === 7) {
      parts.push("Every day");
    } else {
      parts.push(alarm.days.sort().map(d => DAY_LABELS[d]).join(" "));
    }
  } else {
    parts.push("Once");
  }
  parts.push(SOUND_NAMES[alarm.sound] || alarm.sound);
  if (alarm.stakesEnabled) parts.push("💵 $5 staked");
  return parts.join(" · ");
}

function updateNextAlarmBanner() {
  const next = findNextAlarmTime();
  if (!next) {
    nextAlarmBanner.classList.add("hidden");
    return;
  }
  nextAlarmBanner.classList.remove("hidden");
  const diffMs = next.date - new Date();
  const mins = Math.round(diffMs / 60000);
  let inText;
  if (mins < 60) {
    inText = `in ${mins} min`;
  } else if (mins < 60 * 24) {
    inText = `in ${Math.round(mins / 60 * 10) / 10} hrs`;
  } else {
    inText = `on ${next.date.toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  nextAlarmText.textContent = `${fmtTime(next.alarm.hour, next.alarm.minute)} ${inText}`;
}

function findNextAlarmTime() {
  const now = new Date();
  let best = null;
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + dayOffset);
      candidate.setHours(alarm.hour, alarm.minute, 0, 0);
      if (candidate <= now) continue;

      const dow = candidate.getDay();
      const repeats = alarm.days && alarm.days.length > 0;
      if (repeats && !alarm.days.includes(dow)) continue;
      if (!repeats && dayOffset > 0) continue; // one-off already passed today logic handled below

      if (!best || candidate < best.date) {
        best = { date: candidate, alarm };
      }
      break;
    }
  }
  return best;
}

/* ---------------- Edit screen ---------------- */
function openEditScreen(alarmId) {
  editingAlarmId = alarmId || null;
  const alarm = alarmId ? alarms.find(a => a.id === alarmId) : null;

  editTitle.textContent = alarm ? "Edit Alarm" : "New Alarm";
  deleteAlarmBtn.classList.toggle("hidden", !alarm);

  const now = new Date();
  const h = alarm ? alarm.hour : now.getHours();
  const m = alarm ? alarm.minute : (now.getMinutes() + 1) % 60;
  timeInput.value = fmtTimeValue(h, m);

  labelInput.value = alarm ? (alarm.label || "") : "";
  soundSelect.value = alarm ? alarm.sound : "siren";
  rampSelect.value = alarm ? String(alarm.ramp) : "15";
  snoozeSelect.value = alarm ? String(alarm.snoozeMinutes) : "5";
  gameToggle.checked = alarm ? alarm.requireGame : true;
  gameDifficultySelect.value = alarm ? alarm.difficulty : "medium";
  gameDifficultyRow.classList.toggle("hidden", !gameToggle.checked);

  stakesToggle.checked = alarm ? !!alarm.stakesEnabled : false;
  updateStakesToggleLock();

  const activeDays = alarm ? (alarm.days || []) : [];
  dayToggles.forEach(btn => {
    const d = Number(btn.dataset.day);
    btn.classList.toggle("active", activeDays.includes(d));
  });

  showScreen(editScreen);
}

function getSelectedDays() {
  const days = [];
  dayToggles.forEach(btn => {
    if (btn.classList.contains("active")) days.push(Number(btn.dataset.day));
  });
  return days;
}

function saveAlarmFromEdit() {
  const [hStr, mStr] = timeInput.value.split(":");
  const hour = Number(hStr);
  const minute = Number(mStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    showToast("Please pick a valid time.");
    return;
  }

  const data = {
    hour, minute,
    label: labelInput.value.trim(),
    sound: soundSelect.value,
    ramp: rampSelect.value === "instant" ? 0 : Number(rampSelect.value),
    snoozeMinutes: Number(snoozeSelect.value),
    requireGame: gameToggle.checked,
    difficulty: gameDifficultySelect.value,
    stakesEnabled: subscribed && stakesToggle.checked,
    days: getSelectedDays(),
    enabled: true,
  };

  if (editingAlarmId) {
    const idx = alarms.findIndex(a => a.id === editingAlarmId);
    alarms[idx] = { ...alarms[idx], ...data };
  } else {
    alarms.push({ id: uid(), ...data });
  }
  saveAlarms();
  renderAlarmList();
  updateNextAlarmBanner();
  showScreen(mainScreen);
  showToast("Alarm saved.");
}

function deleteCurrentAlarm() {
  if (!editingAlarmId) return;
  alarms = alarms.filter(a => a.id !== editingAlarmId);
  delete snoozeUntilMap[editingAlarmId];
  saveAlarms();
  renderAlarmList();
  updateNextAlarmBanner();
  showScreen(mainScreen);
  showToast("Alarm deleted.");
}

/* ---------------- Screen switching ---------------- */
function showScreen(screen) {
  [mainScreen, editScreen, ringingScreen, settingsScreen].forEach(s => s.classList.add("hidden"));
  screen.classList.remove("hidden");
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2200);
}

/* ---------------- Alarm checking loop ---------------- */
function startCheckLoop() {
  checkTimer = setInterval(checkAlarms, 1000);
  checkAlarms();
}

function checkAlarms() {
  updateLiveClock();

  const now = new Date();
  const nowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

  // Handle snoozes
  for (const [alarmId, until] of Object.entries(snoozeUntilMap)) {
    if (Date.now() >= until) {
      const alarm = alarms.find(a => a.id === alarmId);
      delete snoozeUntilMap[alarmId];
      if (alarm) {
        triggerRing(alarm);
        return;
      }
    }
  }

  if (activeRingingAlarm) return; // already ringing, don't retrigger

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (alarm.hour !== now.getHours() || alarm.minute !== now.getMinutes()) continue;

    const repeats = alarm.days && alarm.days.length > 0;
    if (repeats && !alarm.days.includes(now.getDay())) continue;

    if (alarm._lastFiredKey === nowKey) continue;
    alarm._lastFiredKey = nowKey;

    triggerRing(alarm);

    if (!repeats) {
      alarm.enabled = false;
      saveAlarms();
      renderAlarmList();
    }
    break;
  }

  updateNextAlarmBanner();
}

/* ---------------- Ringing ---------------- */
function triggerRing(alarm) {
  activeRingingAlarm = alarm;
  renderBigTime(ringingTime, alarm.hour, alarm.minute);
  ringingLabel.textContent = alarm.label || "Wake up!";

  ringingInfo.classList.remove("hidden");
  reflexGame.classList.add("hidden");
  stopReflexGame();

  snoozeBtn.classList.toggle("hidden", alarm.snoozeMinutes === 0);

  snoozeCount = 0;
  activeStakeIntentId = null;
  stakesBadge.classList.add("hidden");
  if (alarm.stakesEnabled) startStakeHold(alarm);

  showScreen(ringingScreen);
  AlarmSound.play(alarm.sound, alarm.ramp);

  if (navigator.vibrate) {
    startVibration();
  }
  requestWakeLock();
}

let vibrateInterval = null;
function startVibration() {
  navigator.vibrate([500, 250, 500, 250]);
  vibrateInterval = setInterval(() => navigator.vibrate([500, 250, 500, 250]), 1500);
}
function stopVibration() {
  if (vibrateInterval) clearInterval(vibrateInterval);
  vibrateInterval = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (e) { /* ignore, not critical */ }
}
function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function endRinging() {
  AlarmSound.stop();
  stopVibration();
  releaseWakeLock();
  stopReflexGame();
  activeRingingAlarm = null;
  showScreen(mainScreen);
  renderAlarmList();
  updateNextAlarmBanner();
}

function handleSnooze() {
  if (!activeRingingAlarm) return;

  snoozeCount++;
  if (activeStakeIntentId && snoozeCount >= MAX_SNOOZES_BEFORE_CHARGE) {
    captureStakeIfAny();
    showToast("Charged $5 — you snoozed 3 times. Dismiss to stop the alarm.");
    snoozeBtn.classList.add("hidden"); // no more snoozing; they still have to dismiss
    return;
  }

  const mins = activeRingingAlarm.snoozeMinutes || 5;
  snoozeUntilMap[activeRingingAlarm.id] = Date.now() + mins * 60000;
  showToast(`Snoozed for ${mins} minutes.`);
  endRinging();
}

function handleDismissRequest() {
  if (!activeRingingAlarm) return;
  if (activeRingingAlarm.requireGame) {
    startReflexGame(activeRingingAlarm.difficulty);
  } else {
    handleWakeSuccess();
  }
}

// A clean dismiss releases any stake hold (no charge) on top of the
// existing streak-tracking. Shared by both dismiss paths below.
function handleWakeSuccess() {
  recordSuccessfulWake();
  releaseStakeIfAny();
  endRinging();
}

/* ---------------- Reflex "awake-o-meter" game ----------------
   Instead of a knowledge puzzle, this measures actual reaction speed:
   the player must tap a randomly-placed target several times in a row,
   each within a difficulty-based time limit. Too slow, or tapping the
   wrong spot, resets the streak — you need real reflexes, not just luck. */
const REFLEX_LEVELS = {
  easy:   { required: 3, maxReactionMs: 1500, targetSize: 90 },
  medium: { required: 5, maxReactionMs: 1100, targetSize: 72 },
  hard:   { required: 7, maxReactionMs: 800,  targetSize: 58 },
};

let reflexStreak = 0;
let reflexSpawnTime = 0;
let reflexTimeoutId = null;
let reflexLevel = null;
let reflexTargetEl = null;

function startReflexGame(difficulty) {
  reflexLevel = REFLEX_LEVELS[difficulty] || REFLEX_LEVELS.medium;
  reflexStreak = 0;
  ringingInfo.classList.add("hidden");
  reflexGame.classList.remove("hidden");
  updateReflexStreakText();
  reflexFeedbackEl.textContent = "Go!";
  spawnReflexTarget();
}

function stopReflexGame() {
  if (reflexTimeoutId) { clearTimeout(reflexTimeoutId); reflexTimeoutId = null; }
  if (reflexTargetEl) { reflexTargetEl.remove(); reflexTargetEl = null; }
  reflexZone.innerHTML = "";
}

function updateReflexStreakText() {
  reflexStreakEl.textContent = `${reflexStreak} / ${reflexLevel.required}`;
}

function spawnReflexTarget() {
  if (reflexTimeoutId) clearTimeout(reflexTimeoutId);
  reflexZone.innerHTML = "";

  const size = reflexLevel.targetSize;
  const zoneRect = reflexZone.getBoundingClientRect();
  const maxX = Math.max(0, zoneRect.width - size);
  const maxY = Math.max(0, zoneRect.height - size);
  const x = Math.random() * maxX;
  const y = Math.random() * maxY;

  const target = document.createElement("button");
  target.type = "button";
  target.className = "reflex-target";
  target.style.width = size + "px";
  target.style.height = size + "px";
  target.style.left = x + "px";
  target.style.top = y + "px";
  target.addEventListener("click", onReflexHit);
  reflexZone.appendChild(target);
  reflexTargetEl = target;

  reflexSpawnTime = performance.now();
  reflexTimeoutId = setTimeout(onReflexTimeout, reflexLevel.maxReactionMs + 400);
}

function onReflexHit() {
  if (!activeRingingAlarm) return;
  const reaction = performance.now() - reflexSpawnTime;
  if (reflexTimeoutId) { clearTimeout(reflexTimeoutId); reflexTimeoutId = null; }

  if (reaction <= reflexLevel.maxReactionMs) {
    reflexStreak++;
    updateReflexStreakText();
    if (reflexStreak >= reflexLevel.required) {
      reflexFeedbackEl.textContent = "Awake! Nice reflexes.";
      handleWakeSuccess();
      return;
    }
    reflexFeedbackEl.textContent = `${Math.round(reaction)}ms — keep going!`;
    setTimeout(spawnReflexTarget, 120);
  } else {
    reflexStreak = 0;
    updateReflexStreakText();
    reflexFeedbackEl.textContent = "Too slow — streak reset.";
    setTimeout(spawnReflexTarget, 200);
  }
}

function onReflexTimeout() {
  if (!activeRingingAlarm) return;
  reflexStreak = 0;
  updateReflexStreakText();
  reflexFeedbackEl.textContent = "Missed it — streak reset.";
  spawnReflexTarget();
}

/* ---------------- Sound engine (Web Audio API, no external files) ---------------- */
const SOUND_NAMES = {
  siren: "Air Raid Siren",
  airhorn: "Air Horn",
  klaxon: "Fire Alarm Klaxon",
  alarm: "Classic Alarm",
  beep: "Digital Beep",
  reveille: "Reveille Bugle",
  chiptune: "8-Bit Chiptune",
  house: "House Music",
  jazz: "Jazz Combo",
  rooster: "Rooster Crow",
};

const AlarmSound = (function () {
  let ctx = null;
  let masterGain = null;
  let nodes = [];
  let loopTimer = null;
  let rampTimer = null;
  let cachedNoiseBuffer = null;

  function getNoiseBuffer(c) {
    if (!cachedNoiseBuffer) {
      const size = c.sampleRate * 0.5;
      cachedNoiseBuffer = c.createBuffer(1, size, c.sampleRate);
      const data = cachedNoiseBuffer.getChannelData(0);
      for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    }
    return cachedNoiseBuffer;
  }

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function unlock() {
    getCtx();
  }

  function cleanupNodes() {
    nodes.forEach(n => { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    nodes = [];
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
  }

  function play(type, rampSeconds) {
    stop();
    const c = getCtx();
    masterGain = c.createGain();
    const startVol = rampSeconds && rampSeconds > 0 ? 0.08 : 1.0;
    masterGain.gain.value = startVol;
    masterGain.connect(c.destination);

    if (rampSeconds && rampSeconds > 0) {
      masterGain.gain.linearRampToValueAtTime(1.0, c.currentTime + rampSeconds);
    }

    if (type === "siren") playSiren(c);
    else if (type === "airhorn") playAirhorn(c);
    else if (type === "klaxon") playKlaxon(c);
    else if (type === "alarm") playClassicAlarm(c);
    else if (type === "reveille") playReveille(c);
    else if (type === "chiptune") playChiptune(c);
    else if (type === "house") playHouse(c);
    else if (type === "jazz") playJazz(c);
    else if (type === "rooster") playRooster(c);
    else playBeep(c);
  }

  function playSiren(c) {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    const lfo = c.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.6;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.frequency.value = 900;
    osc.connect(masterGain);
    lfo.start();
    osc.start();
    nodes.push(osc, lfo);
  }

  function playAirhorn(c) {
    function blast() {
      const osc1 = c.createOscillator();
      osc1.type = "sawtooth";
      osc1.frequency.value = 220;
      const osc2 = c.createOscillator();
      osc2.type = "sawtooth";
      osc2.frequency.value = 330;
      const g = c.createGain();
      g.gain.value = 1;
      osc1.connect(g);
      osc2.connect(g);
      g.connect(masterGain);
      osc1.start();
      osc2.start();
      nodes.push(osc1, osc2, g);
      loopTimer = setTimeout(() => {
        try { osc1.stop(); osc2.stop(); } catch (e) {}
        loopTimer = setTimeout(blast, 250);
      }, 900);
    }
    blast();
  }

  function playKlaxon(c) {
    let high = true;
    function tone() {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = high ? 970 : 630;
      const g = c.createGain();
      g.gain.value = 1;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      nodes.push(osc, g);
      loopTimer = setTimeout(() => {
        try { osc.stop(); } catch (e) {}
        high = !high;
        tone();
      }, 500);
    }
    tone();
  }

  function playReveille(c) {
    // A short bugle-call-style motif, looped.
    const phrase = [392.0, 523.25, 659.25, 783.99, 659.25, 523.25, 392.0, 392.0];
    let i = 0;
    function note() {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = phrase[i % phrase.length];
      const g = c.createGain();
      g.gain.setValueAtTime(0.8, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.22);
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 0.24);
      nodes.push(osc, g);
      i++;
      loopTimer = setTimeout(note, 180);
    }
    note();
  }

  function playChiptune(c) {
    // Fast retro arpeggio, chiptune-style.
    const arp = [523.25, 659.25, 784.0, 1046.5];
    let i = 0;
    function step() {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = arp[i % arp.length];
      const g = c.createGain();
      g.gain.setValueAtTime(0.7, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.09);
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 0.1);
      nodes.push(osc, g);
      i++;
      loopTimer = setTimeout(step, 90);
    }
    step();
  }

  function playHouse(c) {
    // 16-step sequencer at 128bpm: four-on-the-floor kick, offbeat hats, pulsing bass.
    const stepMs = (60000 / 128) / 2;
    let step = 0;

    function kick() {
      const osc = c.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(150, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, c.currentTime + 0.12);
      const g = c.createGain();
      g.gain.setValueAtTime(1, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.15);
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 0.16);
      nodes.push(osc, g);
    }

    function hat() {
      const src = c.createBufferSource();
      src.buffer = getNoiseBuffer(c);
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 7000;
      const g = c.createGain();
      g.gain.setValueAtTime(0.5, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.05);
      src.connect(hp);
      hp.connect(g);
      g.connect(masterGain);
      src.start();
      src.stop(c.currentTime + 0.06);
      nodes.push(src, hp, g);
    }

    function bass() {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 55;
      const g = c.createGain();
      g.gain.setValueAtTime(0.6, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.4);
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 0.42);
      nodes.push(osc, g);
    }

    function tick() {
      if (step % 4 === 0) kick();
      if (step % 4 === 2) hat();
      if (step % 8 === 0) bass();
      step = (step + 1) % 16;
      loopTimer = setTimeout(tick, stepMs);
    }
    tick();
  }

  function playJazz(c) {
    // A short swung ii-V-I-ish lick through a warm lowpass, looped.
    const notes = [392.0, 466.16, 523.25, 587.33, 523.25, 466.16];
    let i = 0;
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1800;
    filter.connect(masterGain);
    nodes.push(filter);

    function note() {
      const osc = c.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = notes[i % notes.length];
      const g = c.createGain();
      const dur = i % 2 === 0 ? 0.28 : 0.16; // swing feel
      g.gain.setValueAtTime(0.9, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      osc.connect(g);
      g.connect(filter);
      osc.start();
      osc.stop(c.currentTime + dur + 0.02);
      nodes.push(osc, g);
      i++;
      loopTimer = setTimeout(note, dur * 1000 * 0.9);
    }
    note();
  }

  function playRooster(c) {
    function crow() {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(600, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1400, c.currentTime + 0.15);
      osc.frequency.exponentialRampToValueAtTime(900, c.currentTime + 0.35);
      osc.frequency.exponentialRampToValueAtTime(1100, c.currentTime + 0.55);
      osc.frequency.exponentialRampToValueAtTime(400, c.currentTime + 0.75);
      const g = c.createGain();
      g.gain.setValueAtTime(0.9, c.currentTime);
      g.gain.setValueAtTime(0.9, c.currentTime + 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.8);
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      osc.stop(c.currentTime + 0.82);
      nodes.push(osc, g);
      loopTimer = setTimeout(crow, 1000);
    }
    crow();
  }

  function playClassicAlarm(c) {
    function ring() {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = 1000;
      const g = c.createGain();
      g.gain.value = 1;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      nodes.push(osc, g);
      loopTimer = setTimeout(() => {
        try { osc.stop(); } catch (e) {}
        loopTimer = setTimeout(ring, 200);
      }, 380);
    }
    ring();
  }

  function playBeep(c) {
    function beep() {
      const osc = c.createOscillator();
      osc.type = "square";
      osc.frequency.value = 1500;
      const g = c.createGain();
      g.gain.value = 1;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      nodes.push(osc, g);
      loopTimer = setTimeout(() => {
        try { osc.stop(); } catch (e) {}
        loopTimer = setTimeout(beep, 300);
      }, 150);
    }
    beep();
  }

  function stop() {
    cleanupNodes();
    if (masterGain) { try { masterGain.disconnect(); } catch (e) {} masterGain = null; }
  }

  function previewFor(ms, type) {
    play(type, 0);
    setTimeout(stop, ms);
  }

  return { play, stop, previewFor, unlock };
})();

/* Unlock the AudioContext on the user's first touch of the app so the
   alarm can actually make sound later when it fires with no fresh gesture. */
function unlockAudioOnce() {
  AlarmSound.unlock();
  document.removeEventListener("pointerdown", unlockAudioOnce);
  document.removeEventListener("click", unlockAudioOnce);
  document.removeEventListener("keydown", unlockAudioOnce);
}
document.addEventListener("pointerdown", unlockAudioOnce);
document.addEventListener("click", unlockAudioOnce);
document.addEventListener("keydown", unlockAudioOnce);

/* ---------------- Event wiring ---------------- */
addAlarmBtn.addEventListener("click", () => openEditScreen(null));
cancelEditBtn.addEventListener("click", () => showScreen(mainScreen));
saveAlarmBtn.addEventListener("click", saveAlarmFromEdit);
deleteAlarmBtn.addEventListener("click", deleteCurrentAlarm);

settingsBtn.addEventListener("click", () => {
  use24hToggle.checked = settings.use24Hour;
  renderStakesSettingsUI(false);
  showScreen(settingsScreen);
});
closeSettingsBtn.addEventListener("click", () => showScreen(mainScreen));
use24hToggle.addEventListener("change", () => {
  settings.use24Hour = use24hToggle.checked;
  saveSettings();
  updateLiveClock();
  renderAlarmList();
  updateNextAlarmBanner();
});

dayToggles.forEach(btn => {
  btn.addEventListener("click", () => btn.classList.toggle("active"));
});

gameToggle.addEventListener("change", () => {
  gameDifficultyRow.classList.toggle("hidden", !gameToggle.checked);
});

subscribeBtn.addEventListener("click", startCheckout);

previewSoundBtn.addEventListener("click", () => {
  AlarmSound.previewFor(1500, soundSelect.value);
});

snoozeBtn.addEventListener("click", handleSnooze);
dismissBtn.addEventListener("click", handleDismissRequest);

window.addEventListener("resize", () => {
  if (activeRingingAlarm && !reflexGame.classList.contains("hidden") && reflexTargetEl) {
    spawnReflexTarget();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && activeRingingAlarm) {
    requestWakeLock();
  }
});

/* ---------------- Service worker (PWA installability) ----------------
   Registering also triggers the browser's own byte-diff check against the
   deployed sw.js. When it finds a newer one, we let it activate immediately
   (sw.js already calls skipWaiting/clients.claim) and then reload this page
   once, so a visitor never gets stuck on an old cached version.

   Guarded with a sessionStorage flag: a CDN edge briefly serving mismatched
   copies of sw.js can otherwise make this fire repeatedly and reload-loop
   the page. At most one auto-reload happens per tab session. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state !== "activated" || !navigator.serviceWorker.controller) return;
          let alreadyReloaded = false;
          try { alreadyReloaded = sessionStorage.getItem("sw_auto_reloaded") === "1"; } catch (e) {}
          if (alreadyReloaded) return;
          try { sessionStorage.setItem("sw_auto_reloaded", "1"); } catch (e) {}
          window.location.reload();
        });
      });
    }).catch(() => {});
  });
}

/* ---------------- Install prompt + tracking ----------------
   beforeinstallprompt only fires once real PWA criteria are met (manifest +
   registered service worker). We stash the event and surface our own button
   instead of relying on the browser's default mini-infobar.

   Install counting uses Abacus (abacus.jasoncameron.dev), a free anonymous
   hit-counter API — no account, no keys. The namespace/key pair below is the
   counter's address; anyone who knows both could technically read or bump
   it, but nobody stumbles onto this by using the app normally. */
const INSTALL_COUNTER_NAMESPACE = "blare-heavysleeper-nate";
const INSTALL_COUNTER_KEY = "installs";

const installBanner = document.getElementById("install-banner");
const installBtn = document.getElementById("install-btn");
let deferredInstallPrompt = null;

function recordInstallPing() {
  fetch(`https://abacus.jasoncameron.dev/hit/${INSTALL_COUNTER_NAMESPACE}/${INSTALL_COUNTER_KEY}`).catch(() => {});
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installBanner.classList.remove("hidden");
});

installBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBanner.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  installBanner.classList.add("hidden");
  recordInstallPing();
});

/* ---------------- Wake-Up Stakes (Stripe) ---------------- */
async function stripeApi(path, options) {
  const res = await fetch(`${STAKES_API_BASE}${path}`, {
    method: options && options.body ? "POST" : "GET",
    headers: options && options.body ? { "Content-Type": "application/json" } : undefined,
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`Stakes API ${path} failed: ${res.status}`);
  return res.json();
}

function renderStakesSettingsUI(loading) {
  stakesLoadingEl.classList.toggle("hidden", !loading);
  stakesNotSubscribedEl.classList.toggle("hidden", loading || subscribed);
  stakesSubscribedEl.classList.toggle("hidden", loading || !subscribed);
}

function updateStakesToggleLock() {
  stakesToggle.disabled = !subscribed;
  stakesLockedHint.classList.toggle("hidden", subscribed);
  if (!subscribed) stakesToggle.checked = false;
}

async function checkSubscriptionOnLoad() {
  renderStakesSettingsUI(true);

  // Coming back from a successful Stripe Checkout redirect.
  const params = new URLSearchParams(location.search);
  const checkoutSessionId = params.get("session_id");
  if (params.get("checkout") === "success" && checkoutSessionId) {
    try {
      const result = await stripeApi(`/checkout-result?session_id=${encodeURIComponent(checkoutSessionId)}`);
      if (result.customerId) {
        stripeCustomerId = result.customerId;
        localStorage.setItem(STAKES_CUSTOMER_KEY, stripeCustomerId);
      }
      subscribed = !!result.subscribed;
      if (subscribed) showToast("Subscribed! Stakes are now unlocked.");
    } catch (e) {
      showToast("Couldn't confirm your subscription — try Settings again in a moment.");
    }
    // Clean the query string so a refresh doesn't re-process the same session.
    history.replaceState(null, "", location.pathname);
    renderStakesSettingsUI(false);
    updateStakesToggleLock();
    return;
  }

  if (!stripeCustomerId) {
    subscribed = false;
    renderStakesSettingsUI(false);
    updateStakesToggleLock();
    return;
  }

  try {
    const result = await stripeApi(`/subscription-status?customer_id=${encodeURIComponent(stripeCustomerId)}`);
    subscribed = !!result.subscribed;
  } catch (e) {
    subscribed = false; // fail closed on the paywall check, but never blocks the alarm itself
  }
  renderStakesSettingsUI(false);
  updateStakesToggleLock();
}

async function startCheckout() {
  subscribeBtn.disabled = true;
  subscribeBtn.textContent = "Redirecting…";
  try {
    const { url } = await stripeApi("/create-checkout-session", { body: {} });
    window.location.href = url;
  } catch (e) {
    showToast("Couldn't start checkout — try again in a moment.");
    subscribeBtn.disabled = false;
    subscribeBtn.textContent = "Subscribe — $2.99/mo";
  }
}

async function startStakeHold(alarm) {
  if (!alarm.stakesEnabled || !subscribed || !stripeCustomerId) return;
  try {
    const result = await stripeApi("/stake/start", { body: { customer_id: stripeCustomerId } });
    activeStakeIntentId = result.paymentIntentId;
    stakesBadge.classList.remove("hidden");
  } catch (e) {
    // Fail open: a Stakes backend hiccup shouldn't be able to keep the alarm
    // from doing its actual job of waking you up.
    activeStakeIntentId = null;
  }
}

async function releaseStakeIfAny() {
  if (!activeStakeIntentId) return;
  const id = activeStakeIntentId;
  activeStakeIntentId = null;
  try {
    await stripeApi("/stake/release", { body: { payment_intent_id: id } });
  } catch (e) { /* nothing actionable client-side if this fails */ }
}

async function captureStakeIfAny() {
  if (!activeStakeIntentId) return;
  const id = activeStakeIntentId;
  activeStakeIntentId = null;
  try {
    await stripeApi("/stake/capture", { body: { payment_intent_id: id } });
  } catch (e) { /* nothing actionable client-side if this fails */ }
}

/* Owner-only view: visiting the site with ?stats in the URL shows a small
   permanent pill at the bottom of the screen with the live install count.
   Regular installers never see this — it's not part of the normal UI, and
   the element stays hidden unless that query param is present. Tap it to
   re-fetch the latest number. */
const ownerStatsTab = document.getElementById("owner-stats-tab");

function refreshOwnerStatsTab() {
  ownerStatsTab.textContent = "Installs: …";
  fetch(`https://abacus.jasoncameron.dev/get/${INSTALL_COUNTER_NAMESPACE}/${INSTALL_COUNTER_KEY}`)
    .then((r) => r.json())
    .then((data) => { ownerStatsTab.textContent = `Installs: ${data.value}`; })
    .catch(() => { ownerStatsTab.textContent = "Installs: —"; });
}

function maybeShowInstallStats() {
  if (!new URLSearchParams(location.search).has("stats")) return;
  ownerStatsTab.classList.remove("hidden");
  ownerStatsTab.addEventListener("click", refreshOwnerStatsTab);
  refreshOwnerStatsTab();
}

/* ---------------- Init ---------------- */
maybeShowInstallStats();
checkStreakOnLoad();
renderStreak();
renderAlarmList();
updateNextAlarmBanner();
updateLiveClock();
startCheckLoop();
checkSubscriptionOnLoad();
