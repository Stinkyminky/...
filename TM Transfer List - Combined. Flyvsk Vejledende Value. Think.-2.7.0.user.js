// ==UserScript==
// @name         TM Transfer List - Combined. Flyvsk Vejledende Value. Think.
// @namespace    http://tampermonkey.net/
// @version      2.7.0
// @description  Combined A+B. Removes TI(SB). Adds SI@.11 (projected to age xx.11, correct non-linear), TI_eff (TI if >0 else STI), sortable SI@.11 + Value, and GREEN cell-only highlights for ONLY the absolute best (Top N + min outlier cells). XP = routine. R5-only. OPTION B (moneyball) enabled. GK nerf 20%.
// @match        https://trophymanager.com/transfer*
// @match        https://www.trophymanager.com/transfer*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // =========================================================
  // CONFIG
  // =========================================================
  const HEAT = {
    enabled: true,

    // ✅ ONLY top N players by Value get any highlight
    onlyTopN: true,
    topN: 10,                  // <<<<<< change this (e.g. 3..10)
    topPct: 0.80,             // used only if onlyTopN=false

    // ✅ strict per-cell outlier threshold
    goodCellPct: 0.985,
    minOutlierCells: 3,

    alphaMin: 0.12,
    alphaMax: 0.28,

    xpHigherIsBetter: true,

    // ✅ GK is overpowered -> reduce Value ~20%
    gkValueMultiplier: 0.80,

    // =========================================================
    // VALUE MODE
    // 'A'  = balanced weighted-percentile average
    // 'B'  = moneyball: rating-dominant + brutal price penalty (makes "cheap elite rating" win big)
    // =========================================================
    valueMode: 'B',

    // ---- OPTION B tuning ----
    ratingShare: 0.86,          // 0..1  (how much of Quality is basically Rating)
    ratingPower: 3.4,           // higher => top rating explodes upward
    qualityPower: 1.15,         // mild shaping of non-rating quality
    pricePenaltyMin: 0.10,      // cheapest anchor
    pricePenaltyMax: 3.60,      // expensive anchor
    pricePenaltyPower: 5.8,     // ✅ main driver (4..7). Higher => price matters MUCH more.
    valueScale: 160,            // cosmetics

    // Base weights for the non-rating quality mix (Option B ignores rating+price weights)
    weights: {
      si11: 0.75,
      tiEff: 0.65,
      seasonTI: 0.15,  // internal key name; header is STI
      rating: 0.0,     // ignored in Option B
      rec: 0.55,
      siNow: 0.35,
      age: 0.25,       // lower is better (light)
      price: 0.0,      // ignored in Option B
      xp: 0.35
    },
  };

  // =========================================================
  // Core selectors / utilities
  // =========================================================
  const SEL = {
    ROOT: 'div#transfer_list',
    TABLE: 'div#transfer_list table',
    PLAYER_ROWS: 'div#transfer_list tr[id^=player_row]',
  };

  const norm = (s) => String(s ?? '').trim();
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  async function waitForSelector(selector, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(50);
    }
    return null;
  }

  function getTable() { return document.querySelector(SEL.TABLE); }

  function getHeaderRow() {
    const root = document.querySelector(SEL.ROOT);
    if (!root) return null;

    let hr = root.querySelector('tr.header');
    if (hr && hr.querySelectorAll('th').length) return hr;

    hr = root.querySelector('thead tr');
    if (hr && hr.querySelectorAll('th').length) return hr;

    const rows = Array.from(root.querySelectorAll('table tr'));
    const cand = rows.find(r => r.querySelectorAll && r.querySelectorAll('th').length);
    return cand || null;
  }

  function getPlayerRows() {
    return Array.from(document.querySelectorAll(SEL.PLAYER_ROWS)).filter(r => r && r.children && r.children.length);
  }
  function getPlayerId(row) { return row.id.split('_')[2]; }

  function colIndexByHeaderText(headerText) {
    const hr = getHeaderRow();
    if (!hr) return -1;
    const ths = Array.from(hr.querySelectorAll('th'));
    return ths.findIndex(th => norm(th.textContent) === headerText);
  }

  function findColIndexByAny(headers) {
    for (const h of headers) {
      const idx = colIndexByHeaderText(h);
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function renameHeader(oldText, newText) {
    const hr = getHeaderRow();
    if (!hr) return;
    const ths = Array.from(hr.querySelectorAll('th'));
    const th = ths.find(t => norm(t.textContent) === oldText);
    if (th) th.textContent = newText;
  }

  function ensureColumnAt(position, headerName, widthPx = 60) {
    const hr = getHeaderRow();
    if (!hr) return;

    if (Array.from(hr.querySelectorAll('th')).some(th => norm(th.textContent) === headerName)) return;

    const ths = hr.querySelectorAll('th');
    const th = document.createElement('th');
    th.style.width = `${widthPx}px`;
    th.textContent = headerName;

    if (ths.length > position) hr.insertBefore(th, ths[position]);
    else hr.appendChild(th);

    for (const row of getPlayerRows()) {
      const td = document.createElement('td');
      td.classList.add('align_center');
      td.textContent = '-';
      const tds = row.querySelectorAll('td');
      if (tds.length > position) row.insertBefore(td, tds[position]);
      else row.appendChild(td);
    }
  }

  function ensureTrailingColumns(headerNames, widthPx = 95) {
    const hr = getHeaderRow();
    if (!hr) return;

    const existing = new Set(Array.from(hr.querySelectorAll('th')).map(th => norm(th.textContent)));
    const toAdd = headerNames.filter(h => !existing.has(h));
    if (!toAdd.length) return;

    for (const name of toAdd) {
      const th = document.createElement('th');
      th.style.width = `${widthPx}px`;
      th.textContent = name;
      hr.appendChild(th);
    }
    for (const row of getPlayerRows()) {
      for (let i = 0; i < toAdd.length; i++) {
        const td = document.createElement('td');
        td.classList.add('align_center');
        td.textContent = '-';
        row.appendChild(td);
      }
    }
  }

  function setCellText(row, col, text) {
    if (!row || !row.children || col < 0) return;
    const cell = row.children[col];
    if (!cell) return;
    cell.textContent = text;
  }

  function makeSortableHeader(th, getColIndexFn, isNumeric = true) {
    if (th.dataset.sortHooked) return;
    th.dataset.sortHooked = '1';
    th.style.cursor = 'pointer';
    th.title = 'Click to sort';
    th.dataset.order = 'desc';

    th.addEventListener('click', () => {
      const table = getTable();
      if (!table) return;

      const colIndex = getColIndexFn();
      if (colIndex < 0) return;

      const rows = getPlayerRows();
      const order = th.dataset.order === 'asc' ? 1 : -1;
      th.dataset.order = (th.dataset.order === 'asc') ? 'desc' : 'asc';

      const parseNum = (t) => {
        let s = String(t ?? '').trim().replace(/\u00A0/g, ' ').replace(/\s/g, '');
        const m = s.match(/-?[\d][\d.,]*/);
        if (!m) return (order === 1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
        s = m[0];
        if (s.includes(',') && !s.includes('.')) s = s.replace(/,/g, '.');
        if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : (order === 1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
      };

      rows.sort((a, b) => {
        const av = a.children[colIndex]?.textContent ?? '';
        const bv = b.children[colIndex]?.textContent ?? '';
        if (isNumeric) return (parseNum(av) - parseNum(bv)) * order;
        return av.localeCompare(bv, undefined, { numeric: true }) * order;
      });

      const tbody = table.querySelector('tbody') || table;
      rows.forEach(r => tbody.appendChild(r));
    });
  }

  function parseIntLoose(v) {
    if (v == null) return NaN;
    const s = String(v);
    const m = s.match(/[\d][\d.,\s]*/);
    if (!m) return NaN;
    const digits = m[0].replace(/[^\d]/g, '');
    return digits ? Number(digits) : NaN;
  }

  function parseFloatLoose(v) {
    if (v == null) return NaN;
    let s = String(v).trim().replace(/\u00A0/g, ' ');
    const m = s.match(/-?[\d][\d.,]*/);
    if (!m) return NaN;
    s = m[0];
    if (s.includes(',') && !s.includes('.')) s = s.replace(/,/g, '.');
    if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function parseRoutineLoose(v) { return parseFloatLoose(v); }

  function parsePriceFromCell(cell) {
    const span = cell?.querySelector?.('span');
    const sort = span?.getAttribute?.('sort');
    if (sort && Number.isFinite(Number(sort))) return Number(sort);

    const t = norm(cell?.textContent ?? '');
    const m = t.match(/-?[\d][\d.,]*/);
    if (!m) return NaN;
    let x = m[0];
    if (x.includes(',') && !x.includes('.')) x = x.replace(/,/g, '.');
    if (x.includes(',') && x.includes('.')) x = x.replace(/,/g, '');
    let n = parseFloat(x);
    if (!Number.isFinite(n)) return NaN;

    if (/m/i.test(t)) n *= 1_000_000;
    else if (/k/i.test(t)) n *= 1_000;
    return n;
  }

  // =========================================================
  // Tooltip fetch (cached)
  // =========================================================
  const tooltipCache = new Map();

  function fetchTooltipPlayer(playerID) {
    if (tooltipCache.has(playerID)) return tooltipCache.get(playerID);

    const doJQ = () => new Promise((resolve, reject) => {
      $.post("/ajax/tooltip.ajax.php", { player_id: playerID })
        .done((data) => {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          resolve(parsed.player);
        })
        .fail(reject);
    });

    const doFetch = async () => {
      const body = new URLSearchParams();
      body.set('player_id', playerID);
      const res = await fetch('/ajax/tooltip.ajax.php', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        credentials: 'same-origin',
      });
      const text = await res.text();
      return JSON.parse(text).player;
    };

    const p = (window.$ && typeof $.post === 'function') ? doJQ() : doFetch();
    tooltipCache.set(playerID, Promise.resolve(p));
    return tooltipCache.get(playerID);
  }

  // =========================================================
  // Script A (TI/XP/STI)
  // =========================================================
  const A = {
    TI_HEADER: 'TI',
    XP_HEADER: 'XP',
    STI_HEADER: 'STI',

    TI_POS: 6,
    STI_POS: 7,
    XP_POS: 12,

    TI_PREC: 0,
    XP_PREC: 1,
    STI_PREC: 2,

    AGE_POS: 2,
  };

  const PositionNamesA = { GOALKEEPER_STRING: 'GK' };
  let wage_rate_A = 15.808;

  function seasonTI_A(player, SI, position) {
    const wage = parseIntLoose(player.wage);
    if (!Number.isFinite(wage)) return null;

    const today = new Date();
    const SS = new Date("07 10 2017 08:00:00 GMT");
    const training1 = new Date("07 10 2017 23:00:00 GMT");
    let day = (today.getTime() - training1.getTime()) / 1000 / 3600 / 24;
    while (day > 84 - 16 / 24) day -= 84;

    const session = Math.floor(day / 7) + 1;
    const ageMax = 20.1 + session / 12;
    const age = Number(player.age) + Number(player.months) / 12;

    let check = today.getTime() - SS.getTime();
    const season = 84 * 24 * 3600 * 1000;
    let count = 0;
    while (check > season) { check -= season; count++; }

    let weight = 263533760000;
    if (position === PositionNamesA.GOALKEEPER_STRING) weight = 48717927500;

    if (!(wage === 30000 || (Number(player.player_id) > 120359295 && count === 0))) {
      wage_rate_A = 15.808;
      let TI1 =
        Math.pow(2, Math.log(weight * SI) / Math.log(Math.pow(2, 7))) -
        Math.pow(2, Math.log(weight * wage / wage_rate_A) / Math.log(Math.pow(2, 7)));
      TI1 = Math.round(TI1 * 10);
      return (TI1 / session).toFixed(A.STI_PREC);
    }

    if (Number(player.player_id) > 124048574 && age < ageMax) {
      wage_rate_A = 23.75;
      const TI2 =
        Math.pow(2, Math.log(weight * SI) / Math.log(Math.pow(2, 7))) -
        Math.pow(2, Math.log(weight * wage / wage_rate_A) / Math.log(Math.pow(2, 7)));
      return (TI2 / session).toFixed(A.STI_PREC);
    }
    return null;
  }

  const TI_A = {
    compute(asiNew, asiOld, position) {
      const pow = Math.pow;
      if (position === PositionNamesA.GOALKEEPER_STRING) {
        return (pow(asiNew * pow(2, 9) * pow(5, 4) * pow(7, 7), 1 / 7) -
          pow(asiOld * pow(2, 9) * pow(5, 4) * pow(7, 7), 1 / 7)) / 14 * 11 * 10;
      }
      return (pow(asiNew * pow(2, 9) * pow(5, 4) * pow(7, 7), 1 / 7) -
        pow(asiOld * pow(2, 9) * pow(5, 4) * pow(7, 7), 1 / 7)) * 10;
    }
  };

  function getOldASIFromRow(row) {
    const asiCell = row.children?.[5];
    if (!asiCell) return null;

    const span = asiCell.querySelector('span');
    if (span && span.getAttribute('sort')) {
      const v = Number(String(span.getAttribute('sort')).replace(/,/g, ''));
      if (Number.isFinite(v)) return v;
    }

    const m = asiCell.textContent.match(/[\d][\d,\.]*/);
    return m ? Number(m[0].replace(/[^\d]/g, '')) : null;
  }

  // ✅ TI_eff: if TI > 0 -> TI else STI
  function effectiveTI(tiText, stiText) {
    const ti = parseFloatLoose(tiText);
    const sti = parseFloatLoose(stiText);
    if (Number.isFinite(ti) && ti > 0) return ti;
    return Number.isFinite(sti) ? sti : NaN;
  }

  // =========================================================
  // Script B (Rating/REC) — R5 ONLY (no R4 code anywhere)
  // =========================================================
  let weightR5 = [
    [0.41029304,0.18048062,0.56730138,1.06344654,1.02312672,0.40831256,0.58235457,0.12717479,0.05454137,0.09089830,0.42381693,0.04626272,0.02199046,0],
    [0.42126371,0.18293193,0.60567629,0.91904794,0.89070915,0.40038476,0.56146633,0.15053902,0.15955429,0.15682932,0.42109742,0.09460329,0.03589655,0],
    [0.23412419,0.32032289,0.62194779,0.63162534,0.63143081,0.45218831,0.47370658,0.55054737,0.17744915,0.39932519,0.26915814,0.16413124,0.07404301,0],
    [0.27276905,0.26814289,0.61104798,0.39865092,0.42862643,0.43582015,0.46617076,0.44931076,0.25175412,0.46446692,0.29986350,0.43843061,0.21494592,0],
    [0.25219260,0.25112993,0.56090649,0.18230261,0.18376490,0.45928749,0.53498118,0.59461481,0.09851189,0.61601950,0.31243959,0.65402884,0.29982016,0],
    [0.28155678,0.24090675,0.60680245,0.19068879,0.20018012,0.45148647,0.48230007,0.42982389,0.26268609,0.57933805,0.31712419,0.65824985,0.29885649,0],
    [0.22029884,0.29229690,0.63248227,0.09904394,0.10043602,0.47469498,0.52919791,0.77555880,0.10531819,0.71048302,0.27667115,0.56813972,0.21537826,0],
    [0.21151292,0.35804710,0.88688492,0.14391236,0.13769621,0.46586605,0.34446036,0.51377701,0.59723919,0.75126119,0.16550722,0.29966502,0.12417045,0],
    [0.35479780,0.14887553,0.43273380,0.00023928,0.00021111,0.46931131,0.57731335,0.41686333,0.05607604,0.62121195,0.45370457,1.03660702,0.43205492,0],
    [0.45462811,0.30278232,0.45462811,0.90925623,0.45462811,0.90925623,0.45462811,0.45462811,0.30278232,0.15139116,0.15139116]
  ];

  let weightRb = [
    [0.10493615,0.05208547,0.07934211,0.14448971,0.13159554,0.06553072,0.07778375,0.06669303,0.05158306,0.02753168,0.12055170,0.01350989,0.02549169,0.03887550],
    [0.07715535,0.04943315,0.11627229,0.11638685,0.12893778,0.07747251,0.06370799,0.03830611,0.10361093,0.06253997,0.09128094,0.01314110,0.02449199,0.03726305],
    [0.08219824,0.08668831,0.07434242,0.09661001,0.08894242,0.08998026,0.09281287,0.08868309,0.04753574,0.06042619,0.05396986,0.05059984,0.05660203,0.03060871],
    [0.06744248,0.06641401,0.09977251,0.08253749,0.09709316,0.09241026,0.08513703,0.06127851,0.10275520,0.07985941,0.04618960,0.03927270,0.05285911,0.02697852],
    [0.07304213,0.08174111,0.07248656,0.08482334,0.07078726,0.09568392,0.09464529,0.09580381,0.04746231,0.07093008,0.04595281,0.05955544,0.07161249,0.03547345],
    [0.06527363,0.06410270,0.09701305,0.07406706,0.08563595,0.09648566,0.08651209,0.06357183,0.10819222,0.07386495,0.03245554,0.05430668,0.06572005,0.03279859],
    [0.07842736,0.07744888,0.07201150,0.06734457,0.05002348,0.08350204,0.08207655,0.11181914,0.03756112,0.07486004,0.06533972,0.07457344,0.09781475,0.02719742],
    [0.06545375,0.06145378,0.10503536,0.06421508,0.07627526,0.09232981,0.07763931,0.07001035,0.11307331,0.07298351,0.04248486,0.06462713,0.07038293,0.02403557],
    [0.07738289,0.05022488,0.07790481,0.01356516,0.01038191,0.06495444,0.07721954,0.07701905,0.02680715,0.07759692,0.12701687,0.15378395,0.12808992,0.03805251],
    [0.07466384,0.07466384,0.07466384,0.14932769,0.10452938,0.14932769,0.10452938,0.10344411,0.07512610,0.04492581,0.04479831]
  ];

  let weightR = [
    [0.653962303361921,0.330014238020285,0.562994547223387,0.891800163983125,0.871069095865164,0.454514672470839,0.555697278549252,0.42777598627972,0.338218821750765,0.134348455965202,0.796916786677566,0.048831870932616,0.116363443378865,0.282347752982916],
    [0.565605120229193,0.430973382039533,0.917125432457378,0.815702528287723,0.99022325015212,0.547995876625372,0.522203232914265,0.309928898819518,0.837365352274204,0.483822472259513,0.656901420858592,0.137582588344562,0.163658117596413,0.303915447383549],
    [0.55838825558912,0.603683502357502,0.563792314670998,0.770425088563048,0.641965853834719,0.675495235675077,0.683863478201805,0.757342915150728,0.473070797767482,0.494107823556837,0.397547163237438,0.429660916538242,0.56364174077388,0.224791093448809],
    [0.582074038075056,0.420032202680124,0.7887541874616,0.726221389774063,0.722972329840151,0.737617252827595,0.62234458453736,0.466946909655194,0.814382915598981,0.561877829393632,0.367446981999576,0.360623408340649,0.390057769678583,0.249517737311268],
    [0.578431939417021,0.778134685048085,0.574726322388294,0.71400292078636,0.635403391007978,0.822308254446722,0.877857040588335,0.864265671245476,0.433450219618618,0.697164252367046,0.412568516841575,0.586627586272733,0.617905053049757,0.308426814834866],
    [0.497429376361348,0.545347364699553,0.788280917110089,0.578724574327427,0.663235306043286,0.772537143243647,0.638706135095199,0.538453108494387,0.887935381275257,0.572515970409641,0.290549550901104,0.476180499897665,0.526149424898544,0.287001645266184],
    [0.656437768926678,0.617260722143117,0.656569986958435,0.63741054520629,0.55148452726771,0.922379789905246,0.790553566121791,0.999688557334153,0.426203575603164,0.778770912265944,0.652374065121788,0.662264393455567,0.73120100926333,0.274563618133769],
    [0.483341947292063,0.494773052635464,0.799434804259974,0.628789194186491,0.633847969631333,0.681354437033551,0.671233869875345,0.536121458625519,0.849389745477645,0.684067723274814,0.389732973354501,0.499972692291964,0.577231818355874,0.272773352088982],
    [0.493917051093473,0.370423904816088,0.532148929996192,0.0629206658586336,0.0904950078155216,0.415494774080483,0.54106107545574,0.468181146095801,0.158106484131194,0.461125738338018,0.83399612271067,0.999828328674183,0.827171977606305,0.253225855459207],
    [0.5,0.333,0.5,1,0.5,1,0.5,0.5,0.333,0.333,0.333]
  ];

  const MP = Math.pow;
  const funFix2_B = (x) => (Math.round(x * 100) / 100).toFixed(2);

  const calculateRemainders = (positionIndex, skills, SI) => {
    let weight = 263533760000;
    if (positionIndex === 9) weight = 48717927500;

    let rec = 0;
    let ratingR = 0;
    let skillSum = 0;

    for (let i = 0; i < skills.length; i++) skillSum += parseInt(skills[i], 10);

    let remainder = Math.round((Math.pow(2, Math.log(weight * SI) / Math.log(Math.pow(2, 7))) - skillSum) * 10) / 10;
    let remainderWeight = 0;
    let remainderWeight2 = 0;
    let not20 = 0;

    weightR[positionIndex].forEach((_, index) => {
      rec += skills[index] * weightRb[positionIndex][index];
      ratingR += skills[index] * weightR5[positionIndex][index];
      if (skills[index] != 20) {
        remainderWeight += weightRb[positionIndex][index];
        remainderWeight2 += weightR5[positionIndex][index];
        not20++;
      }
    });

    if (remainder / not20 > 0.9 || !not20) {
      not20 = (positionIndex === 9) ? 11 : 14;
      remainderWeight = 1;
      remainderWeight2 = 5;
    }

    rec = funFix2_B((rec + remainder * remainderWeight / not20 - 2) / 3);
    return [remainder, Math.round(remainderWeight2), not20, ratingR, Number(rec)];
  };

  // R5-only full rating
  const calculateREREC = (positionIndex, skills, SI, rou) => {
    const rou2 = (3 / 100) * (100 - (100) * Math.pow(Math.E, -rou * 0.035));
    const rem = calculateRemainders(positionIndex, skills, SI);

    // build skillsB: distribute remainder across not-20 (with goldstar logic)
    let goldstar = 0;
    let skillsB = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < skills.length; i++) {
        if (j == 0 && skills[i] == 20) goldstar++;
        if (j == 1) {
          if (skills[i] != 20) skillsB[i] = skills[i] * 1 + rem[0] / (skills.length - goldstar);
          else skillsB[i] = skills[i];
        }
      }
    }

    // add routine boost
    let skillsB_rou = [];
    for (let i = 0; i < skills.length; i++) {
      if (i == 1) skillsB_rou[1] = skillsB[1];
      else skillsB_rou[i] = skillsB[i] * 1 + rou2;
    }

    let headerBonus = skillsB_rou[10] > 12
      ? funFix2_B((MP(Math.E, (skillsB_rou[10] - 10) ** 3 / 1584.77) - 1) * 0.8
        + MP(Math.E, (skillsB_rou[0] * skillsB_rou[0] * 0.007) / 8.73021) * 0.15
        + MP(Math.E, (skillsB_rou[6] * skillsB_rou[6] * 0.007) / 8.73021) * 0.05)
      : 0;

    let fkBonus = funFix2_B(MP(Math.E, MP(skillsB_rou[13] + skillsB_rou[12] + skillsB_rou[9] * 0.5, 2) * 0.002) / 327.92526);
    let ckBonus = funFix2_B(MP(Math.E, MP(skillsB_rou[13] + skillsB_rou[8] + skillsB_rou[9] * 0.5, 2) * 0.002) / 983.65770);
    let pkBonus = funFix2_B(MP(Math.E, MP(skillsB_rou[13] + skillsB_rou[11] + skillsB_rou[9] * 0.5, 2) * 0.002) / 1967.31409);

    let gainBase = funFix2_B((skillsB_rou[0] ** 2 + skillsB_rou[1] ** 2 * 0.5 + skillsB_rou[2] ** 2 * 0.5 + skillsB_rou[3] ** 2 + skillsB_rou[4] ** 2 + skillsB_rou[5] ** 2 + skillsB_rou[6] ** 2) / 6 / 22.9 ** 2);
    let keepBase = funFix2_B((skillsB_rou[0] ** 2 * 0.5 + skillsB_rou[1] ** 2 * 0.5 + skillsB_rou[2] ** 2 + skillsB_rou[3] ** 2 + skillsB_rou[4] ** 2 + skillsB_rou[5] ** 2 + skillsB_rou[6] ** 2) / 6 / 22.9 ** 2);

    let posGain = [gainBase * 0.3, gainBase * 0.3, gainBase * 0.9, gainBase * 0.6, gainBase * 1.5, gainBase * 0.9, gainBase * 0.9, gainBase * 0.6, gainBase * 0.3];
    let posKeep = [keepBase * 0.3, keepBase * 0.3, keepBase * 0.9, keepBase * 0.6, keepBase * 1.5, keepBase * 0.9, keepBase * 0.9, keepBase * 0.6, keepBase * 0.3];

    let allBonus = skills.length == 11 ? 0 : headerBonus * 1 + fkBonus * 1 + ckBonus * 1 + pkBonus * 1;

    // base rating part (R5)
    const remainderPiece = rem[0] * rem[1] / rem[2];
    let rating = Number(funFix2_B(rem[3] + remainderPiece + rou2 * 5));

    if (positionIndex === 9) {
      rating = Number(funFix2_B(rating + Number(allBonus)));
    } else {
      rating = Number(funFix2_B(rating + Number(allBonus) + Number(posGain[positionIndex]) + Number(posKeep[positionIndex])));
    }
    return rating;
  };

  const getPositionIndex_B = pos => {
    switch (pos) {
      case 'gk': return 9;
      case 'dc': return 0;
      case 'dr':
      case 'dl': return 1;
      case 'dmr':
      case 'dml': return 3;
      case 'dmc': return 2;
      case 'mr':
      case 'ml': return 5;
      case 'mc': return 4;
      case 'omr':
      case 'oml': return 7;
      case 'omc': return 6;
      case 'fc': return 8;
      default: return 0;
    }
  };

  function buildSkills_B(player, positionIndexForMapping) {
    if (!player || !Array.isArray(player.skills)) return [];
    const checkSkills = player.skills.filter(skill => skill && skill.value);

    let skills = [];
    if (positionIndexForMapping === 9) {
      skills = [
        checkSkills[0]?.value, checkSkills[2]?.value, checkSkills[4]?.value, checkSkills[1]?.value,
        checkSkills[3]?.value, checkSkills[5]?.value, checkSkills[6]?.value, checkSkills[7]?.value,
        checkSkills[8]?.value, checkSkills[9]?.value, checkSkills[10]?.value
      ].filter(v => v != null);
    } else {
      for (let i = 0; i <= checkSkills.length; i += 2) if (checkSkills[i]) skills.push(checkSkills[i].value);
      for (let i = 1; i <= checkSkills.length; i += 2) if (checkSkills[i]) skills.push(checkSkills[i].value);
    }

    skills.forEach((skill, idx) => {
      if (typeof skill === 'string') skills[idx] = skill.includes('silver') ? 19 : 20;
    });

    return skills;
  }

  // =========================================================
  // UI: Extra filters (R5-only; no R4 toggle)
  // =========================================================
  let posToCheck = -1;
  let minRating = 0;
  let minTI = null;
  let filtersInserted = false;

  function injectExtraFilterStyles() {
    if (document.getElementById('tm-extra-filters-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-extra-filters-style';
    style.textContent = `
      #filters .tmExtraFiltersBox{
        margin-top: 10px;
        padding: 10px 10px 12px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px;
        text-align: left !important;
      }
      #filters .tmExtraFiltersBox h3{
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: 700;
      }
      #filters .tmExtraFiltersBox label{
        font-weight: 600;
        display: block;
        margin: 8px 0 4px;
      }
      #filters .tmExtraFiltersBox select,
      #filters .tmExtraFiltersBox input{
        width: 100%;
        box-sizing: border-box;
        margin: 0;
      }
      #filters .tmExtraFiltersBox .btnRow{
        margin-top: 10px;
      }
      #filters .tmExtraFiltersBox button{
        width: 100%;
        padding: 6px 10px;
      }
    `;
    document.head.appendChild(style);
  }

  function addFiltersUIOnce() {
    if (filtersInserted) return;
    const filtersEl = document.getElementById('filters');
    if (!filtersEl) return;

    filtersInserted = true;
    injectExtraFilterStyles();

    const box = document.createElement('div');
    box.className = 'tmExtraFiltersBox';

    const title = document.createElement('h3');
    title.textContent = 'Extra Filters (Rating / TI) [R5]';
    box.appendChild(title);

    const inputPosEl = document.createElement('select');
    inputPosEl.classList.add('embossed');
    for (let i = -1; i <= 9; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent =
        i === -1 ? 'Default Position' :
          i === 0 ? 'DC' :
            i === 1 ? 'DR/L' :
              i === 2 ? 'DMC' :
                i === 3 ? 'DMR/L' :
                  i === 4 ? 'MC' :
                    i === 5 ? 'MR/L' :
                      i === 6 ? 'OMC' :
                        i === 7 ? 'OMR/L' :
                          i === 8 ? 'FC' : 'GK';
      inputPosEl.appendChild(opt);
    }
    const labPos = document.createElement('label');
    labPos.textContent = 'Select Position for Rating';
    box.append(labPos, inputPosEl);

    const inputMinR = document.createElement('input');
    inputMinR.type = 'number';
    inputMinR.classList.add('embossed');
    const labMinR = document.createElement('label');
    labMinR.textContent = 'Min Rating';
    box.append(labMinR, inputMinR);

    const inputMinTI = document.createElement('input');
    inputMinTI.type = 'number';
    inputMinTI.classList.add('embossed');
    const labMinTI = document.createElement('label');
    labMinTI.textContent = 'Min TI (TI if >0 else STI)';
    box.append(labMinTI, inputMinTI);

    const btnRow = document.createElement('div');
    btnRow.className = 'btnRow';
    const btn = document.createElement('button');
    btn.classList.add('button', 'button_icon');
    btn.textContent = 'Apply Extra Filter';
    btnRow.appendChild(btn);
    box.appendChild(btnRow);

    btn.addEventListener('click', () => {
      posToCheck = Number(inputPosEl.value);
      minRating = Number(inputMinR.value || 0);
      minTI = (inputMinTI.value === '' ? null : Number(inputMinTI.value));
      queueInit();
    });

    filtersEl.style.textAlign = 'left';
    filtersEl.appendChild(box);
  }

  // =========================================================
  // SI@.11 (CORRECT): project ASI to age xx.11 (non-linear)
  // sessionsLeft = 11 - months (23y5m => 6)
  // TI rule: if TI > 0 use TI else STI
  // =========================================================
  const ASI_C = (2 ** 9) * (5 ** 4) * (7 ** 7);

  function normMonths0to11(monthsRaw) {
    let m = parseIntLoose(monthsRaw);
    if (!Number.isFinite(m)) m = 0;
    m = Math.floor(m);
    if (m < 0) m = 0;
    if (m > 11) m = 11;
    return m;
  }

  function sessionsLeftToDot11(monthsRaw) {
    const m = normMonths0to11(monthsRaw);
    return 11 - m;
  }

  function projectASIWithTIUnits(currentASI, tiPerSession, sessions, fp) {
    if (!Number.isFinite(currentASI)) return NaN;
    if (!Number.isFinite(tiPerSession)) return Math.round(currentASI);
    if (!Number.isFinite(sessions) || sessions <= 0) return Math.round(currentASI);

    const isGK = (fp === PositionNamesA.GOALKEEPER_STRING);

    // outfield: TI = (rootNew - rootOld) * 10  => root step = TI/10
    // GK:       TI = (rootNew - rootOld) /14*11*10 => root step = TI * 14 / (11*10)
    const rootStep = isGK ? (tiPerSession * 14 / (11 * 10)) : (tiPerSession / 10);

    const rootNow = Math.pow(currentASI * ASI_C, 1 / 7);
    const rootFuture = rootNow + rootStep * sessions;
    const asiFuture = Math.pow(rootFuture, 7) / ASI_C;
    return Math.round(asiFuture);
  }

  function projectSIToDot11(currentASI, tiPerSession, monthsRaw, fp) {
    const left = sessionsLeftToDot11(monthsRaw);
    return projectASIWithTIUnits(currentASI, tiPerSession, left, fp);
  }

  // =========================================================
  // Formatting helpers
  // =========================================================
  function tryFormatPriceCell(row) {
    const priceCol = findColIndexByAny(['Price', 'Pris']);
    if (priceCol < 0) return;

    const cell = row.children[priceCol];
    if (!cell) return;
    const span = cell.querySelector('span');
    if (!span) return;

    const sort = span.getAttribute('sort');
    if (!sort) return;

    let price = Number(sort);
    if (!Number.isFinite(price)) return;
    price = (Math.round(price / 1000 / 100) / 10) + 'M';

    cell.textContent = price;
    cell.classList.remove('align_right');
    cell.classList.add('align_center');
  }

  function tryCenterTimeCell(row) {
    let timeCol = findColIndexByAny(['Time', 'Time Left', 'Tid', 'Tid tilbage']);
    if (timeCol < 0) return;
    const cell = row.children[timeCol];
    if (cell) cell.style.textAlign = 'center';
  }

  // =========================================================
  // Heatmap styles + helpers (green only)
  // =========================================================
  function injectHeatmapStyles() {
    if (document.getElementById('tm-heatmap-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-heatmap-style';
    style.textContent = `
      #transfer_list td.tmHeatGood { box-shadow: inset 0 -2px 0 rgba(40,180,99,0.65) !important; }
    `;
    document.head.appendChild(style);
  }

  function clearCellHeat(row) {
    if (!row?.children) return;
    for (const td of Array.from(row.children)) {
      td.classList.remove('tmHeatGood');
      td.style.backgroundColor = '';
      td.style.boxShadow = '';
    }
  }

  function alphaFromIntensity(intensity) {
    const t = clamp01(intensity);
    return HEAT.alphaMin + t * (HEAT.alphaMax - HEAT.alphaMin);
  }

  function paintCell(td, intensity) {
    if (!td) return;
    const a = alphaFromIntensity(intensity);
    td.classList.add('tmHeatGood');
    td.style.backgroundColor = `rgba(40,180,99,${a})`;
    td.style.boxShadow = 'inset 0 -2px 0 rgba(40,180,99,0.65)';
  }

  function binarySearchRight(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function percentile(sortedArr, x) {
    if (!sortedArr.length) return NaN;
    const idx = binarySearchRight(sortedArr, x);
    return idx / sortedArr.length; // 0..1
  }

  // Age bias: t=0 ~ 19y, t=1 ~ 27y
  function ageBiasT(age) { return clamp01((age - 19) / 8); }

  function ageWeightMultiplier(metric, age) {
    const t = ageBiasT(age);
    switch (metric) {
      case 'si11':     return lerp(1.35, 0.75, t);
      case 'tiEff':    return lerp(1.25, 0.85, t);
      case 'seasonTI': return lerp(1.15, 0.85, t);
      case 'rec':      return lerp(0.95, 1.20, t);
      case 'xp':       return lerp(0.90, 1.15, t);
      case 'price':    return lerp(1.10, 1.35, t);
      case 'age':      return lerp(1.10, 1.45, t);
      case 'siNow':    return lerp(0.95, 1.05, t);
      default:         return 1.0;
    }
  }

  function computeValueAndHeatmap() {
    if (!HEAT.enabled) return;

    const rows = getPlayerRows().filter(r => r.style.display !== 'none');
    if (!rows.length) return;

    const metricsRows = rows
      .map(r => ({ row: r, m: r.__tmMetrics }))
      .filter(x => x.m && typeof x.m === 'object');

    if (!metricsRows.length) return;

    // Distributions
    const dist = {
      age: [], siNow: [], ti: [], seasonTI: [], tiEff: [],
      price: [], xp: [], rating: [], rec: [], si11: [], value: []
    };

    for (const { m } of metricsRows) {
      if (Number.isFinite(m.age)) dist.age.push(m.age);
      if (Number.isFinite(m.siNow)) dist.siNow.push(m.siNow);
      if (Number.isFinite(m.ti)) dist.ti.push(m.ti);
      if (Number.isFinite(m.seasonTI)) dist.seasonTI.push(m.seasonTI);
      if (Number.isFinite(m.tiEff)) dist.tiEff.push(m.tiEff);
      if (Number.isFinite(m.price)) dist.price.push(m.price);
      if (Number.isFinite(m.xp)) dist.xp.push(m.xp);
      if (Number.isFinite(m.rating)) dist.rating.push(m.rating);
      if (Number.isFinite(m.rec)) dist.rec.push(m.rec);
      if (Number.isFinite(m.si11)) dist.si11.push(m.si11);
    }

    for (const k of Object.keys(dist)) dist[k].sort((a, b) => a - b);

    const lowerBetter = new Set(['age', 'price']);

    function normScore(key, v) {
      if (!Number.isFinite(v) || !dist[key].length) return null;
      const p = percentile(dist[key], v);
      const nb = lowerBetter.has(key) ? (1 - p) : p;
      return { p, nb };
    }

    const W = HEAT.weights;

    // Compute Value
    for (const item of metricsRows) {
      const m = item.m;

      // ---- Non-rating quality mix ----
      const si11v = Number.isFinite(m.si11) ? m.si11 : m.siNow;

      const parts = [
        ['si11', si11v, 'si11'],
        ['tiEff', m.tiEff, 'tiEff'],
        ['seasonTI', m.seasonTI, 'seasonTI'],
        ['rec', m.rec, 'rec'],
        ['siNow', m.siNow, 'siNow'],
        ['age', m.age, 'age'],
        ['xp', m.xp, 'xp'],
      ];

      let sumW = 0;
      let sum = 0;

      for (const [wKey, val, distKey] of parts) {
        const baseW = W[wKey] ?? 0;
        if (baseW <= 0) continue;

        const mult = ageWeightMultiplier(wKey, m.age);
        const wEff = baseW * mult;

        const n = normScore(distKey, val);
        if (!n) continue;

        sum += wEff * n.nb;
        sumW += wEff;
      }

      const quality01 = (sumW > 0) ? (sum / sumW) : NaN;

      // Rating and Price percentiles
      const rN = normScore('rating', m.rating);
      const ratingNb = rN ? clamp01(rN.nb) : 0.5;

      const pN = normScore('price', m.price);
      const priceP = pN ? clamp01(pN.p) : 0.5; // 0 cheap -> 1 expensive

      let value = NaN;

      if (Number.isFinite(quality01)) {
        if (HEAT.valueMode === 'B') {
          // ✅ OPTION B: rating-dominant + brutal non-linear price penalty
          const nonRatingQ = clamp01(Math.pow(quality01, HEAT.qualityPower));
          const ratingQ = clamp01(Math.pow(ratingNb, HEAT.ratingPower));

          const mix = clamp01((1 - HEAT.ratingShare) * nonRatingQ + HEAT.ratingShare * ratingQ);

          const basePenalty = lerp(HEAT.pricePenaltyMin, HEAT.pricePenaltyMax, priceP);
          const penalty = Math.pow(basePenalty, HEAT.pricePenaltyPower);

          value = HEAT.valueScale * mix / penalty;
        } else {
          // OPTION A fallback (old-style)
          value = 100 * quality01;
        }
      }

      if (Number.isFinite(value) && m.isGK) value *= HEAT.gkValueMultiplier;

      m.value = value;
      if (Number.isFinite(value)) dist.value.push(value);
    }

    dist.value.sort((a, b) => a - b);

    // Elite cutoff (Top N by Value)
    let eliteCutoff = NaN;
    if (HEAT.onlyTopN && dist.value.length) {
      const desc = dist.value.slice().sort((a, b) => b - a);
      eliteCutoff = desc[Math.min(Math.max(HEAT.topN - 1, 0), desc.length - 1)];
    }

    // Column indices (with fallbacks)
    const idx = {
      age: findColIndexByAny(['Age', 'Alder']),
      siNow: findColIndexByAny(['ASI', 'SI']),
      ti: colIndexByHeaderText('TI'),
      seasonTI: findColIndexByAny(['STI', 'SeasonTI']),
      price: findColIndexByAny(['Price', 'Pris']),
      xp: colIndexByHeaderText('XP'),
      rating: colIndexByHeaderText('Rating'),
      rec: colIndexByHeaderText('REC'),
      si11: colIndexByHeaderText('SI@.11'),
      value: colIndexByHeaderText('Value'),
    };
    if (idx.age < 0) idx.age = A.AGE_POS;
    if (idx.siNow < 0) idx.siNow = 5;

    // Apply
    for (const { row, m } of metricsRows) {
      clearCellHeat(row);

      // Write Value cell
      if (idx.value >= 0) row.children[idx.value].textContent = Number.isFinite(m.value) ? m.value.toFixed(1) : '-';

      if (!Number.isFinite(m.value) || !dist.value.length) continue;

      // Elite selection
      let isElite = false;
      if (HEAT.onlyTopN) {
        isElite = Number.isFinite(eliteCutoff) && m.value >= eliteCutoff;
      } else {
        const vPct = percentile(dist.value, m.value);
        isElite = vPct >= HEAT.topPct;
      }
      if (!isElite) continue;

      let outlierCount = 0;
      const hits = [];

      function considerCell(distKey, val, higherBetter, colIdx) {
        if (colIdx == null || colIdx < 0) return;
        if (!Number.isFinite(val) || !dist[distKey].length) return;

        const p = percentile(dist[distKey], val);

        const ok = higherBetter ? (p >= HEAT.goodCellPct) : (p <= (1 - HEAT.goodCellPct));
        if (!ok) return;

        outlierCount++;

        const intensity = higherBetter
          ? (p - HEAT.goodCellPct) / (1 - HEAT.goodCellPct)
          : ((1 - HEAT.goodCellPct) - p) / (1 - HEAT.goodCellPct);

        hits.push({ colIdx, intensity: clamp01(intensity) });
      }

      // Cells to consider
      considerCell('siNow', m.siNow, true, idx.siNow);
      considerCell('age', m.age, false, idx.age);

      if (Number.isFinite(m.ti) && m.ti > 0) considerCell('ti', m.ti, true, idx.ti);
      else considerCell('seasonTI', m.seasonTI, true, idx.seasonTI);

      considerCell('price', m.price, false, idx.price);
      considerCell('xp', m.xp, HEAT.xpHigherIsBetter, idx.xp);
      considerCell('rating', m.rating, true, idx.rating);
      considerCell('rec', m.rec, true, idx.rec);
      considerCell('si11', m.si11, true, idx.si11);

      if (outlierCount >= HEAT.minOutlierCells) {
        for (const h of hits) paintCell(row.children[h.colIdx], h.intensity);
        if (idx.value >= 0) paintCell(row.children[idx.value], 0.25);
      }
    }
  }

  // =========================================================
  // Columns / sorting
  // =========================================================
  const COL = {
    RATING: 'Rating',
    REC: 'REC',
    SI11: 'SI@.11',
    VALUE: 'Value',
  };

  function buildColumnsAndSorting() {
    // rename if it exists
    renameHeader('SeasonTI', A.STI_HEADER);

    ensureColumnAt(A.TI_POS, A.TI_HEADER, 60);
    ensureColumnAt(A.XP_POS, A.XP_HEADER, 60);
    ensureColumnAt(A.STI_POS, A.STI_HEADER, 70);

    ensureTrailingColumns([COL.RATING, COL.REC, COL.SI11, COL.VALUE], 110);

    const hr = getHeaderRow();
    if (!hr) return;

    const ths = Array.from(hr.querySelectorAll('th'));

    const tiTh = ths.find(th => norm(th.textContent) === A.TI_HEADER);
    const xpTh = ths.find(th => norm(th.textContent) === A.XP_HEADER);
    const sTiTh = ths.find(th => norm(th.textContent) === A.STI_HEADER);

    if (tiTh) makeSortableHeader(tiTh, () => colIndexByHeaderText(A.TI_HEADER), true);
    if (xpTh) makeSortableHeader(xpTh, () => colIndexByHeaderText(A.XP_HEADER), true);
    if (sTiTh) makeSortableHeader(sTiTh, () => findColIndexByAny([A.STI_HEADER, 'SeasonTI']), true);

    const ratingTh = ths.find(th => norm(th.textContent) === COL.RATING);
    const recTh = ths.find(th => norm(th.textContent) === COL.REC);
    const si11Th = ths.find(th => norm(th.textContent) === COL.SI11);
    const valueTh = ths.find(th => norm(th.textContent) === COL.VALUE);

    if (ratingTh) makeSortableHeader(ratingTh, () => colIndexByHeaderText(COL.RATING), true);
    if (recTh) makeSortableHeader(recTh, () => colIndexByHeaderText(COL.REC), true);
    if (si11Th) makeSortableHeader(si11Th, () => colIndexByHeaderText(COL.SI11), true);
    if (valueTh) makeSortableHeader(valueTh, () => colIndexByHeaderText(COL.VALUE), true);

    // layout tweaks
    [...document.querySelectorAll('.main_center')].forEach(el => { el.style.width = '1210px'; });
    const c1 = document.querySelectorAll('.column1_d')[0];
    if (c1) c1.style.width = '1200px';
    const outer = document.querySelectorAll('.transfer_list_outer')[0];
    if (outer) outer.style.width = '936px';
  }

  // =========================================================
  // Per-row update
  // =========================================================
  async function updateRowCombined(row) {
    const playerID = getPlayerId(row);

    try {
      const p = await fetchTooltipPlayer(playerID);

      const ASI = parseIntLoose(p.skill_index);
      const rou = parseRoutineLoose(p.routine); // XP = routine
      const fp = p.fp;
      const isGK = (fp === PositionNamesA.GOALKEEPER_STRING);

      // Age display
      setCellText(row, A.AGE_POS, `${p.age}.${p.months}`);

      // Price numeric (capture BEFORE formatting)
      const priceCol = findColIndexByAny(['Price', 'Pris']);
      const priceVal = (priceCol >= 0) ? parsePriceFromCell(row.children[priceCol]) : NaN;

      // TI
      const oldASI = getOldASIFromRow(row);
      const tiA = (Number.isFinite(ASI) && oldASI != null)
        ? TI_A.compute(ASI, oldASI, fp)
        : NaN;

      const tiAText = Number.isFinite(tiA) ? tiA.toFixed(A.TI_PREC) : '-';

      const xpText = Number.isFinite(rou)
        ? rou.toFixed(A.XP_PREC).replace('.', ',')
        : '-';

      const stiText = (Number.isFinite(ASI))
        ? (seasonTI_A({ wage: p.wage, age: p.age, months: p.months, player_id: p.player_id }, ASI, fp) || '-')
        : '-';

      setCellText(row, colIndexByHeaderText(A.TI_HEADER), tiAText);
      setCellText(row, colIndexByHeaderText(A.XP_HEADER), xpText);
      setCellText(row, findColIndexByAny([A.STI_HEADER, 'SeasonTI']), stiText);

      const tiEff = effectiveTI(tiAText, stiText);

      // Rating/REC (R5-only)
      const positions = String(p.favposition || '').split(',').map(s => s.trim()).filter(Boolean);
      const posList = positions.length ? positions : ['dc'];

      const ratings = [];
      const recs = [];

      for (const pos of posList) {
        const basePosIndex = getPositionIndex_B(pos);
        const chosenPosIndex = (posToCheck > -1) ? posToCheck : basePosIndex;

        const skills = buildSkills_B(p, basePosIndex);
        if (!skills.length || !Number.isFinite(ASI) || !Number.isFinite(rou)) continue;

        const ratingVal = calculateREREC(chosenPosIndex, skills, ASI, rou);
        ratings.push(ratingVal);

        const recVal = calculateRemainders(chosenPosIndex, skills, ASI)[4];
        recs.push(recVal);
      }

      const ratingText = ratings.length ? ratings.join(' - ') : '-';
      const recText = recs.length ? recs.join(' - ') : '-';

      setCellText(row, colIndexByHeaderText(COL.RATING), ratingText);
      setCellText(row, colIndexByHeaderText(COL.REC), recText);

      // SI@.11 projection (TI > 0 else STI), NON-LINEAR
      const stiNum = parseFloatLoose(stiText);
      const tiForSI11 =
        (Number.isFinite(tiA) && tiA > 0) ? tiA :
        (Number.isFinite(stiNum) ? stiNum : NaN);

      const si11 = projectSIToDot11(ASI, tiForSI11, p.months, fp);
      setCellText(row, colIndexByHeaderText(COL.SI11), Number.isFinite(si11) ? String(si11) : '-');

      // Filter logic
      let show = true;

      if (minRating && minRating > 0) {
        show = ratings.some(r => Number(r) >= Number(minRating));
      }
      if (show && minTI != null) {
        show = Number.isFinite(tiEff) && tiEff >= Number(minTI);
      }
      row.style.display = show ? 'table-row' : 'none';

      // Formatting
      tryFormatPriceCell(row);
      tryCenterTimeCell(row);

      // Store metrics for Value/heatmap
      const ageNum = Number(p.age) + Number(normMonths0to11(p.months)) / 12;
      const ratingMax = ratings.length ? Math.max(...ratings.filter(Number.isFinite)) : NaN;
      const recMax = recs.length ? Math.max(...recs.filter(Number.isFinite)) : NaN;

      row.__tmMetrics = {
        isGK,
        age: Number.isFinite(ageNum) ? ageNum : NaN,
        siNow: Number.isFinite(ASI) ? ASI : NaN,
        ti: (Number.isFinite(tiA) ? tiA : NaN),
        seasonTI: parseFloatLoose(stiText),
        tiEff: Number.isFinite(tiEff) ? tiEff : NaN,
        price: Number.isFinite(priceVal) ? priceVal : NaN,
        xp: Number.isFinite(rou) ? rou : NaN,
        rating: Number.isFinite(ratingMax) ? ratingMax : NaN,
        rec: Number.isFinite(recMax) ? recMax : NaN,
        si11: Number.isFinite(si11) ? si11 : NaN,
        value: NaN
      };

    } catch (e) {
      setCellText(row, colIndexByHeaderText(A.TI_HEADER), 'Err');
      setCellText(row, colIndexByHeaderText(A.XP_HEADER), 'Err');
      setCellText(row, findColIndexByAny([A.STI_HEADER, 'SeasonTI']), 'Err');
      setCellText(row, colIndexByHeaderText(COL.RATING), 'Err');
      setCellText(row, colIndexByHeaderText(COL.REC), 'Err');
      setCellText(row, colIndexByHeaderText(COL.SI11), 'Err');
    }
  }

  // =========================================================
  // Observer loop protection + debounce
  // =========================================================
  let observer = null;
  let initQueued = false;
  let initRunning = false;

  function queueInit() {
    if (initQueued) return;
    initQueued = true;
    requestAnimationFrame(() => {
      initQueued = false;
      initAll();
    });
  }

  async function initAll() {
    if (initRunning) return;
    const table = getTable();
    if (!table) return;

    initRunning = true;
    if (observer) observer.disconnect();

    try {
      injectHeatmapStyles();
      addFiltersUIOnce();
      buildColumnsAndSorting();

      const rows = getPlayerRows();
      await Promise.all(rows.map(r => updateRowCombined(r)));

      computeValueAndHeatmap();
    } finally {
      const root = document.querySelector(SEL.ROOT);
      if (root && observer) observer.observe(root, { childList: true, subtree: true });
      initRunning = false;
    }
  }

  // =========================================================
  // Boot (robust for SPA)
  // =========================================================
  (async function boot() {
    const root = await waitForSelector(SEL.ROOT, 30000);
    if (!root) return;

    observer = new MutationObserver(() => queueInit());
    observer.observe(root, { childList: true, subtree: true });

    queueInit();
  })();
})();
