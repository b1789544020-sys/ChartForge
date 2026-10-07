/* ===================================================================
 * ChartForge · 数据预览表格
 *   搜索 / 排序 / 分页
 * =================================================================== */
(function (global) {
  'use strict';

  const DataTable = {
    state: {
      page: 1,
      pageSize: 10,
      search: '',
      sortCol: null,
      sortDir: 'asc'
    },

    render: function (containerId) {
      const el = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
      if (!el) return;
      const ds = DataSource.current;
      if (!ds.columns.length) {
        el.innerHTML = '<div class="empty-hint">暂无数据，请先导入 CSV / Excel 或加载示例数据</div>';
        return;
      }
      const filtered = this._filterAndSort();
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / this.state.pageSize));
      if (this.state.page > totalPages) this.state.page = totalPages;
      const start = (this.state.page - 1) * this.state.pageSize;
      const rows = filtered.slice(start, start + this.state.pageSize);

      let html = '<div class="data-table-toolbar">';
      html += '<input type="text" id="dataTableSearch" placeholder="🔍 搜索关键字..." value="' + Utils.escapeHtml(this.state.search) + '" />';
      html += '<span class="data-table-info">共 ' + ds.rows.length + ' 行，' + ds.columns.length + ' 列' +
              (this.state.search ? '（过滤后 ' + total + ' 行）' : '') + '</span>';
      html += '<select id="dataTablePageSize">';
      [5, 10, 20, 50, 100].forEach(n => {
        html += '<option value="' + n + '"' + (n === this.state.pageSize ? ' selected' : '') + '>' + n + ' / 页</option>';
      });
      html += '</select>';
      html += '</div>';

      html += '<div class="data-table-wrap"><table class="data-table"><thead><tr>';
      ds.columns.forEach((c, i) => {
        const typeBadge = '<span class="col-type col-type-' + ds.types[i] + '">' + this._typeLabel(ds.types[i]) + '</span>';
        const sortIcon = this.state.sortCol === i ? (this.state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
        html += '<th data-col="' + i + '">' + Utils.escapeHtml(c) + typeBadge + '<span class="sort-icon">' + sortIcon + '</span></th>';
      });
      html += '</tr></thead><tbody>';
      if (rows.length === 0) {
        html += '<tr><td colspan="' + ds.columns.length + '" class="empty-row">无匹配数据</td></tr>';
      } else {
        rows.forEach(r => {
          html += '<tr>';
          ds.columns.forEach((_, ci) => {
            html += '<td>' + Utils.escapeHtml(r[ci] == null ? '' : String(r[ci])) + '</td>';
          });
          html += '</tr>';
        });
      }
      html += '</tbody></table></div>';

      // 分页
      html += '<div class="data-table-pager">';
      html += '<button class="pg-btn" data-page="1" ' + (this.state.page === 1 ? 'disabled' : '') + '>« 首页</button>';
      html += '<button class="pg-btn" data-page="' + (this.state.page - 1) + '" ' + (this.state.page === 1 ? 'disabled' : '') + '>‹ 上一页</button>';
      html += '<span class="pg-info">第 ' + this.state.page + ' / ' + totalPages + ' 页</span>';
      html += '<button class="pg-btn" data-page="' + (this.state.page + 1) + '" ' + (this.state.page === totalPages ? 'disabled' : '') + '>下一页 ›</button>';
      html += '<button class="pg-btn" data-page="' + totalPages + '" ' + (this.state.page === totalPages ? 'disabled' : '') + '>末页 »</button>';
      html += '</div>';

      el.innerHTML = html;
      this._bindEvents(el);
    },

    _typeLabel: function (t) {
      return { 'number': '数值', 'time': '时间', 'category': '分类', 'text': '文本' }[t] || t;
    },

    _filterAndSort: function () {
      const ds = DataSource.current;
      let rows = ds.rows;
      const search = this.state.search.toLowerCase().trim();
      if (search) {
        rows = rows.filter(r => r.some(c => String(c || '').toLowerCase().indexOf(search) !== -1));
      }
      if (this.state.sortCol != null) {
        const col = this.state.sortCol;
        const dir = this.state.sortDir === 'asc' ? 1 : -1;
        rows = rows.slice().sort((a, b) => {
          const av = a[col], bv = b[col];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (ds.types[col] === 'number' && Utils.isNumeric(av) && Utils.isNumeric(bv)) {
            return (Utils.toNumber(av) - Utils.toNumber(bv)) * dir;
          }
          if (ds.types[col] === 'time') {
            const ad = new Date(String(av).replace(/[/.]/g, '-')).getTime();
            const bd = new Date(String(bv).replace(/[/.]/g, '-')).getTime();
            if (!isNaN(ad) && !isNaN(bd)) return (ad - bd) * dir;
          }
          return String(av).localeCompare(String(bv), 'zh-CN') * dir;
        });
      }
      return rows;
    },

    _bindEvents: function (root) {
      const self = this;
      const search = root.querySelector('#dataTableSearch');
      if (search) {
        let timer;
        search.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(() => {
            self.state.search = this.value;
            self.state.page = 1;
            self.render(document.getElementById('dataTable'));
          }, 200);
        });
      }
      const pageSize = root.querySelector('#dataTablePageSize');
      if (pageSize) {
        pageSize.addEventListener('change', function () {
          self.state.pageSize = parseInt(this.value, 10);
          self.state.page = 1;
          self.render(document.getElementById('dataTable'));
        });
      }
      root.querySelectorAll('.data-table thead th').forEach(th => {
        th.addEventListener('click', () => {
          const col = parseInt(th.dataset.col, 10);
          if (self.state.sortCol === col) {
            self.state.sortDir = self.state.sortDir === 'asc' ? 'desc' : 'asc';
          } else {
            self.state.sortCol = col;
            self.state.sortDir = 'asc';
          }
          self.render(document.getElementById('dataTable'));
        });
      });
      root.querySelectorAll('.pg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          self.state.page = parseInt(btn.dataset.page, 10);
          self.render(document.getElementById('dataTable'));
        });
      });
    }
  };

  global.DataTable = DataTable;
})(window);