import './styles.css';
import { SchoolViewer } from './viewer.js';
import { Georef } from './geo.js';
import { LocationLayer } from './location.js';
import { api } from './api.js';
import { AdminController } from './admin.js';
import { PlantLayer } from './plants.js';
import { PlantCard } from './plant-card.js';
import { PlantEditor } from './plant-editor.js';
import {
  GEOREF_URL,
  GLASS_MATERIALS,
  GROUND_OBJECTS,
  MAX_MARKER_DISTANCE_M,
  MODEL_URL,
  PLANT_PLACE_RADIUS_M,
  STORAGE_KEYS,
} from './config.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(window.location.search);

const ERROR_TEXT = {
  insecure: '위치 기능은 https:// 주소에서만 켜집니다. 배포된 주소나 "npm run dev:phone" 주소로 접속하세요.',
  unsupported: '이 브라우저는 위치 기능을 지원하지 않습니다.',
  denied: '위치 권한이 꺼져 있습니다. 주소창의 사이트 설정에서 위치를 허용한 뒤 다시 눌러 주세요.',
  unavailable: 'GPS 신호를 찾지 못했습니다. 실외로 나가거나 잠시 뒤 다시 시도하세요.',
  timeout: '위치를 받는 데 시간이 걸리고 있습니다. 계속 찾는 중입니다.',
};

