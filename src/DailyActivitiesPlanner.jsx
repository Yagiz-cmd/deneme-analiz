import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabaseClient'
import './daily-activities.css'

const DAILY_DAYS = [
  { name: 'Salı', short: 'Sal' },
  { name: 'Çarşamba', short: 'Çar' },
  { name: 'Perşembe', short: 'Per' },
  { name: 'Cuma', short: 'Cum' },
  { name: 'Cumartesi', short: 'Cmt' },
  { name: 'Pazar', short: 'Paz' },
]

const DAILY_COLORS = ['#172033', '#ffffff', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#d97706']
const DAILY_FONT_SIZES = ['12px', '14px', '16px', '18px', '22px', '26px']

function dailyDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getDailyWeek(offset = 0) {
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  const daysSinceMonday = (monday.getDay() + 6) % 7
  monday.setDate(monday.getDate() - daysSinceMonday + (offset * 7))

  const start = new Date(monday)
  start.setDate(start.getDate() - 6) // Salı
  const end = new Date(monday)
  end.setDate(end.getDate() - 1) // Pazar

  const dates = DAILY_DAYS.map((day, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return {
      ...day,
      date,
      dateKey: dailyDateKey(date),
      dateLabel: new Intl.DateTimeFormat('tr-TR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date),
      isToday: dailyDateKey(date) === dailyDateKey(new Date()),
    }
  })

  const formatRangeDate = (date) => new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
  }).format(date)

  return {
    startKey: dailyDateKey(start),
    endKey: dailyDateKey(end),
    dates,
    label: `${formatRangeDate(start)} – ${formatRangeDate(end)} ${end.getFullYear()}`,
  }
}

// Kaydedilen biçimli metinde yalnızca güvenli metin/biçim etiketlerine izin verir.
// Script, bağlantı, resim, olay özniteliği ve bilinmeyen stiller ekrana taşınmaz.
function sanitizeDailyActivityHtml(value) {
  const input = String(value ?? '').slice(0, 30000)
  if (typeof DOMParser === 'undefined') {
    return input.replace(/<[^>]*>/g, '')
  }

  const documentValue = new DOMParser().parseFromString(`<div id="daily-safe-root">${input}</div>`, 'text/html')
  const root = documentValue.getElementById('daily-safe-root')
  if (!root) return ''

  const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI'])
  const dangerousTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'VIDEO', 'AUDIO'])

  const cleanNode = (node) => {
    if (node.nodeType === 3) return documentValue.createTextNode(node.nodeValue || '')
    if (node.nodeType !== 1) return documentValue.createDocumentFragment()

    const tag = node.tagName.toUpperCase()
    if (dangerousTags.has(tag)) return documentValue.createDocumentFragment()

    if (!allowedTags.has(tag)) {
      const fragment = documentValue.createDocumentFragment()
      Array.from(node.childNodes).forEach((child) => fragment.appendChild(cleanNode(child)))
      return fragment
    }

    const clean = documentValue.createElement(tag.toLowerCase())
    if (tag === 'SPAN') {
      const suppliedColor = node.style?.color || ''
      const suppliedSize = node.style?.fontSize || ''
      if (/^#[0-9a-f]{3,8}$/i.test(suppliedColor)) clean.style.color = suppliedColor
      if (/^(12|14|16|18|22|26)px$/.test(suppliedSize)) clean.style.fontSize = suppliedSize
    }

    Array.from(node.childNodes).forEach((child) => clean.appendChild(cleanNode(child)))
    return clean
  }

  const safeRoot = documentValue.createElement('div')
  Array.from(root.childNodes).forEach((child) => safeRoot.appendChild(cleanNode(child)))
  return safeRoot.innerHTML
}

