/* ===================================================================
 * ChartForge · 导出
 *   PNG (1x/2x/3x) / SVG / 复制到剪贴板
 * =================================================================== */
(function (global) {
  'use strict';

  const Exporter = {
    exportPNG: function (chartId, filename, scale) {
      const chart = ChartRenderer.get(chartId);
      if (!chart) {
        Utils.toast('图表未就绪', 'error');
        return;
      }
      scale = scale || 2;
      try {
        const dataUrl = chart.getDataURL({
          type: 'png',
          pixelRatio: scale,
          backgroundColor: State.theme === 'dark' ? '#1a1d23' : '#ffffff'
        });
        this._downloadDataURL(dataUrl, (filename || 'chart') + '_' + scale + 'x.png');
        Utils.toast('已导出 PNG (' + scale + 'x)', 'success');
      } catch (e) {
        console.error(e);
        Utils.toast('导出 PNG 失败: ' + e.message, 'error');
      }
    },

    exportSVG: function (chartId, filename) {
      const chart = ChartRenderer.get(chartId);
      if (!chart) {
        Utils.toast('图表未就绪', 'error');
        return;
      }
      try {
        let svgStr = '';
        // 优先使用 ECharts 原生 SVG 渲染
        if (typeof chart.renderToSVGString === 'function') {
          try {
            svgStr = chart.renderToSVGString();
          } catch (innerErr) {
            // SVG renderer 未注册（基础版 echarts 不含 svg renderer），走兜底
            svgStr = '';
          }
        }
        if (!svgStr) {
          // 兜底：从 canvas 生成 dataURL，包装为 SVG <image> 元素。
          // 仍是合法的 .svg 文件（可缩放、可在浏览器/设计软件打开）。
          const dom = chart.getDom ? chart.getDom() : document.getElementById(chartId);
          const w = (dom && dom.clientWidth) || 800;
          const h = (dom && dom.clientHeight) || 500;
          const dataUrl = chart.getDataURL({
            type: 'png',
            pixelRatio: 2,
            backgroundColor: State.theme === 'dark' ? '#1a1d23' : '#ffffff'
          });
          svgStr =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
            'width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">\n' +
            '  <image x="0" y="0" width="' + w + '" height="' + h + '" ' +
            'xlink:href="' + dataUrl + '"/>\n' +
            '</svg>';
        }
        const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        this._downloadURL(url, (filename || 'chart') + '.svg');
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        Utils.toast('已导出 SVG', 'success');
      } catch (e) {
        console.error(e);
        Utils.toast('导出 SVG 失败: ' + e.message, 'error');
      }
    },

    copyToClipboard: function (chartId) {
      const chart = ChartRenderer.get(chartId);
      if (!chart) {
        Utils.toast('图表未就绪', 'error');
        return;
      }
      try {
        const dataUrl = chart.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor: State.theme === 'dark' ? '#1a1d23' : '#ffffff'
        });
        // 优先使用 ClipboardItem（PNG 格式）
        if (navigator.clipboard && window.ClipboardItem) {
          dataUrlToBlob(dataUrl).then(blob => {
            const item = new ClipboardItem({ 'image/png': blob });
            navigator.clipboard.write([item]).then(
              () => Utils.toast('已复制到剪贴板', 'success'),
              () => Utils.toast('剪贴板被浏览器拒绝', 'error')
            );
          });
        } else {
          // 兜底：仅复制 dataURL 文本
          navigator.clipboard.writeText(dataUrl).then(
            () => Utils.toast('已复制图表链接到剪贴板（部分浏览器仅支持文本）', 'info'),
            () => Utils.toast('剪贴板权限被拒绝', 'error')
          );
        }
      } catch (e) {
        console.error(e);
        Utils.toast('复制失败: ' + e.message, 'error');
      }
    },

    // ---------- 导出当前数据集为 CSV ----------
    // 导出的是 DataSource.current（含类型推断后的原始行），
    // 带 UTF-8 BOM 以便 Excel 正确识别中文
    exportCSV: function (filename) {
      const ds = DataSource.current;
      if (!ds || !ds.columns.length) {
        Utils.toast('暂无数据可导出', 'warning');
        return null;
      }
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const lines = [ds.columns.map(esc).join(',')];
      ds.rows.forEach(r => {
        lines.push(ds.columns.map((_, i) => esc(r[i])).join(','));
      });
      const csv = '\ufeff' + lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      this._downloadURL(url, (filename || ds.name || 'data') + '.csv');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Utils.toast('已导出 CSV（' + ds.rows.length + ' 行）', 'success');
      return csv;
    },

    _downloadDataURL: function (dataUrl, filename) {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },

    _downloadURL: function (url, filename) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  function dataUrlToBlob(dataUrl) {
    return new Promise((resolve, reject) => {
      try {
        const arr = dataUrl.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        while (n--) u8arr[n] = bstr.charCodeAt(n);
        resolve(new Blob([u8arr], { type: mime }));
      } catch (e) {
        reject(e);
      }
    });
  }

  global.Exporter = Exporter;
})(window);