let toastTimer;
function toast(message, ms = 4200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function formatDistance(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

async function loadGeoref() {
  const defaults = await fetch(GEOREF_URL).then((r) => r.json());
  let override = null;
  try {
    override = JSON.parse(localStorage.getItem(STORAGE_KEYS.georef));
  } catch {
    override = null;
  }
  return { defaults, active: override || defaults, calibrated: Boolean(override) };
}

async function main() {
  const viewer = new SchoolViewer($('#scene'));
  viewer.setGroundNames(GROUND_OBJECTS);
  viewer.setGlassMaterials(GLASS_MATERIALS);

  const bar = $('#loading .bar span');
  const [geo] = await Promise.all([
    loadGeoref(),
    viewer.load(MODEL_URL, (p) => (bar.style.width = Math.round(p * 100) + '%')),
  ]);
  $('#loading').classList.add('done');

  const georef = new Georef(geo.active);
  const gps = new LocationLayer(viewer, georef, { maxDistance: MAX_MARKER_DISTANCE_M });
  const locateBtn = $('#btn-locate');
  const chip = $('#gps-chip');
  let following = false;
  let flyOnFix = false;

  const setFollowing = (on) => {
    following = on;
    locateBtn.classList.toggle('following', on);
  };
  viewer.onUserMove = () => setFollowing(false);

  const focusOnUser = () => {
    if (!gps.group.visible || !gps.isOnMap()) return false;
    viewer.centerOn(gps.worldPos, { distance: 220 });
    setFollowing(true);
    return true;
  };

  gps.addEventListener('status', (e) => {
    const s = e.detail;
    chip.hidden = s.state === 'off';
    chip.dataset.state = s.state;
    if (s.state === 'off' || s.state === 'error') setFollowing(false);
    locateBtn.classList.toggle('searching', s.state === 'searching');
    if (s.state === 'searching') chip.querySelector('.label').textContent = '위치 찾는 중…';
    if (s.state === 'error') {
      chip.querySelector('.label').textContent = s.code === 'timeout' ? '신호 약함' : '위치 사용 불가';
      toast(ERROR_TEXT[s.code] || ERROR_TEXT.unavailable, 7000);
    }
    if (s.state === 'ok') {
      const quality = s.accuracy <= 10 ? 'good' : s.accuracy <= 30 ? 'fair' : 'poor';
      chip.dataset.quality = quality;
      let label = '내 위치 ±' + Math.round(s.accuracy) + ' m';
      if (!s.visible) label = '학교에서 ' + formatDistance(s.away);
      else if (!s.onMap) label = '학교 밖 · ' + formatDistance(s.away);
      chip.querySelector('.label').textContent = label;
      if (flyOnFix) {
        flyOnFix = false;
        if (!focusOnUser()) toast('지금은 학교 밖에 있어요 (학교 중심에서 약 ' + formatDistance(s.away) + '). 학교 안에서 다시 눌러 보세요.');
      }
    }
  });

  locateBtn.addEventListener('click', () => {
    if (!gps.tracking) {
      flyOnFix = true;
      gps.start();
      return;
    }
    if (!gps.fix) {
      flyOnFix = true;
      toast('위치를 찾는 중입니다…');
      return;
    }
    if (!focusOnUser()) toast('지금 위치가 지도 범위 밖입니다.');
  });

  viewer.onFrame(() => {
    if (following) {
      // Only follow while the person is on the map; otherwise the view would drift off the campus.
      if (gps.group.visible && gps.isOnMap()) viewer.follow(gps.worldPos);
      else setFollowing(false);
    }
    const angle = viewer.northScreenAngle(georef.axes().north);
    $('#compass .needle').style.transform = 'rotate(' + angle + 'rad)';
    const top = viewer.isTopView();
    $('#btn-view').dataset.mode = top ? 'top' : 'tilt';
  });

  $('#compass').addEventListener('click', () => viewer.faceNorth(georef.axes().north));
  $('#btn-home').addEventListener('click', () => {
    setFollowing(false);
    viewer.frameAll();
  });
  $('#btn-view').addEventListener('click', () => {
    const north = georef.axes().north;
    if (viewer.isTopView()) viewer.tiltView(north);
    else viewer.topView(north);
  });

  // ---------------------------------------------------------------- plants (step 3)
  const plants = new PlantLayer(viewer, georef);
  const admin = new AdminController({ button: $('#btn-admin'), badge: $('#admin-badge'), modal: $('#login-modal'), toast });
  const card = new PlantCard({ root: $('#plant-card'), viewer, layer: plants, admin, gps, toast });
  const addBtn = $('#btn-add-plant');
  const editor = new PlantEditor({
    viewer,
    georef,
    gps,
    layer: plants,
    admin,
    toast,
    bar: $('#place-bar'),
    form: $('#plant-form'),
    radiusM: PLANT_PLACE_RADIUS_M,
    onModeChange: (on) => {
      if (on) {
        card.close();
        setFollowing(false);
      }
      addBtn.hidden = on || !admin.isAdmin;
    },
    onSaved: (plant) => {
      toast('"' + plant.name + '"을(를) 지도에 심었습니다.');
      card.open(plant, { fly: false });
    },
  });
  const syncAdmin = () => (addBtn.hidden = !admin.isAdmin || editor.active);
  admin.addEventListener('change', syncAdmin);
  syncAdmin();
  admin.verify();
  addBtn.addEventListener('click', () => editor.start());

  viewer.onTap = (x, y) => {
    if (editor.handleTap(x, y)) return;
    const plant = plants.pickAt(x, y);
    if (plant) card.open(plant);
    else card.close();
  };

  const refreshPlants = async () => {
    try {
      await plants.ready;
      const list = await api.listPlants();
      plants.setPlants(list);
      if (card.plant && !plants.items.has(card.plant.id)) card.close();
    } catch (err) {
      toast('식물 정보를 불러오지 못했습니다. ' + err.message);
    }
  };
  refreshPlants();
  // Pick up plants that other admins added while this tab was in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !editor.active) refreshPlants();
  });

  if (params.has('calibrate')) {
    const { CalibrationPanel } = await import('./calibration.js');
    new CalibrationPanel({
      root: $('#calibration'),
      viewer,
      georef,
      location: gps,
      defaultConfig: geo.defaults,
      toast,
      onChange: () => plants.relayout(),
    });
  } else if (geo.calibrated) {
    $('#calibrated-badge').hidden = false;
  }

  // Handy for checking things from the browser console.
  window.biomemap = { viewer, georef, gps, plants, admin, editor, card };
}

main().catch((err) => {
  console.error(err);
  $('#loading').classList.add('failed');
  $('#loading .msg').textContent = '지도를 불러오지 못했습니다: ' + err.message;
});