async function invokeDailyAdmin(action, payload, adminToken) {
  const { data, error } = await supabase.functions.invoke('admin-api', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${adminToken}` },
  })

  if (error) {
    let message = error.message || 'Yönetici işlemi tamamlanamadı.'
    try {
      const response = error.context?.clone?.()
      const details = response ? await response.json() : null
      if (details?.error) message = details.error
    } catch {
      // SDK hata mesajı kullanılmaya devam edilir.
    }
    throw new Error(message)
  }

  if (!data?.ok) throw new Error(data?.error || 'Günlük kayıt kaydedilemedi.')
  return data
}

function DailyActivityDayCard({ day, contentHtml, adminToken, saving, onSave, onDirty }) {
  const editorRef = useRef(null)
  const savedRangeRef = useRef(null)
  const [dirty, setDirty] = useState(false)
  const [formatError, setFormatError] = useState('')

  useEffect(() => {
    setDirty(false)
    setFormatError('')
    savedRangeRef.current = null
  }, [day.dateKey, contentHtml])

  const markDirty = () => {
    setDirty(true)
    onDirty(day.dateKey, true)
  }

  const rememberSelection = () => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange()
    }
  }

  const restoreSelection = () => {
    const editor = editorRef.current
    if (!editor) return null
    editor.focus()

    const selection = window.getSelection()
    if (!selection) return null

    if (savedRangeRef.current && editor.contains(savedRangeRef.current.commonAncestorContainer)) {
      selection.removeAllRanges()
      selection.addRange(savedRangeRef.current)
    }
    return selection
  }

  const runFormatCommand = (command) => {
    const selection = restoreSelection()
    if (!selection) return
    document.execCommand(command, false, null)
    rememberSelection()
    setFormatError('')
    markDirty()
  }

  const applyInlineStyle = (property, value) => {
    const selection = restoreSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)

    if (range.collapsed) {
      setFormatError('Biçim uygulamak için önce yazdığın metni seç.')
      return
    }

    const selectedContent = range.extractContents()
    const span = document.createElement('span')
    span.style[property] = value
    span.appendChild(selectedContent)
    range.insertNode(span)

    const nextRange = document.createRange()
    nextRange.selectNodeContents(span)
    selection.removeAllRanges()
    selection.addRange(nextRange)
    savedRangeRef.current = nextRange.cloneRange()
    setFormatError('')
    markDirty()
  }

  const clearEditor = () => {
    if (!editorRef.current) return
    editorRef.current.innerHTML = ''
    setFormatError('')
    markDirty()
  }

  const save = async () => {
    const html = sanitizeDailyActivityHtml(editorRef.current?.innerHTML || '')
    if (new TextEncoder().encode(html).length > 20000) {
      setFormatError('Bu gün için içerik çok uzun. Biraz kısaltıp tekrar kaydet.')
      return
    }

    const saved = await onSave(day.dateKey, html)
    if (saved) {
      setDirty(false)
      onDirty(day.dateKey, false)
      setFormatError('')
    }
  }

  const displayHtml = sanitizeDailyActivityHtml(contentHtml)

  return (
    <article className={`daily-day-card${day.isToday ? ' is-today' : ''}`}>
      <div className="daily-day-heading">
        <div>
          <span className="daily-day-name">{day.name}</span>
          <strong>{day.dateLabel}</strong>
        </div>
        <div className="daily-day-state">
          {day.isToday && <span className="daily-today-pill">Bugün</span>}
          {dirty && <span className="daily-unsaved-pill">Kaydedilmedi</span>}
          {!dirty && displayHtml && <span className="daily-saved-pill">Kayıtlı</span>}
        </div>
      </div>

      {adminToken ? (
        <>
          <div className="daily-editor-toolbar" aria-label={`${day.name} biçimlendirme araçları`}>
            <button type="button" className="daily-format-button format-bold" title="Kalın" aria-label="Kalın" onMouseDown={(event) => event.preventDefault()} onClick={() => runFormatCommand('bold')}>B</button>
            <button type="button" className="daily-format-button format-italic" title="İtalik" aria-label="İtalik" onMouseDown={(event) => event.preventDefault()} onClick={() => runFormatCommand('italic')}>I</button>
            <button type="button" className="daily-format-button format-underline" title="Altı çizili" aria-label="Altı çizili" onMouseDown={(event) => event.preventDefault()} onClick={() => runFormatCommand('underline')}>U</button>

            <select
              className="daily-format-select"
              aria-label="Yazı boyutu"
              defaultValue="16px"
              onMouseDown={rememberSelection}
              onChange={(event) => applyInlineStyle('fontSize', event.target.value)}
            >
              {DAILY_FONT_SIZES.map((size) => <option key={size} value={size}>{size.replace('px', '')} px</option>)}
            </select>

            <div className="daily-color-palette" aria-label="Yazı rengi">
              {DAILY_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="daily-color-swatch"
                  title={`Yazı rengi ${color}`}
                  aria-label={`Yazı rengini ${color} yap`}
                  style={{ backgroundColor: color }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyInlineStyle('color', color)}
                />
              ))}
            </div>
            <button type="button" className="daily-clear-format" onClick={clearEditor} title="Günlük alanını temizle">Temizle</button>
          </div>

          <div
            ref={editorRef}
            className="daily-rich-editor"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={`${day.name} günü neler yaptığını, çözdüğün soru sayılarını, bitirdiğin konuları ve eksiklerini buraya yaz…`}
            dangerouslySetInnerHTML={{ __html: displayHtml }}
            onInput={markDirty}
            onMouseUp={rememberSelection}
            onKeyUp={rememberSelection}
            onBlur={rememberSelection}
            role="textbox"
            aria-label={`${day.name} günü yapılan çalışmalar`}
            aria-multiline="true"
          />

          {formatError && <div className="daily-format-error" role="alert">{formatError}</div>}

          <div className="daily-card-footer">
            <span>{dirty ? 'Değişiklikler henüz kaydedilmedi.' : displayHtml ? 'Son kaydedilen günlük çalışma.' : 'Henüz çalışma girilmedi.'}</span>
            <button type="button" className="daily-save-button" onClick={save} disabled={!dirty || saving}>
              {saving ? 'Kaydediliyor…' : 'Günü kaydet'}
            </button>
          </div>
        </>
      ) : (
        <div className="daily-readonly-content">
          {displayHtml ? (
            <div dangerouslySetInnerHTML={{ __html: displayHtml }} />
          ) : (
            <span className="daily-empty-copy">Bu gün için henüz çalışma kaydı girilmemiş.</span>
          )}
        </div>
      )}
    </article>
  )
}

export default function DailyActivitiesPlanner({ adminToken }) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [records, setRecords] = useState({})
  const [loading, setLoading] = useState(true)
  const [savingDate, setSavingDate] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dirtyDates, setDirtyDates] = useState([])

  const week = useMemo(() => getDailyWeek(weekOffset), [weekOffset])

  useEffect(() => {
    let cancelled = false

    async function loadWeek() {
      setLoading(true)
      setError('')
      setNotice('')

      const { data, error: queryError } = await supabase
        .from('da_daily_activities')
        .select('activity_date, content_html, updated_at')
        .gte('activity_date', week.startKey)
        .lte('activity_date', week.endKey)
        .order('activity_date', { ascending: true })

      if (cancelled) return

      if (queryError) {
        setRecords({})
        setError(`Günlük yapılanlar yüklenemedi: ${queryError.message}. Önce günlük yapılanlar SQL dosyasını Supabase SQL Editor'de çalıştırmalısın.`)
      } else {
        const nextRecords = Object.fromEntries((data || []).map((row) => [row.activity_date, row]))
        setRecords(nextRecords)
        setDirtyDates([])
      }
      setLoading(false)
    }

    loadWeek()
    return () => { cancelled = true }
  }, [week.startKey, week.endKey])

  const changeWeek = (nextOffset) => {
    if (dirtyDates.length && !window.confirm('Kaydedilmemiş günlük değişikliklerin var. Hafta değiştirirsen bu değişiklikler kaybolacak. Yine de devam edilsin mi?')) {
      return
    }
    setDirtyDates([])
    setWeekOffset(nextOffset)
  }

  const markDirty = (dateKey, isDirty) => {
    setDirtyDates((current) => {
      const next = new Set(current)
      if (isDirty) next.add(dateKey)
      else next.delete(dateKey)
      return [...next]
    })
  }

  const saveDay = async (dateKey, contentHtml) => {
    if (!adminToken) return false
    setSavingDate(dateKey)
    setError('')
    setNotice('')

    try {
      const result = await invokeDailyAdmin('save_daily_activity', {
        activity_date: dateKey,
        content_html: contentHtml,
      }, adminToken)
      setRecords((current) => ({ ...current, [dateKey]: result.activity }))
      setNotice(`${new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full' }).format(new Date(`${dateKey}T12:00:00`))} kaydedildi.`)
      return true
    } catch (saveError) {
      setError(saveError?.message || 'Günlük çalışma kaydedilemedi.')
      return false
    } finally {
      setSavingDate('')
    }
  }

  return (
    <section className="detail-panel daily-activities-panel">
      <div className="daily-planner-heading">
        <div>
          <span className="section-kicker">HAFTALIK ÇALIŞMA GÜNLÜĞÜ</span>
          <h2>Günlük yapılanlar</h2>
          <p>Salıdan pazara kadar her gün neler yaptığını kaydet. Öğretmenin bu alanı görüntüleyebilir.</p>
        </div>
        {adminToken ? <span className="daily-admin-pill">Düzenleme açık</span> : <span className="daily-viewer-pill">Görüntüleme</span>}
      </div>

      <div className="daily-week-navigation">
        <button type="button" className="daily-week-arrow" onClick={() => changeWeek(weekOffset - 1)} aria-label="Önceki hafta">‹</button>
        <div className="daily-week-title">
          <strong>{week.label}</strong>
          <span>Salı – Pazar · 6 günlük çalışma takvimi</span>
        </div>
        <button type="button" className="daily-week-arrow" onClick={() => changeWeek(weekOffset + 1)} aria-label="Sonraki hafta">›</button>
        {weekOffset !== 0 && <button type="button" className="daily-current-week" onClick={() => changeWeek(0)}>Bu haftaya dön</button>}
      </div>

      {error && <div className="daily-message daily-error" role="alert">{error}</div>}
      {notice && <div className="daily-message daily-success" role="status">{notice}</div>}

      {loading ? (
        <div className="daily-loading">Haftalık çalışma kayıtları yükleniyor…</div>
      ) : (
        <div className="daily-days-grid">
          {week.dates.map((day) => (
            <DailyActivityDayCard
              key={day.dateKey}
              day={day}
              contentHtml={records[day.dateKey]?.content_html || ''}
              adminToken={adminToken}
              saving={savingDate === day.dateKey}
              onSave={saveDay}
              onDirty={markDirty}
            />
          ))}
        </div>
      )}

      <div className="daily-planner-footnote">
        Günlük kayıtlar Supabase'te saklanır. Yönetici olmayan ziyaretçiler yalnızca kayıtları görüntüleyebilir.
      </div>
    </section>
  )
}
