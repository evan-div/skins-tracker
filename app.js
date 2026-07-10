import { firebaseConfig } from './firebase-config.js'
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'
import {
  initializeFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'

const firebaseApp = initializeApp(firebaseConfig)
// Many mobile carrier networks and in-app browsers (e.g. Messages' link
// preview) block the persistent streaming connection Firestore prefers,
// which otherwise causes a slow fallback-detection delay that reads as
// "laggy". Forcing auto-detected long polling skips that delay.
const db = initializeFirestore(firebaseApp, { experimentalAutoDetectLongPolling: true })

// ---- Round codes ----

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L, avoids look-alikes
const CODE_LENGTH = 5

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

async function generateUniqueCode() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode()
    const snap = await getDoc(doc(db, 'rounds', code))
    if (!snap.exists()) return code
  }
  throw new Error('Could not generate a unique round code, please try again.')
}

// ---- Recently opened rounds (local, per-device convenience list) ----

const RECENTS_KEY = 'skinsTracker.recents'

function loadRecents() {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRecents(recents) {
  window.localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
}

function rememberRound(summary) {
  const recents = loadRecents().filter((r) => r.code !== summary.code)
  recents.unshift(summary)
  saveRecents(recents.slice(0, 20))
}

function forgetRound(code) {
  saveRecents(loadRecents().filter((r) => r.code !== code))
}

function summaryOf(round) {
  return {
    code: round.code,
    name: round.name,
    holeCount: round.holeCount,
    skinValue: round.skinValue,
    playerCount: round.players.length,
  }
}

// ---- Round model + scoring ----

function scoreKey(hole, playerIndex) {
  return `h${hole}_p${playerIndex}`
}

function getScore(round, hole, playerIndex) {
  const v = round.scores ? round.scores[scoreKey(hole, playerIndex)] : null
  return v == null ? null : v
}

function buildRound({ code, name, playerNames, holeCount, skinValue }) {
  const players = playerNames.map((name, i) => ({ id: `p${i}`, name }))
  return {
    code,
    name,
    createdAt: Date.now(),
    players,
    holeCount,
    skinValue,
    scores: {},
  }
}

/**
 * Walks the round hole by hole. Each player antes `skinValue` every hole.
 * A tie for low score carries the whole pot to the next hole; a solo low
 * score takes it. Net payouts across all players always sum to zero
 * (unless the round ends with an unresolved carry still on the table).
 */
function computeHoleResults(round) {
  const results = []
  let carryPot = 0

  for (let h = 0; h < round.holeCount; h++) {
    const complete = round.players.length > 0 && round.players.every((_, i) => getScore(round, h, i) != null)
    const pot = carryPot + round.skinValue * round.players.length

    if (!complete) {
      results.push({ pot, winnerId: null, complete: false })
      continue
    }

    const min = Math.min(...round.players.map((_, i) => getScore(round, h, i)))
    const lowPlayers = round.players.filter((_, i) => getScore(round, h, i) === min)

    if (lowPlayers.length === 1) {
      results.push({ pot, winnerId: lowPlayers[0].id, complete: true })
      carryPot = 0
    } else {
      results.push({ pot, winnerId: null, complete: true })
      carryPot = pot
    }
  }

  return results
}

function computeStandings(round, holeResults) {
  const net = {}
  const skinsWon = {}
  for (const p of round.players) {
    net[p.id] = 0
    skinsWon[p.id] = 0
  }

  holeResults.forEach((result) => {
    if (!result.complete) return
    for (const p of round.players) net[p.id] -= round.skinValue
    if (result.winnerId) {
      net[result.winnerId] += result.pot
      skinsWon[result.winnerId] += 1
    }
  })

  return round.players
    .map((player) => ({ player, skinsWon: skinsWon[player.id], net: net[player.id] }))
    .sort((a, b) => b.net - a.net)
}

function money(n) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n)}`
}

// ---- Avatars ----

const AVATAR_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

function colorForName(name) {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

function initialsFor(name) {
  const parts = name.trim().split(/\s+/)
  return parts.slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

function avatarEl(name, size = 28) {
  return el('div', {
    class: 'avatar',
    style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:${colorForName(name)}`,
  }, [initialsFor(name)])
}

