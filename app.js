// ---- Storage ----

const STORAGE_KEY = 'skinsTracker.rounds'

function loadRounds() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRounds(rounds) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rounds))
}

// ---- Round model + scoring ----

function createRound({ name, playerNames, holeCount, skinValue }) {
  const players = playerNames.map((name, i) => ({ id: `p${i}-${Date.now()}`, name }))
  return {
    id: `round-${Date.now()}`,
    name,
    createdAt: Date.now(),
    players,
    holeCount,
    skinValue,
    scores: Array.from({ length: holeCount }, () => players.map(() => null)),
  }
}

/**
 * Walks the round hole by hole. Each player antes `skinValue` every hole.
 * A tie for low score carries the whole pot to the next hole; a solo low
 * score takes it. Net payouts across all players always sum to zero.
 */
function computeHoleResults(round) {
  const results = []
  let carryPot = 0

  for (let h = 0; h < round.holeCount; h++) {
    const holeScores = round.scores[h] || []
    const complete = round.players.length > 0 && round.players.every((_, i) => holeScores[i] != null)
    const pot = carryPot + round.skinValue * round.players.length

    if (!complete) {
      results.push({ pot, winnerId: null, complete: false })
      continue
    }

    const min = Math.min(...round.players.map((_, i) => holeScores[i]))
    const lowPlayers = round.players.filter((_, i) => holeScores[i] === min)

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

  round.scores.forEach((holeScores, h) => {
    const result = holeResults[h]
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

// ---- UI ----

const app = document.getElementById('app')
const backBtn = document.getElementById('backBtn')
const deleteBtn = document.getElementById('deleteBtn')

let rounds = loadRounds()
let activeId = null
let creating = false

function persist() {
  saveRounds(rounds)
}

function money(n) {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n)}`
}

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

function render() {
  app.innerHTML = ''
  const activeRound = rounds.find((r) => r.id === activeId) || null

  backBtn.hidden = !activeRound
  deleteBtn.hidden = !activeRound
  backBtn.onclick = () => { activeId = null; render() }
  deleteBtn.onclick = () => {
    if (!activeRound) return
    if (!confirm(`Delete "${activeRound.name}"? This can't be undone.`)) return
    rounds = rounds.filter((r) => r.id !== activeRound.id)
    activeId = null
    persist()
    render()
  }

  if (activeRound) {
    renderRound(activeRound)
  } else if (creating) {
    renderNewRoundForm()
  } else {
    renderRoundList()
  }
}

function renderRoundList() {
  const startBtn = el('button', { class: 'primary', onclick: () => { creating = true; render() } }, ['+ New Round'])
  app.appendChild(startBtn)

  if (rounds.length === 0) {
    app.appendChild(el('div', { class: 'empty-state' }, ["No rounds yet. Start one to track skins with your friends."]))
    return
  }

  rounds.forEach((r) => {
    const item = el('button', {
      class: 'round-list-item',
      onclick: () => { activeId = r.id; render() },
    }, [
      el('div', {}, [
        el('div', { class: 'name' }, [r.name]),
        el('div', { class: 'meta' }, [`${r.players.length} players · ${r.holeCount} holes · $${r.skinValue}/skin`]),
      ]),
      el('div', { style: 'color:#9ca3af' }, ['→']),
    ])
    app.appendChild(item)
  })
}

function renderNewRoundForm() {
  let playerNames = ['', '', '', '']
  let holeCount = 18
  let skinValue = 5

  const card = el('form', { class: 'card' })
  const title = el('h2', {}, ['New Round'])
  card.appendChild(title)

  const nameLabel = el('label', { class: 'field-label' }, ['Round name'])
  const nameInput = el('input', { placeholder: 'Saturday at Pebble', type: 'text' })
  card.appendChild(nameLabel)
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

  const playersLabel = el('label', { class: 'field-label', style: 'margin-top:14px' }, ['Players'])
  card.appendChild(playersLabel)
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

  const addPlayerBtn = el('button', {
    type: 'button',
    class: 'add-player-btn',
    onclick: () => { playerNames.push(''); renderPlayers() },
  }, ['+ Add player'])
  card.appendChild(addPlayerBtn)

  const errorBox = el('div', { class: 'error-text', style: 'margin-top:10px;display:none' })
  card.appendChild(errorBox)

  const actions = el('div', { class: 'form-actions', style: 'margin-top:14px' })
  const submitBtn = el('button', { type: 'submit', class: 'primary' }, ['Start Round'])
  const cancelBtn = el('button', {
    type: 'button',
    class: 'ghost-btn light',
    style: 'flex:1',
    onclick: () => { creating = false; render() },
  }, ['Cancel'])
  actions.appendChild(el('div', { style: 'flex:1' }, [submitBtn]))
  actions.appendChild(cancelBtn)
  card.appendChild(actions)

  card.onsubmit = (e) => {
    e.preventDefault()
    const cleanNames = playerNames.map((p) => p.trim()).filter(Boolean)
    if (cleanNames.length < 2) {
      errorBox.textContent = 'Add at least 2 players.'
      errorBox.style.display = 'block'
      return
    }
    const round = createRound({
      name: nameInput.value.trim() || 'Untitled Round',
      playerNames: cleanNames,
      holeCount,
      skinValue: Math.max(0, skinValue),
    })
    rounds = [round, ...rounds]
    activeId = round.id
    creating = false
    persist()
    render()
  }

  app.appendChild(card)
}

function renderRound(round) {
  const headerCard = el('div', { class: 'card' }, [
    el('h2', {}, [round.name]),
    el('div', { class: 'meta' }, [`${round.holeCount} holes · $${round.skinValue}/skin`]),
  ])
  app.appendChild(headerCard)

  const standingsCard = el('div', { class: 'card' })
  standingsCard.appendChild(el('div', { class: 'section-label' }, ['Standings']))
  const standingsBody = el('div')
  standingsCard.appendChild(standingsBody)
  app.appendChild(standingsCard)

  const tableCard = el('div', { class: 'card table-card' })
  const table = el('table')
  const thead = el('thead')
  const headRow = el('tr', {}, [el('th', {}, ['Hole']), ...round.players.map((p) => el('th', {}, [p.name])), el('th', {}, ['Pot']), el('th', {}, ['Skin'])])
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = el('tbody')
  const potCells = []
  const skinCells = []

  for (let h = 0; h < round.holeCount; h++) {
    const tr = el('tr', {}, [el('td', {}, [String(h + 1)])])

    round.players.forEach((p, pi) => {
      const td = el('td')
      const value = round.scores[h][pi]
      const input = el('input', {
        type: 'number',
        min: '1',
        class: 'score-input',
        value: value != null ? String(value) : '',
      })
      input.oninput = () => {
        const raw = input.value
        round.scores[h][pi] = raw === '' ? null : Number(raw)
        persist()
        updateDerived()
      }
      td.appendChild(input)
      tr.appendChild(td)
    })

    const potCell = el('td', { style: 'color:#6b7280' })
    const skinCell = el('td')
    tr.appendChild(potCell)
    tr.appendChild(skinCell)
    potCells.push(potCell)
    skinCells.push(skinCell)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  tableCard.appendChild(table)
  app.appendChild(tableCard)

  function updateDerived() {
    const holeResults = computeHoleResults(round)
    const standings = computeStandings(round, holeResults)

    standingsBody.innerHTML = ''
    standings.forEach((s) => {
      const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : 'zero'
      standingsBody.appendChild(el('div', { class: 'standings-row' }, [
        el('div', { class: 'player-name' }, [s.player.name]),
        el('div', { class: 'stats' }, [
          el('span', { class: 'skins-count' }, [`${s.skinsWon} skin${s.skinsWon === 1 ? '' : 's'}`]),
          el('span', { class: `net ${netClass}` }, [money(s.net)]),
        ]),
      ]))
    })

    holeResults.forEach((result, h) => {
      const winner = round.players.find((p) => p.id === result.winnerId)
      potCells[h].textContent = `$${result.pot}`
      skinCells[h].textContent = winner ? winner.name : result.complete ? 'Carried' : '—'
      skinCells[h].className = winner ? 'skin-winner' : 'skin-carried'
    })
  }

  updateDerived()
}

render()
