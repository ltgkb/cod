'use strict';
/* ============================================================
 *  2048 — game logic
 *  Pure vanilla JS. No dependencies.
 * ============================================================ */

(function () {
  // ---- Config ----------------------------------------------------------
  var SIZE = 4;
  var WIN_VALUE = 2048;
  var ANIM_MS = 130; // tile slide duration (matches CSS transition)

  // ---- DOM refs --------------------------------------------------------
  var boardEl = document.getElementById('board');
  var gridEl = document.getElementById('grid');
  var tilesEl = document.getElementById('tiles');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var newGameBtn = document.getElementById('newGame');
  var keepGoingBtn = document.getElementById('keepGoing');
  var winNewGameBtn = document.getElementById('winNewGame');
  var overNewGameBtn = document.getElementById('overNewGame');
  var winOverlay = document.getElementById('winOverlay');
  var overOverlay = document.getElementById('overOverlay');

  // ---- State -----------------------------------------------------------
  var grid = [];       // 2-D array of cell objects (or null), SIZE x SIZE
  var tileMap = {};    // id -> tile DOM element  (so we can remove/reuse)
  var score = 0;
  var best = 0;
  var nextId = 1;
  var won = false;
  var keepPlaying = false;
  var busy = false;    // locks input during slide animation

  // ---- Persistence -----------------------------------------------------
  function loadBest() {
    try {
      var v = localStorage.getItem('best2048');
      best = v ? parseInt(v, 10) || 0 : 0;
    } catch (e) {
      best = 0;
    }
    bestEl.textContent = best;
  }

  function saveBest() {
    try { localStorage.setItem('best2048', String(best)); } catch (e) { /* ignore */ }
  }

  // ---- Setup -----------------------------------------------------------
  function buildGridCells() {
    gridEl.innerHTML = '';
    var f = document.createDocumentFragment();
    for (var i = 0; i < SIZE * SIZE; i++) {
      var c = document.createElement('div');
      c.className = 'grid-cell';
      f.appendChild(c);
    }
    gridEl.appendChild(f);
  }

  function emptyGrid() {
    grid = [];
    for (var r = 0; r < SIZE; r++) {
      var row = [];
      for (var c = 0; c < SIZE; c++) row.push(null);
      grid.push(row);
    }
  }

  function newCell(r, c, value) {
    return { id: nextId++, row: r, col: c, value: value, isNew: true, merged: false };
  }

  function clearTileDom() {
    tilesEl.innerHTML = '';
    tileMap = {};
  }

  function measureGap() {
    var gap = parseFloat(getComputedStyle(boardEl).paddingLeft) || 10;
    var inner = boardEl.clientWidth - gap * 2;
    var cell = (inner - gap * (SIZE - 1)) / SIZE;
    return { gap: gap, cell: cell, board: inner };
  }

  // ---- Random spawn ----------------------------------------------------
  function emptyCells() {
    var out = [];
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (!grid[r][c]) out.push({ row: r, col: c });
    return out;
  }

  function spawn() {
    var cells = emptyCells();
    if (!cells.length) return null;
    var pick = cells[Math.floor(Math.random() * cells.length)];
    var val = Math.random() < 0.9 ? 2 : 4;
    grid[pick.row][pick.col] = newCell(pick.row, pick.col, val);
    return grid[pick.row][pick.col];
  }

  // ---- Rendering -------------------------------------------------------
  function render(spawnedCell) {
    var m = measureGap();
    var tileSize = m.cell;
    var step = m.cell + m.gap;

    boardEl.style.setProperty('--tile-size', tileSize + 'px');
    boardEl.style.setProperty('--gap', m.gap + 'px');

    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var cell = grid[r][c];
        if (!cell) continue;

        var el = tileMap[cell.id];
        if (!el) {
          el = document.createElement('div');
          el.className = 'tile';
          tilesEl.appendChild(el);
          tileMap[cell.id] = el;
          // place at target instantly (no transition on first paint)
          el.style.transform = 'translate(' + (c * step) + 'px,' + (r * step) + 'px)';
          el.textContent = cell.value;
          el.setAttribute('data-v', cell.value);
          if (cell.isNew) {
            el.classList.add('is-new');
            window.setTimeout(function (n) { n.classList.remove('is-new'); }, 200, el);
          }
        } else {
          // Animate slide
          el.style.transform = 'translate(' + (c * step) + 'px,' + (r * step) + 'px)';
          if (cell.value !== parseInt(el.getAttribute('data-v'), 10)) {
            el.textContent = cell.value;
            el.setAttribute('data-v', cell.value);
            if (cell.merged) {
              el.classList.add('is-merged');
              window.setTimeout(function (n) { n.classList.remove('is-merged'); }, 220, el);
            }
          }
        }
      }
    }

    // After transition, remove stale tiles that were merged away
    window.setTimeout(reapStaleTiles, ANIM_MS + 20);
  }

  function reapStaleTiles() {
    var aliveIds = {};
    for (var r = 0; r < SIZE; r++)
      for (var c = 0; c < SIZE; c++)
        if (grid[r][c]) aliveIds[grid[r][c].id] = true;

    for (var id in tileMap) {
      if (!aliveIds[id]) {
        if (tileMap[id].parentNode) tileMap[id].parentNode.removeChild(tileMap[id]);
        delete tileMap[id];
      }
    }
  }

  function updateScore(added) {
    score += added;
    scoreEl.textContent = score;
    if (score > best) {
      best = score;
      bestEl.textContent = best;
      saveBest();
    }
    if (added > 0) {
      scoreEl.classList.remove('bump');
      void scoreEl.offsetWidth; // restart animation
      scoreEl.classList.add('bump');
    }
  }

  // ---- Move logic ------------------------------------------------------

  // Direction vectors: up, down, left, right
  var DIRS = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 }
  };

  // Build traversal order so that tiles closest to the target edge move first.
  function buildTraversal(dir) {
    var rows = [], cols = [];
    for (var i = 0; i < SIZE; i++) { rows.push(i); cols.push(i); }
    if (dir === 'down') rows.reverse();
    if (dir === 'right') cols.reverse();
    return rows.map(function (r) { return cols.map(function (c) { return { row: r, col: c }; }); }).flat();
  }

  function move(dir) {
    if (busy) return;
    if ((winOverlay && !winOverlay.hidden) || (overOverlay && !overOverlay.hidden)) return;

    // Reset per-move flags
    for (var r0 = 0; r0 < SIZE; r0++)
      for (var c0 = 0; c0 < SIZE; c0++)
        if (grid[r0][c0]) { grid[r0][c0].isNew = false; grid[r0][c0].merged = false; }

    var d = DIRS[dir];
    var order = buildTraversal(dir);
    var moved = false;
    var gained = 0;

    // For each cell, try to slide/merge in direction d
    for (var i = 0; i < order.length; i++) {
      var pos = order[i];
      var cell = grid[pos.row][pos.col];
      if (!cell) continue;

      // Find farthest position in direction d
      var nr = pos.row, nc = pos.col;
      var merged = false;

      // Step as far as possible into empty cells
      while (true) {
        var tr = nr + d.dr;
        var tc = nc + d.dc;
        if (tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE) break;
        var target = grid[tr][tc];
        if (!target) {
          nr = tr; nc = tc; // slide into empty
        } else if (target.value === cell.value && !target.merged && !cell.merged) {
          // Merge into target
          nr = tr; nc = tc;
          merged = true;
          break;
        } else {
          break;
        }
      }

      if (nr !== pos.row || nc !== pos.col) {
        moved = true;
        grid[pos.row][pos.col] = null;

        if (merged) {
          var mergedVal = cell.value * 2;
          var survivor = grid[nr][nc];
          // If target was empty (it won't be here because merged=true means target exists)
          if (survivor) {
            survivor.value = mergedVal;
            survivor.merged = true;
          } else {
            // safety — shouldn't happen
            survivor = cell;
            survivor.value = mergedVal;
            survivor.merged = true;
            survivor.row = nr; survivor.col = nc;
            grid[nr][nc] = survivor;
          }
          gained += mergedVal;
          // The current cell DOM will be reaped after animation
        } else {
          cell.row = nr; cell.col = nc;
          grid[nr][nc] = cell;
        }
      }
    }

    if (!moved) return;

    busy = true;
    render();
    updateScore(gained);

    window.setTimeout(function () {
      busy = false;
      var newTile = spawn();
      render();
      checkWin();
      if (!hasMoves()) showGameOver();
    }, ANIM_MS + 10);
  }

  // ---- Win / Lose checks ----------------------------------------------
  function checkWin() {
    if (!won && !keepPlaying) {
      for (var r = 0; r < SIZE; r++)
        for (var c = 0; c < SIZE; c++)
          if (grid[r][c] && grid[r][c].value >= WIN_VALUE) {
            won = true;
            showWin();
            return;
          }
    }
  }

  function hasMoves() {
    if (emptyCells().length) return true;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        var v = grid[r][c] ? grid[r][c].value : 0;
        if (!v) continue;
        // right neighbour
        if (c + 1 < SIZE && grid[r][c + 1] && grid[r][c + 1].value === v) return true;
        // down neighbour
        if (r + 1 < SIZE && grid[r + 1][c] && grid[r + 1][c].value === v) return true;
      }
    }
    return false;
  }

  function showWin() {
    if (winOverlay) winOverlay.hidden = false;
  }

  function showGameOver() {
    if (overOverlay) overOverlay.hidden = false;
  }

  function hideOverlays() {
    if (winOverlay) winOverlay.hidden = true;
    if (overOverlay) overOverlay.hidden = true;
  }

  // ---- New game --------------------------------------------------------
  function newGame() {
    hideOverlays();
    score = 0;
    won = false;
    keepPlaying = false;
    busy = false;
    nextId = 1;
    emptyGrid();
    clearTileDom();
    scoreEl.textContent = '0';
    spawn();
    spawn();
    render();
    boardEl.focus();
  }

  // ---- Input: keyboard -------------------------------------------------
  var KEY_MAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right'
  };

  document.addEventListener('keydown', function (e) {
    var dir = KEY_MAP[e.key];
    if (!dir) return;
    e.preventDefault();
    move(dir);
  }, { passive: false });

  // ---- Input: touch swipe ---------------------------------------------
  var touchStart = null;
  var SWIPE_MIN = 24; // px

  boardEl.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) return;
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });

  boardEl.addEventListener('touchmove', function (e) {
    // prevent page scroll while swiping on the board
    e.preventDefault();
  }, { passive: false });

  boardEl.addEventListener('touchend', function (e) {
    if (!touchStart) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - touchStart.x;
    var dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      move(dx > 0 ? 'right' : 'left');
    } else {
      move(dy > 0 ? 'down' : 'up');
    }
  }, { passive: true });

  // ---- Button wiring ----------------------------------------------------
  newGameBtn.addEventListener('click', newGame);
  if (keepGoingBtn) keepGoingBtn.addEventListener('click', function () {
    winOverlay.hidden = true;
    keepPlaying = true;
    boardEl.focus();
  });
  if (winNewGameBtn) winNewGameBtn.addEventListener('click', newGame);
  if (overNewGameBtn) overNewGameBtn.addEventListener('click', newGame);

  // ---- Recompute layout on resize -------------------------------------
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { render(); }, 100);
  });

  // ---- Boot -------------------------------------------------------------
  loadBest();
  buildGridCells();
  newGame();
})();
