/* ===================================================================
 * ChartForge · 数据导入模块
 *   - CSV 文件 / 粘贴文本
 *   - Excel 文件 (xlsx / xls, 通过 SheetJS)
 *   - 拖拽文件
 *   - 内置示例数据
 * =================================================================== */
(function (global) {
  'use strict';

  const Importer = {
    // ---------- 别名：兼容 E2E / 业务层常见命名 ----------
    importCSV: function (text, name) { return this.fromCSV(text, name); },
    importPaste: function (text) { return this.fromPasted(text); },
    // 通用别名：自动识别 CSV / TSV / 复制表格
    importText: function (text, hint) {
      if (!text) return null;
      const s = String(text);
      // 优先用 hint
      if (hint === 'csv' || hint === 'tsv' || hint === 'table') {
        return hint === 'tsv' ? this.fromTSV(s) : this.fromCSV(s);
      }
      // 自动判断
      if (s.indexOf('\t') !== -1 && s.indexOf(',') === -1) return this.fromTSV(s);
      if (/^sep=/.test(s.trim())) return this.fromCSV(s);
      // 简单启发：出现多列分隔则按 CSV
      return this.fromCSV(s);
    },
    fromTSV: function (text) {
      // 把 TSV 转为 CSV 再走 fromCSV
      const rows = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length);
      const csv = rows.map(line => line.split('\t').map(c => {
        const v = c;
        if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1) {
          return '"' + v.replace(/"/g, '""') + '"';
        }
        return v;
      }).join(',')).join('\n');
      return this.fromCSV(csv);
    },
    importExcel: function (file, callback) { return this.fromExcel(file, callback); },

    // ---------- 从文本/CSV 字符串导入 ----------
    fromCSV: function (text, name) {
      const result = Utils.parseCSV(text, 'auto');
      if (!result.columns.length) {
        throw new Error('CSV 解析失败：未检测到列名');
      }
      return DataSource.set(result.columns, result.rows, name || 'CSV 数据');
    },

    // ---------- 从粘贴文本导入（支持表格/CSV/TSV） ----------
    fromPasted: function (text) {
      if (!text || !text.trim()) {
        throw new Error('粘贴内容为空');
      }
      // 自动判断：含制表符 → TSV，含逗号 → CSV
      return this.fromCSV(text, '粘贴数据');
    },

    // ---------- Excel：当前打开的工作簿（用于事后切换工作表） ----------
    _workbook: null,
    _workbookFileName: '',

    // 把工作簿中的某个工作表转成 DataSource
    // 单独抽出来，便于「切换工作表」复用同一份解析逻辑，无需重读文件
    _sheetToDataSource: function (wb, sheetName, fileName) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) {
        throw new Error('工作表不存在：' + sheetName);
      }
      const rowsRaw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!rowsRaw || !rowsRaw.length) {
        throw new Error('工作表「' + sheetName + '」为空');
      }
      const columns = rowsRaw[0].map(c => String(c || '').trim());
      if (!columns.length || columns.every(c => !c)) {
        throw new Error('工作表「' + sheetName + '」缺少表头行');
      }
      const rows = [];
      for (let i = 1; i < rowsRaw.length; i++) {
        const raw = rowsRaw[i] || [];
        // sheet_to_json 的行长度可能短于表头（尾部空单元格被省略），需补齐
        const row = [];
        for (let c = 0; c < columns.length; c++) {
          const v = raw[c];
          row.push(String(v == null ? '' : v).trim());
        }
        if (row.every(c => !c)) continue;
        rows.push(row);
      }
      const label = (fileName || 'Excel') + (wb.SheetNames.length > 1 ? ' · ' + sheetName : '');
      return DataSource.set(columns, rows, label);
    },

    // 列出当前工作簿的所有工作表名
    listSheets: function () {
      return this._workbook && this._workbook.SheetNames ? this._workbook.SheetNames.slice() : [];
    },

    // 切换到指定工作表（不重新读取文件）
    selectSheet: function (sheetName) {
      if (!this._workbook) throw new Error('尚未加载 Excel 文件');
      const ds = this._sheetToDataSource(this._workbook, sheetName, this._workbookFileName);
      this._activeSheet = sheetName;
      return ds;
    },
    _activeSheet: '',

    // ---------- 从 Excel 文件导入 ----------
    // opts.sheetName    指定工作表；缺省取第一个
    // opts.onSheets(names, activeName) 多工作表时的通知回调（用于渲染选择器）
    fromExcel: function (file, callback, opts) {
      const self = this;
      opts = opts || {};
      if (typeof XLSX === 'undefined') {
        callback(new Error('SheetJS 库未加载，无法解析 Excel'));
        return;
      }
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: 'array' });
          if (!wb.SheetNames || !wb.SheetNames.length) {
            callback(new Error('Excel 文件没有可读取的工作表'));
            return;
          }
          self._workbook = wb;
          self._workbookFileName = file.name || 'Excel';

          let sheetName = opts.sheetName;
          if (!sheetName || wb.SheetNames.indexOf(sheetName) === -1) {
            sheetName = wb.SheetNames[0];
          }
          const ds = self._sheetToDataSource(wb, sheetName, self._workbookFileName);
          self._activeSheet = sheetName;

          if (wb.SheetNames.length > 1 && typeof opts.onSheets === 'function') {
            opts.onSheets(wb.SheetNames.slice(), sheetName);
          }
          callback(null, ds);
        } catch (err) {
          callback(err);
        }
      };
      reader.onerror = function () { callback(new Error('文件读取失败')); };
      reader.readAsArrayBuffer(file);
    },

    // ---------- 根据文件名自动选择导入方式 ----------
    fromFile: function (file, callback, opts) {
      const self = this;
      const name = (file.name || '').toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
        const reader = new FileReader();
        reader.onload = function (e) {
          try {
            const delimiter = name.endsWith('.tsv') ? '\t' : 'auto';
            const result = Utils.parseCSV(e.target.result, delimiter);
            const ds = DataSource.set(result.columns, result.rows, file.name);
            // 换成非 Excel 数据源后，上一个工作簿不再相关，
            // 否则 listSheets() 会返回陈旧的表名、工作表选择器无法隐藏。
            self._workbook = null;
            self._workbookFileName = '';
            self._activeSheet = '';
            callback(null, ds);
          } catch (err) { callback(err); }
        };
        reader.onerror = function () { callback(new Error('文件读取失败')); };
        reader.readAsText(file, 'UTF-8');
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        this.fromExcel(file, callback, opts);
      } else {
        callback(new Error('不支持的文件类型：' + file.name + '（仅支持 CSV / TSV / Excel）'));
      }
    },

    // ---------- 内置示例数据 ----------
    fromSample: function (index) {
      const data = (SampleData && SampleData.get(index)) || SampleData.list[0];
      return DataSource.set(data.columns, data.rows, data.name);
    },

    // ---------- 渲染示例数据列表到 UI ----------
    renderSampleList: function () {
      const listEl = document.getElementById('sampleDataList');
      if (!listEl) return;
      const list = (SampleData && SampleData.list) || [];
      listEl.innerHTML = list.map((d, i) => (
        '<div class="sample-item" data-idx="' + i + '" title="' + Utils.escapeHtml(d.description || '') + '">' +
          '<span class="sample-icon">📊</span>' +
          '<div class="sample-info">' +
            '<div class="sample-name">' + Utils.escapeHtml(d.name) + '</div>' +
            '<div class="sample-desc">' + Utils.escapeHtml(d.description || '') + '</div>' +
          '</div>' +
        '</div>'
      )).join('');
    },

    // ---------- 处理已加载的数据集（统一回调） ----------
    handleLoaded: function (ds, errMsg) {
      if (errMsg) {
        Utils.toast('导入失败：' + errMsg, 'error');
        return;
      }
      if (!ds) return;
      Utils.toast('已导入 ' + ds.rows.length + ' 行 × ' + ds.columns.length + ' 列', 'success');
      // 触发全局事件
      global.dispatchEvent(new CustomEvent('data:loaded', { detail: ds }));
    },

    // ---------- 工作表选择器（多工作表 Excel） ----------
    renderSheetPicker: function (names, active) {
      const box = document.getElementById('sheetPicker');
      if (!box) return;
      if (!names || names.length < 2) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
      }
      let html = '<label class="sheet-picker-label">📑 工作表：</label>';
      html += '<select id="sheetSelect">';
      names.forEach(n => {
        html += '<option value="' + Utils.escapeHtml(n) + '"' +
                (n === active ? ' selected' : '') + '>' + Utils.escapeHtml(n) + '</option>';
      });
      html += '</select>';
      box.innerHTML = html;
      box.style.display = 'flex';

      const self = this;
      const sel = document.getElementById('sheetSelect');
      if (sel) {
        sel.addEventListener('change', () => {
          try {
            const ds = self.selectSheet(sel.value);
            self.handleLoaded(ds);
          } catch (err) {
            self.handleLoaded(null, err.message);
          }
        });
      }
    },

    // 统一的文件导入入口：处理工作表选择器的显示/隐藏
    _importFile: function (file) {
      const self = this;
      self.fromFile(file, (err, ds) => {
        if (err) { self.handleLoaded(null, err.message); return; }
        // 单表或 CSV：确保旧的选择器被清掉，避免残留误导
        if (!Importer._workbook || Importer.listSheets().length < 2) {
          self.renderSheetPicker([], '');
        }
        self.handleLoaded(ds);
      }, {
        onSheets: function (names, active) { self.renderSheetPicker(names, active); }
      });
    },

    // ---------- 初始化 UI 事件绑定 ----------
    init: function () {
      const self = this;

      // 1. 渲染示例数据列表
      this.renderSampleList();

      // 2. 点击选择文件
      const selectBtn = document.getElementById('selectFileBtn');
      const fileInput = document.getElementById('fileInput');
      if (selectBtn && fileInput) {
        selectBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          self._importFile(f);
          fileInput.value = '';
        });
      }

      // 3. 拖拽文件
      const dropZone = document.getElementById('dropZone');
      if (dropZone) {
        const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); };
        const onDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over'); };
        const onDrop = (e) => {
          e.preventDefault(); e.stopPropagation();
          dropZone.classList.remove('drag-over');
          const f = e.dataTransfer.files && e.dataTransfer.files[0];
          if (!f) return;
          self._importFile(f);
        };
        dropZone.addEventListener('dragover', onDragOver);
        dropZone.addEventListener('dragleave', onDragLeave);
        dropZone.addEventListener('drop', onDrop);
        // 阻止 body 默认拖拽行为（防止浏览器打开文件）
        document.addEventListener('dragover', (e) => e.preventDefault());
        document.addEventListener('drop', (e) => e.preventDefault());
      }

      // 4. 粘贴区
      const pasteBtn = document.getElementById('pasteDataBtn');
      const pasteArea = document.getElementById('pasteArea');
      const pasteCancel = document.getElementById('pasteCancelBtn');
      const pasteConfirm = document.getElementById('pasteConfirmBtn');
      const pasteInput = document.getElementById('pasteInput');
      if (pasteBtn && pasteArea) {
        pasteBtn.addEventListener('click', () => {
          pasteArea.style.display = pasteArea.style.display === 'none' ? 'block' : 'none';
        });
      }
      if (pasteCancel && pasteArea) {
        pasteCancel.addEventListener('click', () => { pasteArea.style.display = 'none'; if (pasteInput) pasteInput.value = ''; });
      }
      if (pasteConfirm && pasteInput) {
        pasteConfirm.addEventListener('click', () => {
          try {
            const ds = self.fromPasted(pasteInput.value);
            self.handleLoaded(ds);
            pasteArea.style.display = 'none';
            pasteInput.value = '';
          } catch (err) {
            self.handleLoaded(null, err.message);
          }
        });
      }

      // 5. 示例数据点击
      const listEl = document.getElementById('sampleDataList');
      if (listEl) {
        listEl.addEventListener('click', (e) => {
          const item = e.target.closest('.sample-item');
          if (!item) return;
          const idx = parseInt(item.getAttribute('data-idx') || '0', 10);
          try {
            const ds = self.fromSample(idx);
            self.handleLoaded(ds);
          } catch (err) {
            self.handleLoaded(null, err.message);
          }
        });
      }
    }
  };

  global.Importer = Importer;
})(window);