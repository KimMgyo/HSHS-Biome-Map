import { api, assetUrl } from './api.js';
import { kindInfo } from './plants.js';
import { distanceMeters } from './geo.js';

const dateFormat = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

/** Read-only plant details for everyone; admins also get a delete button. */
export class PlantCard {
  constructor({ root, viewer, layer, admin, gps, toast }) {
    this.root = root;
    this.viewer = viewer;
    this.layer = layer;
    this.admin = admin;
    this.gps = gps;
    this.toast = toast;
    this.plant = null;
    root.querySelector('[data-act="close"]').addEventListener('click', () => this.close());
    root.querySelector('[data-act="delete"]').addEventListener('click', () => this.remove());
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    admin.addEventListener('change', () => this.render());
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(plant, { fly = true } = {}) {
    this.plant = plant;
    this.render();
    this.root.hidden = false;
    this.root.scrollTop = 0;
    document.body.classList.add('sheet-open');
    this.layer.select(plant.id);
    const item = this.layer.items.get(plant.id);
    if (fly && item) this.viewer.centerOn(item.world, { duration: 600 });
  }

  close() {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.plant = null;
    this.layer.select(null);
    document.body.classList.remove('sheet-open');
  }

  render() {
    const p = this.plant;
    if (!p) return;
    const kind = kindInfo(p.kind);
    const photo = assetUrl(p.photo);
    const $ = (sel) => this.root.querySelector(sel);
    $('.photo').href = photo;
    $('.photo img').src = photo;
    $('.photo img').alt = p.name + ' 사진';
    $('#plant-card-name').textContent = p.name;
    $('.kind-chip img').src = kind.thumb;
    $('.kind-chip span').textContent = kind.label;
    $('.date').textContent = dateFormat.format(new Date(p.createdAt)) + ' 등록';
    const fix = this.gps.fix;
    $('.distance').textContent = fix ? '내 위치에서 약 ' + Math.round(distanceMeters(fix, p)) + ' m' : '';
    const desc = $('.description');
    desc.textContent = p.description || '설명이 아직 없습니다.';
    desc.classList.toggle('empty', !p.description);
    $('.admin-actions').hidden = !this.admin.isAdmin;
  }

  async remove() {
    const p = this.plant;
    if (!p || !confirm('"' + p.name + '"을(를) 지도에서 삭제할까요? 사진도 함께 지워집니다.')) return;
    const btn = this.root.querySelector('[data-act="delete"]');
    btn.disabled = true;
    try {
      await api.deletePlant(p.id);
      this.layer.remove(p.id);
      this.close();
      this.toast('"' + p.name + '"을(를) 삭제했습니다.');
    } catch (err) {
      if (err.status === 401) this.admin.expired();
      if (err.status === 404) {
        this.layer.remove(p.id);
        this.close();
      }
      this.toast(err.message);
    } finally {
      btn.disabled = false;
    }
  }
}
