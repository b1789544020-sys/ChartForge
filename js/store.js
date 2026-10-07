/* ===================================================================
 * ChartForge · 本地存储层
 *   统一封装 localStorage 读写：
 *     - schema 版本号：结构变更时丢弃旧数据而不是崩掉
 *     - 容错：localStorage 被禁用 / 配额满 / JSON 损坏时安全降级
 *   模板与仪表盘布局共用这一层。
 * =================================================================== */
(function (global) {
  'use strict';

  const Store = {
    // 结构发生不兼容变更时递增，旧数据会被静默丢弃
    VERSION: 1,

    available: function () {
      try {
        const k = '__cf_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
      } catch (e) {
        return false;
      }
    },

    // 读取：返回 fallback 表示「无数据 / 数据不可用」
    // 兼容两种历史格式：
    //   1) 裸数据（v0，无包装）—— 直接返回，让调用方自行迁移
    //   2) { v, data } 包装格式
    read: function (key, fallback) {
      let raw;
      try {
        raw = localStorage.getItem(key);
      } catch (e) {
        return fallback;
      }
      if (!raw) return fallback;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // JSON 损坏：清掉，避免每次启动都失败
        this.remove(key);
        return fallback;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          Object.prototype.hasOwnProperty.call(parsed, 'v')) {
        // 版本不匹配 → 视为无数据（不迁移，避免把脏结构读进内存）
        if (parsed.v !== this.VERSION) {
          this.remove(key);
          return fallback;
        }
        return parsed.data === undefined ? fallback : parsed.data;
      }
      // 无包装的旧数据（例如早期直接存数组的模板列表）
      return parsed;
    },

    // 写入：返回是否成功（配额满时返回 false，调用方可提示用户）
    write: function (key, data) {
      try {
        localStorage.setItem(key, JSON.stringify({ v: this.VERSION, data: data }));
        return true;
      } catch (e) {
        return false;
      }
    },

    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) {}
    }
  };

  global.Store = Store;
})(window);
