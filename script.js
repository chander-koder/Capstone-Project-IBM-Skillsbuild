/**
 * script.js — Dashboard Penerbitan Paspor Baru
 *
 * Alur utama:
 *   1. loadCSV()        — Baca & parse file CSV
 *   2. validateData()   — Validasi header & kolom jumlah
 *   3. buildFilters()   — Isi dropdown filter dari data
 *   4. renderAll()      — KPI + 4 grafik + tabel (dipanggil ulang tiap filter berubah)
 *
 * Konvensi angka:
 *   - Kolom `jumlah` menggunakan titik sebagai pemisah ribuan (mis. "1.365" → 1365)
 *   - Semua tampilan angka menggunakan locale "id-ID"
 */

'use strict';

// ===========================================================
// KONSTANTA
// ===========================================================

const CSV_PATH = 'jumlah-penerbitan-paspor-baru-berdasarkan-kelompok-usia.csv';

// Urutan bulan Indonesia (Januari = 1 ... Desember = 12)
const BULAN_ORDER = {
  'Januari': 1, 'Februari': 2, 'Maret': 3, 'April': 4,
  'Mei': 5, 'Juni': 6, 'Juli': 7, 'Agustus': 8,
  'September': 9, 'Oktober': 10, 'November': 11, 'Desember': 12
};

// Urutan tetap kelompok usia sesuai spesifikasi
const USIA_ORDER = ['0-10', '11-20', '21-30', '31-40', '41-50', '51-60', '61-70', 'DIATAS 70'];

// Label tampilan untuk kelompok usia (ramah pengguna)
const USIA_LABEL = {
  '0-10':     '0–10 tahun',
  '11-20':    '11–20 tahun',
  '21-30':    '21–30 tahun',
  '31-40':    '31–40 tahun',
  '41-50':    '41–50 tahun',
  '51-60':    '51–60 tahun',
  '61-70':    '61–70 tahun',
  'DIATAS 70':'Di atas 70 tahun'
};

// Palet warna konsisten untuk kelompok usia (8 warna)
const USIA_COLORS = [
  '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
  '#f97316', '#eab308', '#22c55e', '#14b8a6'
];

// Warna untuk grafik tren dan kantor wilayah
const COLOR_TREN   = '#1d4ed8';
const COLOR_KANWIL = '#3b82f6';

// Baris per halaman pada tabel
const ROWS_PER_PAGE = 25;

// ===========================================================
// STATE GLOBAL
// ===========================================================

let allData      = [];   // Seluruh baris valid dari CSV
let filteredData = [];   // Baris setelah filter diterapkan
let currentPage  = 1;    // Halaman tabel aktif

// Referensi instance Chart.js (agar dapat di-destroy & dibuat ulang)
let chartTren      = null;
let chartKanwil    = null;
let chartUsiaBar   = null;
let chartUsiaDonut = null;

// ===========================================================
// UTILITAS
// ===========================================================

/** Format angka dengan locale Indonesia (mis. 1234567 → "1.234.567") */
function fmtAngka(n) {
  return n.toLocaleString('id-ID');
}

/**
 * Parse kolom `jumlah` dari string CSV ke integer.
 * String "1.365" (titik ribuan) → integer 1365
 * Mengembalikan NaN jika tidak valid.
 */
function parseJumlah(str) {
  // Hapus titik pemisah ribuan, lalu konversi ke integer
  const cleaned = String(str).replace(/\./g, '').trim();
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? NaN : num;
}

/** Buat key kronologis "YYYY-MM" dari tahun (number) dan nama bulan (string) */
function periodKey(tahun, bulan) {
  const mm = String(BULAN_ORDER[bulan] || 0).padStart(2, '0');
  return `${tahun}-${mm}`;
}

/** Label periode untuk grafik tren — format "Jan 2025" */
function periodLabel(tahun, bulan) {
  const abbr = bulan.substring(0, 3); // "Januari" → "Jan"
  return `${abbr} ${tahun}`;
}

// ===========================================================
// 1. BACA CSV
// ===========================================================

