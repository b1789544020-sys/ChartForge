/* ===================================================================
 * ChartForge · 通用工具函数
 * =================================================================== */
(function (global) {
  'use strict';

  const Utils = {
    // ---------- ID 生成 ----------
    uid: function (prefix) {
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    },

    // ---------- 数字处理 ----------
    isNumeric: function (v) {
      if (v === null || v === undefined || v === '') return false;
      if (typeof v === 'number') return isFinite(v);
      if (typeof v !== 'string') return false;
      const s = v.trim();
      if (!s) return false;
      const cleaned = s.replace(/,/g, '').replace(/%$/, '');
      return cleaned !== '' && !isNaN(Number(cleaned)) && isFinite(Number(cleaned));
    },

    toNumber: function (v) {
      if (typeof v === 'number') return v;
      if (typeof v !== 'string') return NaN;
      const s = v.trim().replace(/,/g, '').replace(/%$/, '');
      return Number(s);
    },

    formatNum: function (n, digits) {
      if (typeof n !== 'number' || !isFinite(n)) return String(n);
      if (Number.isInteger(n)) return String(n);
      const d = digits != null ? digits : 2;
      return Number(n.toFixed(d)).toString();
    },

    // ---------- CSV 解析 ----------
    parseCSV: function (text, delimiter) {
      if (!text) return { columns: [], rows: [] };
      if (!delimiter || delimiter === 'auto') {
        delimiter = this.detectDelimiter(text);
      }
      const lines = this._splitLines(text);
      if (!lines.length) return { columns: [], rows: [] };
      const columns = this._parseCSVLine(lines[0], delimiter);
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const cells = this._parseCSVLine(line, delimiter);
        if (cells.length === 0) continue;
        rows.push(cells);
      }
      return { columns, rows };
    },

    _splitLines: function (text) {
      const out = [];
      let cur = '';
      let inQuote = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
          if (inQuote && text[i + 1] === '"') {
            cur += '""'; i++;
          } else {
            inQuote = !inQuote;
            cur += ch;
          }
        } else if (!inQuote && (ch === '\n' || ch === '\r')) {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.length) out.push(cur);
      return out;
    },

    detectDelimiter: function (text) {
      const lines = this._splitLines(text).filter(l => l.trim()).slice(0, 5);
      if (!lines.length) return ',';
      const candidates = ['\t', ',', ';', '|'];
      let best = ',';
      let bestCount = -1;
      for (const d of candidates) {
        const counts = lines.map(l => (l.match(new RegExp('\\' + d, 'g')) || []).length);
        const min = Math.min.apply(null, counts);
        if (min > 0 && min > bestCount) { bestCount = min; best = d; }
      }
      return best;
    },

    _parseCSVLine: function (line, delimiter) {
      const out = [];
      let cur = '';
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
          if (ch === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; }
            else inQuote = false;
          } else cur += ch;
        } else {
          if (ch === '"') inQuote = true;
          else if (ch === delimiter) { out.push(cur); cur = ''; }
          else cur += ch;
        }
      }
      out.push(cur);
      return out.map(s => s.trim());
    },

    isDateLike: function (s) {
      if (typeof s !== 'string') return false;
      const str = s.trim();
      if (!str) return false;
      const patterns = [
        /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/,
        /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/,
        /^\d{4}年\d{1,2}月\d{1,2}日/,
        /^\d{4}-?\d{2}$/,
        /^\d{4}Q[1-4]$/i,
        /^\d{1,2}:\d{2}(:\d{2})?$/
      ];
      if (!patterns.some(p => p.test(str))) return false;
      const d = new Date(str.replace(/[/.]/g, '-'));
      return !isNaN(d.getTime());
    },

    uniqueCount: function (arr) {
      const s = new Set();
      for (const v of arr) s.add(v);
      return s.size;
    },

    sum: function (arr) {
      let s = 0; let has = false;
      for (const v of arr) {
        const n = typeof v === 'number' ? v : parseFloat(v);
        if (!isNaN(n)) { s += n; has = true; }
      }
      return has ? s : 0;
    },

    avg: function (arr) {
      const nums = arr.map(v => typeof v === 'number' ? v : parseFloat(v)).filter(v => !isNaN(v));
      if (!nums.length) return 0;
      return this.sum(nums) / nums.length;
    },

    max: function (arr) {
      const nums = arr.map(v => typeof v === 'number' ? v : parseFloat(v)).filter(v => !isNaN(v));
      return nums.length ? Math.max.apply(null, nums) : 0;
    },

    min: function (arr) {
      const nums = arr.map(v => typeof v === 'number' ? v : parseFloat(v)).filter(v => !isNaN(v));
      return nums.length ? Math.min.apply(null, nums) : 0;
    },

    count: function (arr) {
      return arr.filter(v => v !== null && v !== undefined && v !== '').length;
    },

    hexToRgb: function (hex) {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      if (!m) return { r: 0, g: 0, b: 0 };
      return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    },

    toast: function (msg, type, duration) {
      type = type || 'info';
      duration = duration || 2400;
      const c = document.getElementById('toastContainer') || document.getElementById('toast-container');
      if (!c) { console.log('[Toast]', msg); return; }
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.textContent = msg;
      c.appendChild(t);
      setTimeout(() => {
        t.classList.add('fade-out');
        setTimeout(() => t.remove(), 250);
      }, duration);
    },

    debounce: function (fn, ms) {
      let timer;
      return function () {
        const args = arguments, ctx = this;
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(ctx, args), ms);
      };
    },

    download: function (content, filename, mime) {
      const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    },

    copyToClipboard: async function (text) {
      if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(text); return true; }
        catch (e) { /* fall through */ }
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); document.body.removeChild(ta); return true; }
      catch (e) { document.body.removeChild(ta); return false; }
    },

    copyImageToClipboard: async function (blob) {
      if (!navigator.clipboard || !window.ClipboardItem) {
        return false;
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      } catch (e) {
        return false;
      }
    },

    // ---------- HTML 转义 ----------
    // 使用字符码拼接避免编辑器吃掉转义
    escapeHtml: function (s) {
      if (s === null || s === undefined) return '';
      return String(s)
        .replace(/&/g, String.fromCharCode(38, 97, 109, 112, 59)) // &
        .replace(/</g, String.fromCharCode(38, 108, 116, 59))     // <
        .replace(/>/g, String.fromCharCode(38, 103, 116, 59))     // >
        .replace(/"/g, String.fromCharCode(38, 113, 117, 111, 116, 59)) // "
        .replace(/'/g, String.fromCharCode(38, 35, 51, 57, 59));  // &#39;
    },

    formatNumber: function (n, digits) {
      if (typeof n !== 'number' || !isFinite(n)) return String(n);
      const d = digits != null ? digits : 2;
      const fixed = n.toFixed(d);
      const parts = fixed.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      if (parts[1]) parts[1] = parts[1].replace(/0+$/, '').replace(/^$/, '');
      return parts[1] ? parts.join('.') : parts[0];
    },

    aggregate: function (rows, groupBy, measure, op) {
      op = op || 'sum';
      if (!Array.isArray(rows) || !rows.length) return [];
      const get = (row, key) => (row == null ? undefined : row[key]);
      const num = (v) => {
        if (typeof v === 'number') return v;
        if (v === null || v === undefined || v === '') return NaN;
        const s = String(v).trim().replace(/,/g, '').replace(/%$/, '');
        const n = Number(s);
        return isFinite(n) ? n : NaN;
      };
      const bucket = new Map();
      if (!groupBy) {
        if (op === 'count') {
          return [{ key: '合计', value: rows.length }];
        }
        const vals = rows.map(r => num(get(r, measure))).filter(v => !isNaN(v));
        if (!vals.length) return [{ key: '合计', value: 0 }];
        let v;
        switch (op) {
          case 'sum': v = vals.reduce((a, b) => a + b, 0); break;
          case 'avg': v = vals.reduce((a, b) => a + b, 0) / vals.length; break;
          case 'min': v = Math.min.apply(null, vals); break;
          case 'max': v = Math.max.apply(null, vals); break;
          default: v = vals.reduce((a, b) => a + b, 0);
        }
        return [{ key: '合计', value: v }];
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const k = get(r, groupBy);
        const ks = (k === null || k === undefined || k === '') ? '(空)' : String(k);
        if (!bucket.has(ks)) bucket.set(ks, []);
        bucket.get(ks).push(r);
      }
      const out = [];
      bucket.forEach((rs, k) => {
        let v;
        if (op === 'count') {
          v = rs.length;
        } else {
          const vals = rs.map(r => num(get(r, measure))).filter(x => !isNaN(x));
          if (!vals.length) { v = 0; }
          else {
            switch (op) {
              case 'sum': v = vals.reduce((a, b) => a + b, 0); break;
              case 'avg': v = vals.reduce((a, b) => a + b, 0) / vals.length; break;
              case 'min': v = Math.min.apply(null, vals); break;
              case 'max': v = Math.max.apply(null, vals); break;
              default: v = vals.reduce((a, b) => a + b, 0);
            }
          }
        }
        out.push({ key: k, value: v });
      });
      return out;
    },

    // ---------- 列签名相似度（Jaccard 加权：列名+类型） ----------
    colSignatureSimilarity: function (a, b) {
      if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
      const setA = new Set(a.map(s => String(s).toLowerCase()));
      const setB = new Set(b.map(s => String(s).toLowerCase()));
      let inter = 0;
      setA.forEach(x => { if (setB.has(x)) inter++; });
      const union = new Set([...setA, ...setB]).size;
      const jaccard = union ? inter / union : 0;
      // 长度差异惩罚
      const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      return jaccard * 0.7 + lenRatio * 0.3;
    }
  };

  Utils.themes = {
    default: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#48b8d0'],
    vivid:   ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#FFD93D', '#6BCB77', '#C77DFF', '#FF8FAB', '#00B4D8'],
    pastel:  ['#FFB5A7', '#FCD5CE', '#F8EDEB', '#F9DCC4', '#FEC89A', '#FFD6A5', '#FDFFB6', '#CAFFBF', '#9BF6FF', '#A0C4FF'],
    dark:    ['#FF6B6B', '#FFD93D', '#6BCB77', '#4ECDC4', '#FF8FAB', '#A0E7E5', '#FFAEBC', '#B4F8C8', '#FBE7C6', '#7FDBFF'],
    business:['#1f3a5f', '#4a6fa5', '#6c8ebf', '#9bb1d4', '#c4d4e8', '#5a7a9a', '#7a98bd', '#2e5a87', '#8aabc9', '#a8c4dd'],
    custom:  []
  };

  global.Utils = Utils;
})(window);