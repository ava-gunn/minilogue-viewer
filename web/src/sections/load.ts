import { emit, on } from '../events/bus'
import { parseLibrary } from '../parser'
import { buildLibrary } from '../parser/write-library'
import { getRating, MAX_STARS, setRating } from '../services/ratings'
import type { MinilogueXDPatch } from '../types/synth'

// No audio/inference dependency: shared with the Ableton embed (embed.ts), which must stay ONNX-free.

/** Trigger a browser download of raw bytes as `filename`. */
function downloadFile(filename: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function initLoad(): void {
  on('file:dropped', async ({ file }) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const entries = parseLibrary(bytes)
      if (entries.length === 0) {
        emit('file:error', { message: `No programs found in ${file.name}` })
        return
      }
      const patches = entries.map((e) => e.patch)
      if (patches.length > 1) {
        emit('file:parsed-lib', {
          name: file.name,
          patches,
          keys: entries.map((e) => e.key),
          bins: entries.map((e) => e.bytes),
        })
      }
      emit('patch:load', { patch: patches[0], index: 0, total: patches.length })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('file:error', { message: `Could not read ${file.name}: ${message}` })
    }
  })
}

export function initLibrary(): void {
  on('file:parsed-lib', ({ name, patches, keys, bins }) => {
    const panel = document.getElementById('library-panel')
    const list = document.getElementById('program-list')
    if (!panel || !list) return

    // Rating key: prefer the parsed content hash; fall back to a session-only index key (tests, or
    // an emitter that omits keys) so the widget still functions.
    const ratingKey = (i: number): string => keys?.[i] ?? `idx:${i}`

    const options = (): HTMLElement[] =>
      Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'))
    const visible = (): HTMLElement[] => options().filter((o) => !o.hidden)

    let minStars = 0 // 0 = no minimum
    let unratedOnly = false
    let countEl: HTMLElement | null = null
    let exportBtn: HTMLButtonElement | null = null

    const applyFilter = (): void => {
      let shown = 0
      options().forEach((opt, i) => {
        const r = getRating(ratingKey(i))
        const match = unratedOnly ? r === 0 : r >= minStars
        opt.hidden = !match
        if (match) shown++
      })
      if (countEl) countEl.textContent = `${shown} of ${patches.length}`
      if (exportBtn) exportBtn.disabled = shown === 0 || !bins
    }

    // 0–5 star control for one option; re-renders in place and re-applies the active filter.
    const renderStars = (host: HTMLElement, key: string): void => {
      const current = getRating(key)
      host.replaceChildren(
        ...Array.from({ length: MAX_STARS }, (_, i) => {
          const n = i + 1
          const star = document.createElement('button')
          star.type = 'button'
          star.tabIndex = -1 // keeps the listbox's roving tabindex intact
          star.className = n <= current ? 'xd-star on' : 'xd-star'
          star.textContent = n <= current ? '★' : '☆'
          star.setAttribute('aria-label', `${n} star${n > 1 ? 's' : ''}`)
          star.setAttribute('aria-pressed', String(n <= current))
          star.addEventListener('click', (e) => {
            e.stopPropagation() // don't trigger the option's select
            setRating(key, current === n ? 0 : n) // re-click the current top star to clear
            renderStars(host, key)
            applyFilter()
          })
          return star
        }),
      )
      host.setAttribute(
        'aria-label',
        current ? `Rated ${current} of ${MAX_STARS} stars` : 'Not rated',
      )
    }

    const select = (
      li: HTMLElement,
      patch: MinilogueXDPatch,
      index: number,
    ): void => {
      // Roving tabindex: the selected option is the single tab stop for the listbox.
      for (const el of options()) {
        el.setAttribute('aria-selected', el === li ? 'true' : 'false')
        el.tabIndex = el === li ? 0 : -1
      }
      emit('patch:load', { patch, index, total: patches.length })
    }

    // Move focus across the *visible* options (so filtering doesn't strand the cursor).
    const move = (from: HTMLElement, delta: number): void => {
      const vis = visible()
      const i = vis.indexOf(from)
      if (i === -1 || vis.length === 0) return
      vis[(i + delta + vis.length) % vis.length]?.focus()
    }

    list.replaceChildren(
      ...patches.map((patch, index) => {
        const key = ratingKey(index)
        const opt = document.createElement('div')
        opt.setAttribute('role', 'option')
        opt.tabIndex = index === 0 ? 0 : -1
        opt.setAttribute('aria-selected', index === 0 ? 'true' : 'false')

        const name = document.createElement('span')
        name.className = 'program-name'
        name.textContent = `${String(index + 1).padStart(3, '0')}  ${patch.name || 'INIT'}`

        const stars = document.createElement('span')
        stars.className = 'xd-stars'
        stars.setAttribute('role', 'group')
        renderStars(stars, key)

        opt.append(name, stars)
        opt.addEventListener('click', () => select(opt, patch, index))
        opt.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            select(opt, patch, index)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            move(opt, 1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            move(opt, -1)
          } else if (e.key === 'Home') {
            e.preventDefault()
            visible()[0]?.focus()
          } else if (e.key === 'End') {
            e.preventDefault()
            const vis = visible()
            vis[vis.length - 1]?.focus()
          } else if (e.key.length === 1 && e.key >= '0' && e.key <= '5') {
            // Number keys rate the focused patch (keyboard path; stars are mouse-only tab-wise).
            e.preventDefault()
            setRating(key, Number(e.key))
            renderStars(stars, key)
            applyFilter()
          }
        })
        return opt
      }),
    )

    // Filter bar (min-star threshold + unrated), rebuilt on each populate.
    document.getElementById('library-filter-bar')?.remove()
    const bar = document.createElement('div')
    bar.id = 'library-filter-bar'
    bar.className = 'library-filter'
    const filterLabel = document.createElement('label')
    filterLabel.htmlFor = 'library-filter-select'
    filterLabel.textContent = 'Show'
    const filterSel = document.createElement('select')
    filterSel.id = 'library-filter-select'
    filterSel.className = 'library-filter-select'
    for (const [value, text] of [
      ['all', 'All ratings'],
      ['1', '★ 1+'],
      ['2', '★★ 2+'],
      ['3', '★★★ 3+'],
      ['4', '★★★★ 4+'],
      ['5', '★★★★★ 5'],
      ['unrated', 'Unrated'],
    ] as const) {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      filterSel.append(o)
    }
    filterSel.addEventListener('change', () => {
      unratedOnly = filterSel.value === 'unrated'
      minStars =
        filterSel.value === 'all' || filterSel.value === 'unrated'
          ? 0
          : Number(filterSel.value)
      applyFilter()
    })
    countEl = document.createElement('span')
    countEl.className = 'library-count'
    countEl.setAttribute('role', 'status') // announce the "N of M" count after filtering

    // Export the currently-shown patches as a fresh .mnlgxdlib (lossless — reuses the source bytes).
    exportBtn = document.createElement('button')
    exportBtn.type = 'button'
    exportBtn.id = 'library-export'
    exportBtn.className = 'library-export'
    exportBtn.textContent = 'Export'
    exportBtn.title = 'Export the shown patches as a new .mnlgxdlib library'
    exportBtn.addEventListener('click', () => {
      if (!bins) return
      const chosen: Uint8Array[] = []
      options().forEach((opt, i) => {
        const b = bins[i]
        if (!opt.hidden && b) chosen.push(b)
      })
      if (chosen.length === 0) return
      const tag = unratedOnly
        ? 'unrated'
        : minStars === 0
          ? 'filtered'
          : minStars === MAX_STARS
            ? '5star'
            : `${minStars}plus`
      const base = (name || 'library').replace(/\.mnlgxd(lib|prog)$/i, '')
      downloadFile(`${base}-${tag}.mnlgxdlib`, buildLibrary(chosen))
    })

    bar.append(filterLabel, filterSel, countEl, exportBtn)
    list.before(bar)

    applyFilter()
    panel.removeAttribute('hidden')
    panel.setAttribute('open', '')
  })
}