async function loadCSV() {
  showState('loading');

  try {
    const response = await fetch(CSV_PATH);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — file tidak ditemukan: ${CSV_PATH}`);
    }
    const text = await response.text();
    parseCSV(text);
  } catch (err) {
    showState('error', err.message);
  }
}

function parseCSV(text) {
  // Papa Parse: delimiter ';', header baris pertama, skip baris kosong
  const result = Papa.parse(text, {
    delimiter:      ';',
    header:         true,
    skipEmptyLines: true,
    // Trim spasi & BOM pada nama kolom
    transformHeader: h => h.replace(/^\uFEFF/, '').trim().toLowerCase()
  });

  // Validasi header
  const requiredCols = ['kantor_wilayah', 'tahun', 'bulan', 'kelompok_usia', 'jumlah'];
  const headers = result.meta.fields || [];
  const missingCols = requiredCols.filter(c => !headers.includes(c));
  if (missingCols.length > 0) {
    showState('error', `Kolom tidak ditemukan: ${missingCols.join(', ')}. Header CSV: ${headers.join(', ')}`);
    return;
  }

  // Validasi & parsing setiap baris
  let skippedRows = 0;
  allData = [];

  for (const row of result.data) {
    const kantor  = String(row.kantor_wilayah || '').trim();
    const tahun   = parseInt(row.tahun, 10);
    const bulan   = String(row.bulan || '').trim();
    const usia    = String(row.kelompok_usia || '').trim().toUpperCase();
    const jumlah  = parseJumlah(row.jumlah);

    // Lewati baris yang tidak valid
    if (!kantor || isNaN(tahun) || !BULAN_ORDER[bulan] || isNaN(jumlah) || jumlah < 0) {
      skippedRows++;
      continue;
    }

    // Normalisasi kelompok usia: "DIATAS 70" → kunci standar
    const usiaKey = usia.replace(/\s+/g, ' ');

    allData.push({ kantor_wilayah: kantor, tahun, bulan, kelompok_usia: usiaKey, jumlah });
  }

  if (allData.length === 0) {
    showState('error', 'Tidak ada baris valid yang berhasil dibaca dari CSV.');
    return;
  }

  console.log(`CSV dimuat: ${allData.length} baris valid, ${skippedRows} baris dilewati.`);

  // Inisialisasi dashboard
  buildFilters();
  applyFilters(); // Render semua KPI + grafik + tabel dengan data penuh
  showState('dashboard');
}

// ===========================================================
// 2. VALIDASI & TAMPILAN STATE
// ===========================================================

function showState(state, message = '') {
  document.getElementById('loading-state').classList.toggle('hidden', state !== 'loading');
  document.getElementById('error-state').classList.toggle('hidden',   state !== 'error');
  document.getElementById('dashboard-content').classList.toggle('hidden', state !== 'dashboard');

  if (state === 'error') {
    document.getElementById('error-message').textContent = message;
  }
}

// ===========================================================
// 3. BANGUN FILTER
// ===========================================================

function buildFilters() {
  // Kumpulkan nilai unik
  const tahunSet  = new Set();
  const bulanSet  = new Set();
  const kanwilSet = new Set();
  const usiaSet   = new Set();

  for (const row of allData) {
    tahunSet.add(row.tahun);
    bulanSet.add(row.bulan);
    kanwilSet.add(row.kantor_wilayah);
    usiaSet.add(row.kelompok_usia);
  }

  // Tahun — urutan ascending
  const tahunSorted = [...tahunSet].sort((a, b) => a - b);
  fillSelect('filter-tahun', tahunSorted.map(String), v => v);

  // Bulan — urutan kronologis Januari → Desember
  const bulanSorted = [...bulanSet].sort((a, b) => (BULAN_ORDER[a] || 0) - (BULAN_ORDER[b] || 0));
  fillSelect('filter-bulan', bulanSorted, v => v);

  // Kantor Wilayah — urutan alfabet
  const kanwilSorted = [...kanwilSet].sort();
  fillSelect('filter-kanwil', kanwilSorted, v => v);

  // Kelompok Usia — urutan USIA_ORDER
  const usiaSorted = USIA_ORDER.filter(u => usiaSet.has(u));
  fillSelect('filter-usia', usiaSorted, v => USIA_LABEL[v] || v);

  // Event listeners
  ['filter-tahun', 'filter-bulan', 'filter-kanwil', 'filter-usia'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      currentPage = 1;
      applyFilters();
    });
  });

  document.getElementById('btn-reset').addEventListener('click', resetFilters);
}

/** Isi elemen <select> dengan opsi — pertahankan opsi "Semua" pertama */
function fillSelect(selectId, values, labelFn) {
  const sel = document.getElementById(selectId);
  // Simpan opsi "Semua"
  const semua = sel.options[0];
  sel.innerHTML = '';
  sel.appendChild(semua);

  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = labelFn(v);
    sel.appendChild(opt);
  }
}

/** Reset semua filter ke "Semua" */
function resetFilters() {
  ['filter-tahun', 'filter-bulan', 'filter-kanwil', 'filter-usia'].forEach(id => {
    document.getElementById(id).value = '';
  });
  currentPage = 1;
  applyFilters();
}

// ===========================================================
// 4. FILTER DATA
// ===========================================================

function getFilterValues() {
  return {
    tahun:  document.getElementById('filter-tahun').value,
    bulan:  document.getElementById('filter-bulan').value,
    kanwil: document.getElementById('filter-kanwil').value,
    usia:   document.getElementById('filter-usia').value
  };
}

function applyFilters() {
  const f = getFilterValues();

  filteredData = allData.filter(row => {
    if (f.tahun  && String(row.tahun)          !== f.tahun)  return false;
    if (f.bulan  && row.bulan                  !== f.bulan)  return false;
    if (f.kanwil && row.kantor_wilayah         !== f.kanwil) return false;
    if (f.usia   && row.kelompok_usia          !== f.usia)   return false;
    return true;
  });

  renderAll();
}

// ===========================================================
// 5. RENDER SEMUA KOMPONEN
// ===========================================================

function renderAll() {
  updatePeriodBadge();
  renderKPI();
  renderChartTren();
  renderChartKanwil();
  renderChartUsiaBar();
  renderChartUsiaDonut();
  renderTable();
}

// ===========================================================
// 5a. BADGE PERIODE
// ===========================================================

function updatePeriodBadge() {
  // Kumpulkan semua kombinasi tahun-bulan dari data yang terfilter
  const periods = new Set(filteredData.map(r => periodKey(r.tahun, r.bulan)));
  const sorted  = [...periods].sort();

  let label = '';
  if (sorted.length === 0) {
    label = 'Tidak ada data';
  } else if (sorted.length === 1) {
    // Ambil nama bulan dari baris yang cocok
    const r = filteredData.find(r => periodKey(r.tahun, r.bulan) === sorted[0]);
    label = r ? `${r.bulan} ${r.tahun}` : sorted[0];
  } else {
    const first = filteredData.find(r => periodKey(r.tahun, r.bulan) === sorted[0]);
    const last  = filteredData.find(r => periodKey(r.tahun, r.bulan) === sorted[sorted.length - 1]);
    label = `${first ? first.bulan + ' ' + first.tahun : sorted[0]} – ${last ? last.bulan + ' ' + last.tahun : sorted[sorted.length - 1]}`;
  }

  document.getElementById('period-badge').textContent = `Periode: ${label}`;
}

// ===========================================================
// 5b. KPI CARDS
// ===========================================================

function renderKPI() {
  if (filteredData.length === 0) {
    document.getElementById('kpi-total').textContent         = '0';
    document.getElementById('kpi-avg').textContent           = '0';
    document.getElementById('kpi-top-kanwil').textContent    = '—';
    document.getElementById('kpi-top-kanwil-val').textContent = '';
    document.getElementById('kpi-top-usia').textContent      = '—';
    document.getElementById('kpi-top-usia-val').textContent   = '';
    return;
  }

  // 1. Total Paspor Baru
  const total = filteredData.reduce((s, r) => s + r.jumlah, 0);
  document.getElementById('kpi-total').textContent = fmtAngka(total);

  // 2. Rata-rata per Bulan
  //    Hitung berdasarkan jumlah kombinasi (tahun, bulan) unik yang memiliki data
  const periodSet = new Set(filteredData.map(r => periodKey(r.tahun, r.bulan)));
  const avgPerBulan = periodSet.size > 0 ? Math.round(total / periodSet.size) : 0;
  document.getElementById('kpi-avg').textContent = fmtAngka(avgPerBulan);

  // 3. Kantor Wilayah Teratas
  const totalPerKanwil = aggregateBy(filteredData, 'kantor_wilayah');
  const topKanwilEntry = maxEntry(totalPerKanwil);
  document.getElementById('kpi-top-kanwil').textContent    = topKanwilEntry ? topKanwilEntry.key : '—';
  document.getElementById('kpi-top-kanwil-val').textContent = topKanwilEntry ? fmtAngka(topKanwilEntry.value) + ' paspor' : '';

  // 4. Kelompok Usia Teratas
  const totalPerUsia = aggregateBy(filteredData, 'kelompok_usia');
  const topUsiaEntry = maxEntry(totalPerUsia);
  document.getElementById('kpi-top-usia').textContent    = topUsiaEntry ? (USIA_LABEL[topUsiaEntry.key] || topUsiaEntry.key) : '—';
  document.getElementById('kpi-top-usia-val').textContent = topUsiaEntry ? fmtAngka(topUsiaEntry.value) + ' paspor' : '';
}

// ===========================================================
// 5c. TREN BULANAN
// ===========================================================

function renderChartTren() {
  // Agregasi total paspor per kombinasi (tahun, bulan)
  const mapTren = {};
  for (const row of filteredData) {
    const key = periodKey(row.tahun, row.bulan);
    mapTren[key] = (mapTren[key] || 0) + row.jumlah;
  }

  // Urutkan kronologis (key sudah dalam format "YYYY-MM" → sortir string sudah benar)
  const sortedKeys = Object.keys(mapTren).sort();

  // Buat labels "Jan 2025", "Feb 2025", dst.
  const labels = sortedKeys.map(key => {
    const [yyyy, mm] = key.split('-');
    const bulanNama  = Object.keys(BULAN_ORDER).find(b => BULAN_ORDER[b] === parseInt(mm, 10));
    return periodLabel(yyyy, bulanNama || '');
  });

  // Data — gunakan null untuk bulan yang tidak ada (agar Chart.js tampilkan celah)
  // Dalam kasus ini setiap key yang ada di sortedKeys memiliki data, jadi tidak ada null
  const data = sortedKeys.map(key => mapTren[key] ?? null);

  destroyChart('chartTren');

  const ctx = document.getElementById('chart-tren').getContext('2d');
  chartTren = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Total Paspor',
        data,
        borderColor:          COLOR_TREN,
        backgroundColor:      'rgba(29, 78, 216, 0.08)',
        borderWidth:          2.5,
        pointRadius:          4,
        pointHoverRadius:     6,
        pointBackgroundColor: COLOR_TREN,
        fill:                 true,
        tension:              0.35,
        // Span gaps — false agar celah ditampilkan jika ada bulan tanpa data
        spanGaps: false
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + fmtAngka(ctx.parsed.y) + ' paspor'
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 11 }, maxRotation: 45 },
          grid:  { display: false }
        },
        y: {
          ticks: {
            font: { size: 11 },
            callback: v => fmtAngka(v)
          },
          grid: { color: '#f0f0f0' }
        }
      }
    }
  });
}

// ===========================================================
// 5d. TOP 10 KANTOR WILAYAH — Polar Area Chart
// ===========================================================

function renderChartKanwil() {
  const totals = aggregateBy(filteredData, 'kantor_wilayah');
  // Urutkan descending, ambil 10 teratas (atau semua jika < 10)
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top    = sorted.slice(0, 10);

  const labels = top.map(([k]) => k);
  const data   = top.map(([, v]) => v);

  // Palet 10 warna konsisten dengan tema dashboard (biru → ungu → teal)
  // Urutan sesuai ranking: warna pertama (paling padat) untuk kantor teratas
  const POLAR_COLORS = [
    'rgba(29,  78, 216, 0.80)',   // #1d4ed8 — brand dark
    'rgba(37,  99, 235, 0.78)',   // #2563eb
    'rgba(59, 130, 246, 0.76)',   // #3b82f6 — brand light
    'rgba(96, 165, 250, 0.74)',   // #60a5fa
    'rgba(99, 102, 241, 0.72)',   // #6366f1 — indigo
    'rgba(129, 140, 248, 0.70)',  // #818cf8
    'rgba(139,  92, 246, 0.68)',  // #8b5cf6 — violet
    'rgba(167, 139, 250, 0.66)',  // #a78bfa
    'rgba(20, 184, 166, 0.65)',   // #14b8a6 — teal
    'rgba(45, 212, 191, 0.63)',   // #2dd4bf
  ];

  // Border: versi lebih pekat dari fill
  const POLAR_BORDERS = [
    '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa',
    '#6366f1', '#818cf8', '#8b5cf6', '#a78bfa',
    '#14b8a6', '#2dd4bf'
  ];

  // Potong palet sesuai jumlah kantor yang tampil
  const bgColors     = POLAR_COLORS.slice(0, top.length);
  const borderColors = POLAR_BORDERS.slice(0, top.length);

  destroyChart('chartKanwil');

  const ctx = document.getElementById('chart-kanwil').getContext('2d');
  chartKanwil = new Chart(ctx, {
    type: 'polarArea',
    data: {
      labels,
      datasets: [{
        label:           'Total Paspor',
        data,
        backgroundColor: bgColors,
        borderColor:     borderColors,
        borderWidth:     1.5
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      // Skala radial — format angka Indonesia di ticks
      scales: {
        r: {
          ticks: {
            font:      { size: 10 },
            color:     '#6b7280',
            backdropColor: 'transparent',
            callback:  v => fmtAngka(v)
          },
          grid:        { color: 'rgba(0,0,0,0.07)' },
          angleLines:  { color: 'rgba(0,0,0,0.07)' },
          pointLabels: { display: false }
        }
      },
      plugins: {
        // Legenda di bawah dengan label yang dipersingkat agar muat
        legend: {
          position: 'bottom',
          labels: {
            font:            { size: 10 },
            padding:         8,
            usePointStyle:   true,
            pointStyleWidth: 10,
            // Persingkat nama panjang: "KANTOR WILAYAH X" → "X"
            generateLabels: chart => {
              const ds = chart.data.datasets[0];
              return chart.data.labels.map((lbl, i) => {
                const short = lbl
                  .replace(/^KANTOR WILAYAH\s+/i, '')
                  .replace(/^KEMENTERIAN\s+/i, 'KEMENLU ');
                return {
                  text:            short,
                  fillStyle:       ds.backgroundColor[i],
                  strokeStyle:     ds.borderColor[i],
                  lineWidth:       1.5,
                  hidden:          false,
                  index:           i
                };
              });
            }
          }
        },
        tooltip: {
          callbacks: {
            // Tooltip menampilkan nama lengkap + jumlah
            title: items => items[0].label,
            label: ctx  => ' ' + fmtAngka(ctx.parsed.r) + ' paspor'
          }
        }
      }
    }
  });
}

// ===========================================================
// 5e. PASPOR PER KELOMPOK USIA (BAR)
// ===========================================================

function renderChartUsiaBar() {
  const totals = aggregateBy(filteredData, 'kelompok_usia');

  // Gunakan urutan tetap USIA_ORDER; tampilkan 0 untuk usia yang tidak ada data
  const labels = USIA_ORDER.map(u => USIA_LABEL[u] || u);
  const data   = USIA_ORDER.map(u => totals[u] || 0);

  destroyChart('chartUsiaBar');

  const ctx = document.getElementById('chart-usia-bar').getContext('2d');
  chartUsiaBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Paspor',
        data,
        backgroundColor: USIA_COLORS,
        borderRadius:    4,
        borderWidth:     0
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + fmtAngka(ctx.parsed.y) + ' paspor'
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 10 }, maxRotation: 30 },
          grid:  { display: false }
        },
        y: {
          ticks: {
            font: { size: 10 },
            callback: v => fmtAngka(v)
          },
          grid: { color: '#f0f0f0' }
        }
      }
    }
  });
}

// ===========================================================
// 5f. KOMPOSISI KELOMPOK USIA (DONAT)
// ===========================================================

function renderChartUsiaDonut() {
  const totals = aggregateBy(filteredData, 'kelompok_usia');
  const grandTotal = filteredData.reduce((s, r) => s + r.jumlah, 0);

  const labels = USIA_ORDER.map(u => USIA_LABEL[u] || u);
  const data   = USIA_ORDER.map(u => totals[u] || 0);

  destroyChart('chartUsiaDonut');

  const ctx = document.getElementById('chart-usia-donut').getContext('2d');
  chartUsiaDonut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: USIA_COLORS,
        borderWidth:     2,
        borderColor:     '#ffffff',
        hoverOffset:     8
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      cutout:              '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            font:        { size: 11 },
            padding:     10,
            usePointStyle: true,
            pointStyleWidth: 10
          }
        },
        tooltip: {
          callbacks: {
            // Tampilkan jumlah dan persentase terhadap total hasil filter
            label: ctx => {
              const val  = ctx.parsed;
              const pct  = grandTotal > 0 ? ((val / grandTotal) * 100).toFixed(1) : '0.0';
              return ` ${fmtAngka(val)} paspor (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

// ===========================================================
// 5g. TABEL RINCIAN + PAGINASI
// ===========================================================

function renderTable() {
  const tbody     = document.getElementById('table-body');
  const emptyDiv  = document.getElementById('table-empty');
  const tableWrap = document.getElementById('table-wrapper');
  const paginDiv  = document.getElementById('pagination');

  // Perbarui info jumlah baris & periode
  document.getElementById('table-row-count').textContent = `${fmtAngka(filteredData.length)} baris`;

  // Periode tabel (sama dengan badge)
  const periods  = new Set(filteredData.map(r => periodKey(r.tahun, r.bulan)));
  const sortedP  = [...periods].sort();
  let periodStr  = '—';
  if (sortedP.length === 1) {
    const r = filteredData.find(r => periodKey(r.tahun, r.bulan) === sortedP[0]);
    periodStr = r ? `${r.bulan} ${r.tahun}` : sortedP[0];
  } else if (sortedP.length > 1) {
    const fst = filteredData.find(r => periodKey(r.tahun, r.bulan) === sortedP[0]);
    const lst = filteredData.find(r => periodKey(r.tahun, r.bulan) === sortedP[sortedP.length - 1]);
    periodStr = `${fst ? fst.bulan + ' ' + fst.tahun : sortedP[0]} – ${lst ? lst.bulan + ' ' + lst.tahun : sortedP[sortedP.length - 1]}`;
  }
  document.getElementById('table-period-label').textContent = periodStr;

  if (filteredData.length === 0) {
    emptyDiv.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    paginDiv.classList.add('hidden');
    tbody.innerHTML = '';
    return;
  }

  emptyDiv.classList.add('hidden');
  tableWrap.classList.remove('hidden');
  paginDiv.classList.remove('hidden');

  // Pastikan halaman valid
  const totalPages = Math.ceil(filteredData.length / ROWS_PER_PAGE);
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1)         currentPage = 1;

  const start = (currentPage - 1) * ROWS_PER_PAGE;
  const end   = Math.min(start + ROWS_PER_PAGE, filteredData.length);
  const pageRows = filteredData.slice(start, end);

  // Render baris tabel
  tbody.innerHTML = pageRows.map((row, idx) => `
    <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors">
      <td class="px-4 py-2.5 text-gray-700">${row.kantor_wilayah}</td>
      <td class="px-4 py-2.5 text-center text-gray-600">${row.tahun}</td>
      <td class="px-4 py-2.5 text-gray-600">${row.bulan}</td>
      <td class="px-4 py-2.5 text-gray-600">${USIA_LABEL[row.kelompok_usia] || row.kelompok_usia}</td>
      <td class="px-4 py-2.5 text-right font-medium text-blue-700">${fmtAngka(row.jumlah)}</td>
    </tr>
  `).join('');

  // Info paginasi
  document.getElementById('pagination-info').textContent =
    `${fmtAngka(start + 1)} hingga ${fmtAngka(end)} dari ${fmtAngka(filteredData.length)} baris`;

  // Tombol navigasi
  document.getElementById('btn-first').disabled = currentPage <= 1;
  document.getElementById('btn-prev').disabled  = currentPage <= 1;
  document.getElementById('btn-next').disabled  = currentPage >= totalPages;
  document.getElementById('btn-last').disabled  = currentPage >= totalPages;

  document.getElementById('btn-first').onclick = () => goToPage(1);
  document.getElementById('btn-prev').onclick  = () => goToPage(currentPage - 1);
  document.getElementById('btn-next').onclick  = () => goToPage(currentPage + 1);
  document.getElementById('btn-last').onclick  = () => goToPage(totalPages);

  // Render nomor halaman (maks 5 tombol di sekitar halaman aktif)
  renderPageNumbers(totalPages);
}

function goToPage(page) {
  currentPage = page;
  renderTable();
  // Scroll ke atas tabel
  document.getElementById('table-wrapper').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPageNumbers(totalPages) {
  const container = document.getElementById('pagination-pages');
  container.innerHTML = '';

  // Hitung rentang halaman yang ditampilkan (maks 5)
  let startPage = Math.max(1, currentPage - 2);
  let endPage   = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  for (let p = startPage; p <= endPage; p++) {
    const btn = document.createElement('button');
    btn.className = 'pag-btn' + (p === currentPage ? ' active' : '');
    btn.textContent = p;
    btn.setAttribute('aria-label', `Halaman ${p}`);
    btn.setAttribute('aria-current', p === currentPage ? 'page' : '');
    btn.disabled = p === currentPage;
    btn.onclick  = () => goToPage(p);
    container.appendChild(btn);
  }
}

// ===========================================================
// UTILITAS AGREGASI
// ===========================================================

/**
 * Hitung total `jumlah` per nilai unik field yang diberikan.
 * Mengembalikan objek { [nilaiField]: total }
 */
function aggregateBy(data, field) {
  const result = {};
  for (const row of data) {
    const key = row[field];
    result[key] = (result[key] || 0) + row.jumlah;
  }
  return result;
}

/** Kembalikan { key, value } dengan value tertinggi dari objek agregasi */
function maxEntry(obj) {
  let maxKey   = null;
  let maxValue = -Infinity;
  for (const [k, v] of Object.entries(obj)) {
    if (v > maxValue) {
      maxValue = v;
      maxKey   = k;
    }
  }
  return maxKey !== null ? { key: maxKey, value: maxValue } : null;
}

/**
 * Hancurkan instance Chart.js berdasarkan nama variabel closure.
 * Menggunakan map ke closure variables agar referensi selalu sinkron.
 */
function destroyChart(varName) {
  const charts = {
    chartTren:      () => { if (chartTren      instanceof Chart) { chartTren.destroy();      chartTren      = null; } },
    chartKanwil:    () => { if (chartKanwil    instanceof Chart) { chartKanwil.destroy();    chartKanwil    = null; } },
    chartUsiaBar:   () => { if (chartUsiaBar   instanceof Chart) { chartUsiaBar.destroy();   chartUsiaBar   = null; } },
    chartUsiaDonut: () => { if (chartUsiaDonut instanceof Chart) { chartUsiaDonut.destroy(); chartUsiaDonut = null; } }
  };
  if (charts[varName]) charts[varName]();
}

// ===========================================================
// ENTRY POINT
// ===========================================================

// Mulai memuat CSV setelah halaman siap
document.addEventListener('DOMContentLoaded', loadCSV);