// ---- Confetti ----

const CONFETTI_COLORS = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7']

function burstConfetti(x, y) {
  for (let i = 0; i < 14; i++) {
    const piece = document.createElement('div')
    piece.className = 'confetti-piece'
    piece.style.left = `${x}px`
    piece.style.top = `${y}px`
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const angle = Math.random() * Math.PI * 2
    const distance = 40 + Math.random() * 50
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`)
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance - 30}px`)
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`)
    document.body.appendChild(piece)
    piece.addEventListener('animationend', () => piece.remove())
  }
}

// ---- Score picker ----
// A tap-to-pick popup instead of a text input, so entering a score never
// summons the mobile keyboard. 1-9 covers the vast majority of holes;
// the poop emoji is a stand-in for "double digits, just move on" (stored
// as a sentinel value that's always worse than any real score entered).

const POOP_SCORE = 10

function formatScore(value) {
  if (value == null) return '–'
  return value === POOP_SCORE ? '💩' : String(value)
}

let currentPicker = null

function closeScorePicker() {
  if (!currentPicker) return
  currentPicker.backdrop.remove()
  currentPicker.picker.remove()
  currentPicker = null
}

function openScorePicker(anchorEl, currentValue, onSelect) {
  closeScorePicker()

  const backdrop = el('div', { class: 'score-picker-backdrop' })
  backdrop.onclick = closeScorePicker
  document.body.appendChild(backdrop)

  const picker = el('div', { class: 'score-picker' })
  const grid = el('div', { class: 'score-picker-grid' })
  const options = [1, 2, 3, 4, 5, 6, 7, 8, 9, POOP_SCORE]
  options.forEach((value) => {
    const isPoop = value === POOP_SCORE
    const btn = el('button', {
      type: 'button',
      class: `score-picker-btn${currentValue === value ? ' selected' : ''}`,
    }, [isPoop ? '💩' : String(value)])
    btn.onclick = (e) => {
      e.stopPropagation()
      closeScorePicker()
      onSelect(value)
    }
    grid.appendChild(btn)
  })
  picker.appendChild(grid)

  const clearBtn = el('button', { type: 'button', class: 'score-picker-clear' }, ['Clear'])
  clearBtn.onclick = (e) => {
    e.stopPropagation()
    closeScorePicker()
    onSelect(null)
  }
  picker.appendChild(clearBtn)

  document.body.appendChild(picker)

  const rect = anchorEl.getBoundingClientRect()
  const pw = picker.offsetWidth
  const ph = picker.offsetHeight
  let left = rect.left + rect.width / 2 - pw / 2
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8))
  let top = rect.bottom + 8
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 8
  picker.style.left = `${left}px`
  picker.style.top = `${top}px`

  currentPicker = { backdrop, picker }
}

// ---- DOM helpers ----

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null) node.setAttribute(k, v)
  })
  children.forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c))
  return node
}

// ---- App state ----

const app = document.getElementById('app')
const backBtn = document.getElementById('backBtn')
const deleteBtn = document.getElementById('deleteBtn')

let view = 'list' // 'list' | 'creating' | 'joining' | 'round'
let activeCode = null
let unsubscribeActive = null

function stopActiveSubscription() {
  closeScorePicker()
  if (unsubscribeActive) {
    unsubscribeActive()
    unsubscribeActive = null
  }
}

function goHome() {
  stopActiveSubscription()
  activeCode = null
  view = 'list'
  render()
}

function render() {
  app.innerHTML = ''
  backBtn.hidden = view !== 'round'
  deleteBtn.hidden = view !== 'round'
  backBtn.onclick = goHome
  deleteBtn.onclick = () => handleDelete()

  if (view === 'round' && activeCode) {
    mountRoundView(activeCode)
  } else if (view === 'creating') {
    renderNewRoundForm()
  } else if (view === 'joining') {
    renderJoinForm()
  } else {
    renderRoundList()
  }
}

async function handleDelete() {
  if (!activeCode) return
  if (!confirm('Delete this round for everyone? This can\'t be undone.')) return
  const code = activeCode
  try {
    await deleteDoc(doc(db, 'rounds', code))
  } catch (err) {
    alert('Could not delete round: ' + err.message)
    return
  }
  forgetRound(code)
  goHome()
}

// ---- List view ----

function renderRoundList() {
  app.appendChild(
    el('button', { class: 'primary', onclick: () => { view = 'creating'; render() } }, ['+ New Round'])
  )
  app.appendChild(
    el('button', {
      class: 'ghost-btn light',
      style: 'width:100%;padding:12px;font-size:14px',
      onclick: () => { view = 'joining'; render() },
    }, ['Join a round with a code'])
  )

  const recents = loadRecents()
  if (recents.length === 0) {
    app.appendChild(el('div', { class: 'empty-state' }, ['No rounds yet. Start one, or join a friend\'s round with their code.']))
    return
  }

  recents.forEach((r) => {
    const item = el('button', {
      class: 'round-list-item',
      onclick: () => openRound(r.code),
    }, [
      el('div', {}, [
        el('div', { class: 'name' }, [r.name]),
        el('div', { class: 'meta' }, [`${r.playerCount} players · ${r.holeCount} holes · $${r.skinValue}/skin · code ${r.code}`]),
      ]),
      el('div', { style: 'color:#9ca3af' }, ['→']),
    ])
    app.appendChild(item)
  })
}

async function openRound(code) {
  const snap = await getDoc(doc(db, 'rounds', code)).catch((err) => {
    alert('Could not open round: ' + err.message)
    return null
  })
  if (!snap) return
  if (!snap.exists()) {
    alert(`Round "${code}" no longer exists.`)
    forgetRound(code)
    render()
    return
  }
  activeCode = code
  view = 'round'
  render()
}

// ---- Join form ----

function renderJoinForm() {
  const card = el('form', { class: 'card' })
  card.appendChild(el('h2', {}, ['Join a Round']))
  card.appendChild(el('label', { class: 'field-label' }, ['Enter the round code your friend shared']))
  const codeInput = el('input', {
    type: 'text',
    placeholder: 'e.g. 7F3K2',
    style: 'text-transform:uppercase;letter-spacing:2px;font-weight:800;text-align:center;font-size:20px',
    maxlength: String(CODE_LENGTH),
  })
  card.appendChild(codeInput)

  const errorBox = el('div', { class: 'error-text', style: 'margin-top:10px;display:none' })
  card.appendChild(errorBox)

  const actions = el('div', { class: 'form-actions', style: 'margin-top:14px' })
  const submitBtn = el('button', { type: 'submit', class: 'primary' }, ['Join'])
  const cancelBtn = el('button', {
    type: 'button',
    class: 'ghost-btn light',
    style: 'flex:1',
    onclick: goHome,
  }, ['Cancel'])
  actions.appendChild(el('div', { style: 'flex:1' }, [submitBtn]))
  actions.appendChild(cancelBtn)
  card.appendChild(actions)

  card.onsubmit = async (e) => {
    e.preventDefault()
    const code = codeInput.value.trim().toUpperCase()
    if (code.length !== CODE_LENGTH) {
      errorBox.textContent = `Codes are ${CODE_LENGTH} characters.`
      errorBox.style.display = 'block'
      return
    }
    submitBtn.disabled = true
    submitBtn.textContent = 'Joining…'
    try {
      const snap = await getDoc(doc(db, 'rounds', code))
      if (!snap.exists()) {
        errorBox.textContent = `No round found with code "${code}".`
        errorBox.style.display = 'block'
        submitBtn.disabled = false
        submitBtn.textContent = 'Join'
        return
      }
      const round = snap.data()
      rememberRound(summaryOf(round))
      activeCode = code
      view = 'round'
      render()
    } catch (err) {
      errorBox.textContent = 'Could not reach the server: ' + err.message
      errorBox.style.display = 'block'
      submitBtn.disabled = false
      submitBtn.textContent = 'Join'
    }
  }

  app.appendChild(card)
}

// ---- New round form ----

function renderNewRoundForm() {
  let playerNames = ['', '', '', '']
  let holeCount = 18
  let skinValue = 5

  const card = el('form', { class: 'card' })
  card.appendChild(el('h2', {}, ['New Round']))

  card.appendChild(el('label', { class: 'field-label' }, ['Round name']))
  const nameInput = el('input', { placeholder: 'Saturday at Pebble', type: 'text' })
  card.appendChild(nameInput)

  const row = el('div', { class: 'field-row', style: 'margin-top:10px' })
  const holesWrap = el('div')
  holesWrap.appendChild(el('label', { class: 'field-label' }, ['Holes']))
  const holesSelect = el('select')
  ;[9, 18].forEach((n) => {
    const opt = el('option', { value: n }, [String(n)])
    if (n === holeCount) opt.selected = true
    holesSelect.appendChild(opt)
  })
  holesSelect.onchange = () => { holeCount = Number(holesSelect.value) }
  holesWrap.appendChild(holesSelect)

  const valueWrap = el('div')
  valueWrap.appendChild(el('label', { class: 'field-label' }, ['Skin value ($)']))
  const valueInput = el('input', { type: 'number', min: '0', value: String(skinValue) })
  valueInput.oninput = () => { skinValue = Number(valueInput.value) }
  valueWrap.appendChild(valueInput)

  row.appendChild(holesWrap)
  row.appendChild(valueWrap)
  card.appendChild(row)

  card.appendChild(el('label', { class: 'field-label', style: 'margin-top:14px' }, ['Players']))
  const playersList = el('div')
  card.appendChild(playersList)

  function renderPlayers() {
    playersList.innerHTML = ''
    playerNames.forEach((name, i) => {
      const prow = el('div', { class: 'player-row' })
      const input = el('input', { type: 'text', placeholder: `Player ${i + 1}`, value: name })
      input.oninput = () => { playerNames[i] = input.value }
      prow.appendChild(input)
      if (playerNames.length > 2) {
        const removeBtn = el('button', {
          type: 'button',
          class: 'remove-player',
          onclick: () => { playerNames.splice(i, 1); renderPlayers() },
        }, ['×'])
        prow.appendChild(removeBtn)
      }
      playersList.appendChild(prow)
    })
  }
  renderPlayers()

  card.appendChild(el('button', {
    type: 'button',
    class: 'add-player-btn',
    onclick: () => { playerNames.push(''); renderPlayers() },
  }, ['+ Add player']))

  const errorBox = el('div', { class: 'error-text', style: 'margin-top:10px;display:none' })
  card.appendChild(errorBox)

  const actions = el('div', { class: 'form-actions', style: 'margin-top:14px' })
  const submitBtn = el('button', { type: 'submit', class: 'primary' }, ['Start Round'])
  const cancelBtn = el('button', { type: 'button', class: 'ghost-btn light', style: 'flex:1', onclick: goHome }, ['Cancel'])
  actions.appendChild(el('div', { style: 'flex:1' }, [submitBtn]))
  actions.appendChild(cancelBtn)
  card.appendChild(actions)

  card.onsubmit = async (e) => {
    e.preventDefault()
    const cleanNames = playerNames.map((p) => p.trim()).filter(Boolean)
    if (cleanNames.length < 2) {
      errorBox.textContent = 'Add at least 2 players.'
      errorBox.style.display = 'block'
      return
    }
    submitBtn.disabled = true
    submitBtn.textContent = 'Starting…'
    try {
      const code = await generateUniqueCode()
      const round = buildRound({
        code,
        name: nameInput.value.trim() || 'Untitled Round',
        playerNames: cleanNames,
        holeCount,
        skinValue: Math.max(0, skinValue),
      })
      await setDoc(doc(db, 'rounds', code), round)
      rememberRound(summaryOf(round))
      activeCode = code
      view = 'round'
      render()
    } catch (err) {
      errorBox.textContent = 'Could not create round: ' + err.message
      errorBox.style.display = 'block'
      submitBtn.disabled = false
      submitBtn.textContent = 'Start Round'
    }
  }

  app.appendChild(card)
}

// ---- Round view (live) ----

function mountRoundView(code) {
  stopActiveSubscription()

  const statusBanner = el('div', {
    class: 'card',
    style: 'display:none;background:#fef2f2;color:#991b1b;font-size:13px;font-weight:700;padding:12px 16px',
  })
  app.appendChild(statusBanner)

  function showStatus(message) {
    statusBanner.textContent = message
    statusBanner.style.display = 'block'
  }
  function clearStatus() {
    statusBanner.style.display = 'none'
  }

  const headerCard = el('div', { class: 'card' })
  app.appendChild(headerCard)

  const codeCard = el('div', { class: 'card', style: 'display:flex;align-items:center;justify-content:space-between;gap:10px' })
  app.appendChild(codeCard)

  const standingsCard = el('div', { class: 'card' })
  standingsCard.appendChild(el('div', { class: 'section-label' }, ['Standings']))
  const standingsBody = el('div')
  standingsCard.appendChild(standingsBody)
  app.appendChild(standingsCard)

  const tableCard = el('div', { class: 'card table-card' })
  app.appendChild(tableCard)

  let built = false
  let potCells = []
  let skinCells = []
  let scoreButtons = [] // scoreButtons[h][pi]
  let previousWinnerIds = [] // per hole, so we only confetti *new* skin winners
  let firstSnapshot = true // don't confetti pre-existing winners on initial load

  function buildTable(round) {
    tableCard.innerHTML = ''
    const table = el('table')
    const thead = el('thead')
    thead.appendChild(
      el('tr', {}, [
        el('th', {}, ['Hole']),
        ...round.players.map((p) => el('th', {}, [
          el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:3px' }, [
            avatarEl(p.name, 20),
            el('span', {}, [p.name]),
          ]),
        ])),
        el('th', {}, ['Pot']),
        el('th', {}, ['Skin']),
      ])
    )
    table.appendChild(thead)

    const tbody = el('tbody')
    potCells = []
    skinCells = []
    scoreButtons = []

    for (let h = 0; h < round.holeCount; h++) {
      const tr = el('tr', {}, [el('td', {}, [String(h + 1)])])
      const rowButtons = []

      round.players.forEach((p, pi) => {
        const td = el('td')
        const value = getScore(round, h, pi)
        const scoreBtn = el('button', { type: 'button', class: 'score-btn' }, [formatScore(value)])
        scoreBtn._score = value
        scoreBtn.onclick = () => {
          openScorePicker(scoreBtn, scoreBtn._score, (numeric) => {
            updateDoc(doc(db, 'rounds', code), { [`scores.${scoreKey(h, pi)}`]: numeric })
              .then(clearStatus)
              .catch((err) => {
                showStatus('Could not save that score — check your connection: ' + err.message)
              })
          })
        }
        rowButtons.push(scoreBtn)
        td.appendChild(scoreBtn)
        tr.appendChild(td)
      })

      const potCell = el('td', { style: 'color:#6b7280' })
      const skinCell = el('td')
      tr.appendChild(potCell)
      tr.appendChild(skinCell)
      potCells.push(potCell)
      skinCells.push(skinCell)
      scoreButtons.push(rowButtons)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    tableCard.appendChild(table)
    built = true
  }

  function updateFromRound(round) {
    headerCard.innerHTML = ''
    headerCard.appendChild(el('h2', {}, [round.name]))
    headerCard.appendChild(el('div', { class: 'meta' }, [`${round.holeCount} holes · $${round.skinValue}/skin`]))

    codeCard.innerHTML = ''
    codeCard.appendChild(
      el('div', {}, [
        el('div', { class: 'meta' }, ['Share this code so friends can join']),
        el('div', { style: 'font-weight:900;font-size:22px;letter-spacing:3px' }, [round.code]),
      ])
    )
    const copyBtn = el('button', { class: 'ghost-btn light' }, ['Copy'])
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(round.code)
        copyBtn.textContent = 'Copied!'
        setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
      } catch {
        alert(`Round code: ${round.code}`)
      }
    }
    codeCard.appendChild(copyBtn)

    if (!built) buildTable(round)

    round.players.forEach((p, pi) => {
      for (let h = 0; h < round.holeCount; h++) {
        const scoreBtn = scoreButtons[h][pi]
        const value = getScore(round, h, pi)
        scoreBtn._score = value
        scoreBtn.textContent = formatScore(value)
      }
    })

    const holeResults = computeHoleResults(round)
    const standings = computeStandings(round, holeResults)

    const hasClearLeader = standings.length > 1 && standings[0].net > standings[1].net

    standingsBody.innerHTML = ''
    standings.forEach((s, i) => {
      const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : 'zero'
      const isLeader = i === 0 && hasClearLeader
      standingsBody.appendChild(
        el('div', { class: `standings-row${isLeader ? ' leader' : ''}` }, [
          el('div', { class: 'player-identity' }, [
            avatarEl(s.player.name),
            el('div', { class: 'player-name' }, [isLeader ? '👑 ' : '', s.player.name]),
          ]),
          el('div', { class: 'stats' }, [
            el('span', { class: 'skins-count' }, [`${s.skinsWon} skin${s.skinsWon === 1 ? '' : 's'}`]),
            el('span', { class: `net ${netClass}` }, [money(s.net)]),
          ]),
        ])
      )
    })

    holeResults.forEach((result, h) => {
      const winner = round.players.find((p) => p.id === result.winnerId)
      const hadWinnerBefore = previousWinnerIds[h] != null
      potCells[h].textContent = `$${result.pot}`
      skinCells[h].textContent = winner ? winner.name : result.complete ? 'Carried' : '—'
      skinCells[h].className = winner ? 'skin-winner' : 'skin-carried'

      if (winner && !hadWinnerBefore && !firstSnapshot) {
        const rect = skinCells[h].getBoundingClientRect()
        burstConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2)
      }
      previousWinnerIds[h] = result.winnerId
    })
    firstSnapshot = false

    rememberRound(summaryOf(round))
  }

  let unsubscribeSnapshot = null

  function subscribe() {
    if (unsubscribeSnapshot) unsubscribeSnapshot()
    unsubscribeSnapshot = onSnapshot(
      doc(db, 'rounds', code),
      (snap) => {
        if (!snap.exists()) {
          showStatus('This round was deleted.')
          forgetRound(code)
          return
        }
        clearStatus()
        updateFromRound(snap.data())
      },
      (err) => {
        showStatus('Live connection lost, retrying: ' + err.message)
      }
    )
  }

  subscribe()

  // iOS Safari (and in-app browsers like Messages' link preview) can freeze
  // a page's network connections when backgrounded and not reliably resume
  // them; force a fresh subscription whenever this round view becomes
  // visible again rather than trusting the old one silently reconnected.
  function handleVisibility() {
    if (document.visibilityState === 'visible' && view === 'round' && activeCode === code) {
      subscribe()
    }
  }
  document.addEventListener('visibilitychange', handleVisibility)

  unsubscribeActive = () => {
    if (unsubscribeSnapshot) unsubscribeSnapshot()
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}

// Prevent the browser's native pull-to-refresh gesture from reloading the
// page mid-round — Firestore already keeps the view live, and a full
// reload was landing users on a stale/blank screen while reconnecting.
document.body.style.overscrollBehaviorY = 'contain'

render()
