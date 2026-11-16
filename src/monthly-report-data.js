const REPORT_SUBJECTS = [
  'AYT Matematik', 'AYT Fizik', 'AYT Kimya', 'AYT Biyoloji',
  'TYT Matematik', 'TYT Türkçe', 'TYT Fen', 'TYT Sosyal',
]

function numeric(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

function monthLabel(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number)
  if (!year || !month || month < 1 || month > 12) return monthKey
  return new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, 1))
}

function dateLabel(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  if (!year || !month || !day) return dateKey
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' })
    .format(new Date(year, month - 1, day))
}

function shiftDate(dateKey, amount) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  const value = new Date(year, month - 1, day)
  value.setDate(value.getDate() + amount)
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function studyPeriodForDate(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const weekday = date.getDay()

  // Haftalık çalışma aralığı Salı-Pazar. Pazartesi kontrol günü ayrıca gösterilir.
  if (weekday === 1) {
    return {
      key: `monday-${dateKey}`,
      sortKey: dateKey,
      periodType: 'monday',
      start: dateKey,
      end: dateKey,
      label: `${dateLabel(dateKey)} · Pazartesi kontrol`,
    }
  }

  const daysUntilMonday = (8 - weekday) % 7
  const reviewMonday = shiftDate(dateKey, daysUntilMonday)
  const start = shiftDate(reviewMonday, -6)
  const end = shiftDate(reviewMonday, -1)
  return {
    key: reviewMonday,
    sortKey: start,
    periodType: 'study',
    start,
    end,
    label: `${dateLabel(start)} – ${dateLabel(end)} · Salı-Pazar`,
  }
}

export function buildMonthlyReportData(exams, topicRows, monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey))) {
    throw new Error('Rapor için geçerli bir ay seçmelisin.')
  }

  const monthExams = (exams || [])
    .filter((exam) => String(exam.dateValue || '').startsWith(`${monthKey}-`))
    .map((exam) => ({
      id: exam.id,
      date: exam.dateValue,
      subject: exam.subject,
      name: exam.name,
      correct: numeric(exam.correct),
      wrong: numeric(exam.wrong),
      blank: numeric(exam.blank),
      net: numeric(exam.net ?? (numeric(exam.correct) - numeric(exam.wrong) / 4)),
      createdAt: exam.createdAt || '',
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)))

  const examIds = new Set(monthExams.map((exam) => exam.id))
  const relevantTopicRows = (topicRows || []).filter((row) => examIds.has(row.exam_id))

  const summary = monthExams.reduce((total, exam) => ({
    examCount: total.examCount + 1,
    correct: total.correct + exam.correct,
    wrong: total.wrong + exam.wrong,
    blank: total.blank + exam.blank,
  }), { examCount: 0, correct: 0, wrong: 0, blank: 0 })

  const subjectStats = REPORT_SUBJECTS.map((subject) => {
    const subjectExams = monthExams.filter((exam) => exam.subject === subject)
    const subjectExamIds = new Set(subjectExams.map((exam) => exam.id))
    const topicMap = new Map()

    relevantTopicRows
      .filter((row) => subjectExamIds.has(row.exam_id))
      .forEach((row) => {
        const name = String(row.topic_name || '').trim()
        if (!name) return
        const key = name.toLocaleLowerCase('tr-TR')
        const existing = topicMap.get(key) || { name, wrong: 0, blank: 0 }
        existing.wrong += numeric(row.wrong_count)
        existing.blank += numeric(row.blank_count)
        topicMap.set(key, existing)
      })

    const topics = [...topicMap.values()]
      .map((topic) => ({ ...topic, total: topic.wrong + topic.blank }))
      .filter((topic) => topic.total > 0)
      .sort((a, b) => b.total - a.total || b.wrong - a.wrong || a.name.localeCompare(b.name, 'tr'))
      .slice(0, 7)

    return {
      subject,
      examCount: subjectExams.length,
      correct: subjectExams.reduce((sum, exam) => sum + exam.correct, 0),
      wrong: subjectExams.reduce((sum, exam) => sum + exam.wrong, 0),
      blank: subjectExams.reduce((sum, exam) => sum + exam.blank, 0),
      topics,
    }
  })

  const weeklyMap = new Map()
  monthExams.forEach((exam) => {
    const period = studyPeriodForDate(exam.date)
    const current = weeklyMap.get(period.key) || {
      key: period.key,
      sortKey: period.sortKey,
      periodType: period.periodType,
      start: period.start,
      end: period.end,
      label: period.label,
      examCount: 0,
      correct: 0,
      wrong: 0,
      blank: 0,
    }
    current.examCount += 1
    current.correct += exam.correct
    current.wrong += exam.wrong
    current.blank += exam.blank
    weeklyMap.set(period.key, current)
  })

  const orderedPeriods = [...weeklyMap.values()].sort((a, b) => (
    a.sortKey.localeCompare(b.sortKey) || (a.periodType === 'study' ? -1 : 1)
  ))
  let previousStudyPeriod = null
  const weeklyTrend = orderedPeriods.map((period) => {
    if (period.periodType === 'monday') {
      return { ...period, change: null }
    }
    const previous = previousStudyPeriod
    previousStudyPeriod = period
    return {
      ...period,
      change: previous ? {
        examCount: period.examCount - previous.examCount,
        correct: period.correct - previous.correct,
        wrong: period.wrong - previous.wrong,
        blank: period.blank - previous.blank,
      } : null,
    }
  })

  return {
    version: 1,
    monthKey,
    monthLabel: monthLabel(monthKey),
    generatedAt: new Date().toISOString(),
    summary,
    subjects: subjectStats,
    weeklyTrend,
    exams: monthExams,
    weeklyNote: 'Haftalık karşılaştırma Salı-Pazar çalışma dönemlerini esas alır. Pazartesi günündeki kayıtlar ayrıca kontrol günü olarak gösterilir. Pazartesi kayıtları aylık toplamların içindedir.',
  }
}

export function formatReportNumber(value, decimals = 0) {
  return new Intl.NumberFormat('tr-TR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(numeric(value))
}

export function formatReportDate(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  if (!year || !month || !day) return dateKey || '—'
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(year, month - 1, day))
}
