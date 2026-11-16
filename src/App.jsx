import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { optimise } from '@jsquash/oxipng'
import { Upload } from 'tus-js-client'
import { supabase } from './lib/supabaseClient'
import './App.css'
import './weekly-analytics.css'
import './monthly-reports.css'
import { buildMonthlyReportData, formatReportDate, formatReportNumber } from './monthly-report-data'
import { downloadMonthlyReportDocx } from './monthly-report-docx'
import { createBackupZip, readBackupZip, formatBytes } from './backup-archive'
import './backup-storage.css'
import DailyActivitiesPlanner from './DailyActivitiesPlanner'

const subjects = [
  'AYT Matematik', 'AYT Fizik', 'AYT Kimya', 'AYT Biyoloji',
  'TYT Matematik', 'TYT Türkçe', 'TYT Fen', 'TYT Sosyal',
]

const ADMIN_SESSION_KEY = 'deneme-analiz-admin-token'
const IMAGE_BUCKET = 'da-question-images'
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

function formatDate(dateValue) {
  if (!dateValue) return 'Tarih belirtilmedi'
  const [year, month, day] = String(dateValue).split('-').map(Number)
  if (!year || !month || !day) return String(dateValue)
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(year, month - 1, day))
}

function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayDateValue() {
  return localDateKey(new Date())
}

function mapExam(row) {
  return {
    id: row.id,
    subject: row.subject,
    name: row.title,
    date: formatDate(row.exam_date),
    dateValue: row.exam_date,
    createdAt: row.created_at ?? '',
    correct: Number(row.correct_count ?? 0),
    wrong: Number(row.wrong_count ?? 0),
    blank: Number(row.blank_count ?? 0),
    net: Number(row.net ?? (Number(row.correct_count ?? 0) - Number(row.wrong_count ?? 0) / 4)),
    notes: row.notes ?? '',
    topics: [],
    questions: [],
  }
}

function mapQuestion(row) {
  return {
    id: row.id,
    number: row.question_number,
    topic: row.topic_name || 'Konu belirtilmedi',
    status: row.status === 'wrong' ? 'Yanlış' : 'Boş',
    reason: row.error_type || 'Hata nedeni belirtilmedi',
    note: row.note || '',
    needsReview: Boolean(row.needs_review),
    images: [],
  }
}

function netOf(exam) {
  const value = Number.isFinite(exam.net)
    ? exam.net
    : exam.correct - exam.wrong / 4
  return value.toFixed(2).replace('.', ',')
}

function subjectCode(subject) {
  const [examType = '', ...branchParts] = String(subject || '').trim().split(/\s+/)
  const branchInitial = branchParts.join(' ').charAt(0)
  return `${examType.charAt(0).toLocaleUpperCase('tr-TR')}-${branchInitial.toLocaleUpperCase('tr-TR')}`
}

function getPublicImageUrl(storagePath) {
  const { data } = supabase.storage
    .from(IMAGE_BUCKET)
    .getPublicUrl(storagePath)
  return data?.publicUrl || ''
}

function createRowId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function getFunctionErrorMessage(error) {
  let message = error?.message || 'İşlem tamamlanamadı.'
  try {
    if (error?.context && typeof error.context.clone === 'function') {
      const response = error.context.clone()
      const payload = await response.json()
      if (payload?.error) message = payload.error
    }
  } catch {
    // Sunucu JSON döndürmediyse SDK'nın hata mesajı gösterilir.
  }
  return message
}

async function callAdminFunction(action, payload = {}, token = '') {
  const options = { body: { action, ...payload } }
  if (token) {
    options.headers = { Authorization: `Bearer ${token}` }
  }

  const { data, error } = await supabase.functions.invoke('admin-api', options)
  if (error) throw new Error(await getFunctionErrorMessage(error))
  if (!data?.ok) throw new Error(data?.error || 'Sunucu işlemi başarısız oldu.')
  return data
}

// PNG dosyalarında yalnızca kayıpsız optimizasyon uygulanır. JPEG ve WebP dosyaları
// yeniden kodlanmaz; görsel kalite kaybı riski almamak için orijinal byte'lar korunur.
async function optimizeImageWithoutQualityLoss(file) {
  if (file.type !== 'image/png') return file

  try {
    const optimizedBuffer = await optimise(await file.arrayBuffer(), {
      level: 3,
      optimiseAlpha: false,
    })
    const optimizedBlob = new Blob([optimizedBuffer], { type: 'image/png' })
    if (optimizedBlob.size > 0 && optimizedBlob.size < file.size) {
      return new File([optimizedBlob], file.name, {
        type: 'image/png',
        lastModified: file.lastModified,
      })
    }
  } catch (error) {
    console.warn('Kayıpsız PNG optimizasyonu uygulanamadı; orijinal dosya kullanılacak.', error)
  }

  return file
}

function uploadResumableFile(path, signedToken, file, upsert = false) {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL
  const projectRef = new URL(configuredUrl).hostname.split('.')[0]
  const endpoint = `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable/sign`

  return new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { 'x-signature': signedToken, ...(upsert ? { 'x-upsert': 'true' } : {}) },
      metadata: {
        bucketName: IMAGE_BUCKET,
        objectName: path,
        contentType: file.type,
        cacheControl: '3600',
      },
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onError: reject,
      onSuccess: resolve,
    })

    upload.start()
  })
}

async function uploadQuestionImage(questionId, file, token) {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new Error(`${file.name}: Yalnızca JPG, PNG veya WebP görselleri yüklenebilir.`)
  }

  // Yalnızca kayıpsız PNG optimizasyonu denenir. Küçülmezse veya işlem başarısızsa
  // orijinal dosya aynen yüklenir. JPEG ve WebP hiçbir şekilde yeniden kodlanmaz.
  const optimizedFile = await optimizeImageWithoutQualityLoss(file)
  const uploadTicket = await callAdminFunction('create_image_upload', {
    question_id: questionId,
    original_name: file.name,
    mime_type: optimizedFile.type,
    size_bytes: optimizedFile.size,
  }, token)

  try {
    await uploadResumableFile(uploadTicket.path, uploadTicket.token, optimizedFile)
  } catch (uploadError) {
    try {
      await callAdminFunction('cleanup_image_upload', {
        question_id: questionId,
        storage_path: uploadTicket.path,
      }, token)
    } catch (cleanupError) {
      console.error('Yükleme başarısızlığından sonra geçici dosya temizlenemedi:', cleanupError)
    }
    throw uploadError
  }

  try {
    await callAdminFunction('register_question_image', {
      question_id: questionId,
      storage_path: uploadTicket.path,
      original_name: file.name,
      mime_type: optimizedFile.type,
      size_bytes: optimizedFile.size,
    }, token)
  } catch (registerError) {
    try {
      await callAdminFunction('cleanup_image_upload', {
        question_id: questionId,
        storage_path: uploadTicket.path,
      }, token)
    } catch (cleanupError) {
      console.error('Görsel kaydı tamamlanamadı ve geçici dosya temizlenemedi:', cleanupError)
    }
    throw registerError
  }

  return {
    originalBytes: file.size,
    storedBytes: optimizedFile.size,
    wasOptimized: optimizedFile.size < file.size,
  }
}

function readStoredAdminToken() {
  try {
    const token = window.sessionStorage.getItem(ADMIN_SESSION_KEY)
    if (!token) return ''
    const parts = token.split('.')
    if (parts.length !== 3) {
      window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
      return ''
    }
    const payloadText = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payloadText.padEnd(Math.ceil(payloadText.length / 4) * 4, '=')
    const payload = JSON.parse(window.atob(padded))
    if (!payload.exp || payload.exp * 1000 <= Date.now()) {
      window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
      return ''
    }
    return token
  } catch {
    return ''
  }
}

// Haftalık analiz, kullanıcının çalışma düzenine göre Salı-Pazar aralığını kapsar.
// Pazartesi kontrol günüdür. Her kontrol pazartesisi bir önceki Salı-Pazar dönemini temsil eder.
function getMostRecentReviewMonday(referenceDate = new Date()) {
  const monday = new Date(referenceDate)
  monday.setHours(0, 0, 0, 0)
  const daysSinceMonday = (monday.getDay() + 6) % 7
  monday.setDate(monday.getDate() - daysSinceMonday)
  return monday
}

function getWeekRange(offset = 0) {
  const reviewMonday = getMostRecentReviewMonday()
  reviewMonday.setDate(reviewMonday.getDate() + (offset * 7))

  const start = new Date(reviewMonday)
  start.setDate(start.getDate() - 6) // Salı

  const end = new Date(reviewMonday)
  end.setDate(end.getDate() - 1) // Pazar

  return {
    start,
    end,
    reviewMonday,
    startKey: localDateKey(start),
    endKey: localDateKey(end),
    reviewMondayKey: localDateKey(reviewMonday),
  }
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' }).format(date)
}

function getReviewMondayForDate(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue || '')
  if (!match) return null

  const selectedDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  selectedDate.setHours(0, 0, 0, 0)
  const day = selectedDate.getDay()
  const daysUntilMonday = day === 1 ? 0 : (8 - day) % 7
  selectedDate.setDate(selectedDate.getDate() + daysUntilMonday)
  return selectedDate
}

function getDayDifference(fromDate, toDate) {
  const fromUtc = Date.UTC(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate())
  const toUtc = Date.UTC(toDate.getFullYear(), toDate.getMonth(), toDate.getDate())
  return Math.round((toUtc - fromUtc) / 86400000)
}

function App() {
  const [theme, setTheme] = useState('dark')
  const [activeSubject, setActiveSubject] = useState('Tüm Dersler')
  const [page, setPage] = useState('home')
  const [selectedExam, setSelectedExam] = useState(null)
  const [search, setSearch] = useState('')
  const [weekOffset, setWeekOffset] = useState(0)

  const [exams, setExams] = useState([])
  const [repeatQuestions, setRepeatQuestions] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [repeatError, setRepeatError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [adminToken, setAdminToken] = useState(readStoredAdminToken)
  const [showAdminLogin, setShowAdminLogin] = useState(false)
  const [showCreateExam, setShowCreateExam] = useState(false)
  const [showAddQuestion, setShowAddQuestion] = useState(false)
  const [showEditExam, setShowEditExam] = useState(false)
  const [reviewUpdatingId, setReviewUpdatingId] = useState('')
  const [adminSuccess, setAdminSuccess] = useState('')

  const loadExams = useCallback(async () => {
    setIsLoading(true)
    setLoadError('')
    setRepeatError('')

    try {
      const { data: examRows, error: examsError } = await supabase
        .from('da_exams')
        .select('id, subject, title, exam_date, correct_count, wrong_count, blank_count, net, notes, created_at')
        .order('exam_date', { ascending: false })
        .order('created_at', { ascending: false })

      if (examsError) throw examsError

      const mappedExams = (examRows || []).map(mapExam)
      setExams(mappedExams)

      const { data: reviewRows, error: reviewQueryError } = await supabase
        .from('da_questions')
        .select('id, exam_id, question_number, topic_name, status, error_type, note, needs_review, created_at')
        .eq('needs_review', true)
        .order('created_at', { ascending: false })

      if (reviewQueryError) {
        setRepeatError(reviewQueryError.message || 'Tekrar listesi yüklenemedi.')
        setRepeatQuestions([])
      } else {
        const examsById = new Map(mappedExams.map((exam) => [exam.id, exam]))
        const mappedReviewQuestions = (reviewRows || [])
          .map((row) => ({ ...mapQuestion(row), exam: examsById.get(row.exam_id) }))
          .filter((question) => question.exam)
        setRepeatQuestions(mappedReviewQuestions)
      }
    } catch (error) {
      console.error('Denemeler yüklenirken hata:', error)
      setLoadError(error?.message || 'Denemeler yüklenirken beklenmeyen bir hata oluştu.')
      setExams([])
      setRepeatQuestions([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadExams()
  }, [loadExams])

  // Gizli yönetici dizisi yalnızca ana sayfada ve metin alanlarının dışındayken dinlenir.
  useEffect(() => {
    if (adminToken || showAdminLogin || showCreateExam || page !== 'home') return undefined

    const sequence = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowLeft', 'ArrowRight']
    let progress = 0

    const handleKeyDown = (event) => {
      const target = event.target
      const tagName = target?.tagName?.toLowerCase()
      if (target?.isContentEditable || ['input', 'textarea', 'select'].includes(tagName)) {
        progress = 0
        return
      }

      if (event.code === sequence[progress]) {
        event.preventDefault()
        progress += 1
        if (progress === sequence.length) {
          progress = 0
          setShowAdminLogin(true)
        }
      } else {
        progress = event.code === sequence[0] ? 1 : 0
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [adminToken, showAdminLogin, showCreateExam, page])

  const visibleExams = useMemo(() => exams
    .filter((exam) => {
      const subjectMatch = activeSubject === 'Tüm Dersler' || exam.subject === activeSubject
      const searchText = `${exam.name} ${exam.subject}`.toLocaleLowerCase('tr-TR')
      const searchMatch = searchText.includes(search.toLocaleLowerCase('tr-TR'))
      return subjectMatch && searchMatch
    })
    .sort((a, b) => {
      const dateCompare = String(b.dateValue || '').localeCompare(String(a.dateValue || ''))
      if (dateCompare !== 0) return dateCompare
      return String(b.id).localeCompare(String(a.id))
    }), [exams, activeSubject, search])

  const allWrong = exams.reduce((sum, exam) => sum + exam.wrong, 0)
  const allBlank = exams.reduce((sum, exam) => sum + exam.blank, 0)

  // Ana sayfadaki "Bu hafta çözülen" sayısı da Salı-Pazar çalışma haftasını kullanır.
  const currentReviewRange = getWeekRange(0)
  const thisWeekCount = exams.filter((exam) => (
    exam.dateValue >= currentReviewRange.startKey && exam.dateValue <= currentReviewRange.endKey
  )).length

  const openExam = async (exam) => {
    setSelectedExam({ ...exam, topics: [], questions: [] })
    setPage('exam')
    setDetailLoading(true)
    setDetailError('')

    try {
      const [topicResult, questionResult] = await Promise.all([
        supabase
          .from('da_topic_results')
          .select('id, exam_id, topic_name, wrong_count, blank_count')
          .eq('exam_id', exam.id)
          .order('topic_name', { ascending: true }),
        supabase
          .from('da_questions')
          .select('id, exam_id, question_number, topic_name, status, error_type, note, needs_review, created_at')
          .eq('exam_id', exam.id)
          .order('created_at', { ascending: true }),
      ])

      if (topicResult.error) throw topicResult.error
      if (questionResult.error) throw questionResult.error

      const questionRows = questionResult.data || []
      const questionIds = questionRows.map((question) => question.id)
      let imageRows = []

      if (questionIds.length > 0) {
        const { data, error: imagesError } = await supabase
          .from('da_question_images')
          .select('id, question_id, storage_path, original_name, mime_type, size_bytes')
          .in('question_id', questionIds)
          .order('created_at', { ascending: true })

        if (imagesError) throw imagesError
        imageRows = data || []
      }

      const imagesByQuestion = new Map()
      imageRows.forEach((imageRow) => {
        const current = imagesByQuestion.get(imageRow.question_id) || []
        current.push({
          id: imageRow.id,
          name: imageRow.original_name,
          url: getPublicImageUrl(imageRow.storage_path),
          storagePath: imageRow.storage_path,
          sizeBytes: Number(imageRow.size_bytes || 0),
        })
        imagesByQuestion.set(imageRow.question_id, current)
      })

      const topics = (topicResult.data || []).map((topic) => ({
        id: topic.id,
        name: topic.topic_name,
        wrong: Number(topic.wrong_count || 0),
        blank: Number(topic.blank_count || 0),
      }))

      const questions = questionRows.map((row) => ({
        ...mapQuestion(row),
        images: imagesByQuestion.get(row.id) || [],
      }))

      setSelectedExam({ ...exam, topics, questions })
    } catch (error) {
      console.error('Deneme ayrıntıları yüklenirken hata:', error)
      setDetailError(error?.message || 'Deneme ayrıntıları yüklenirken bir hata oluştu.')
    } finally {
      setDetailLoading(false)
    }
  }

  const goHome = () => {
    setPage('home')
    setSelectedExam(null)
    setDetailError('')
  }

  // Tema düğmesine hızlıca 6 kez dokunulursa yönetici girişi açılır.
const themeAdminTapRef = useRef({ count: 0, lastTap: 0 })

const handleThemeButtonPress = () => {
  setTheme((current) => current === 'dark' ? 'light' : 'dark')

  if (adminToken || showAdminLogin) return

  const now = Date.now()
  const taps = themeAdminTapRef.current

  if (now - taps.lastTap > 2500) {
    taps.count = 0
  }

  taps.count += 1
  taps.lastTap = now

  if (taps.count >= 6) {
    taps.count = 0
    setShowAdminLogin(true)
  }
}

  const handleAdminLogin = async (password) => {
    const result = await callAdminFunction('login', { password })
    if (!result.token) throw new Error('Sunucu oturum anahtarı döndürmedi.')
    window.sessionStorage.setItem(ADMIN_SESSION_KEY, result.token)
    setAdminToken(result.token)
    setShowAdminLogin(false)
    setAdminSuccess('Yönetici modu açıldı.')
  }

  const handleAdminLogout = () => {
    window.sessionStorage.removeItem(ADMIN_SESSION_KEY)
    setAdminToken('')
    setShowCreateExam(false)
    setShowEditExam(false)
    setPage('home')
    setAdminSuccess('Yönetici modu kapatıldı.')
  }

  const handleCreateExam = async (formData) => {
    const { questionFiles = [], ...examPayload } = formData
    const result = await callAdminFunction('create_exam', examPayload, adminToken)
    const questionRefs = new Map((result.question_refs || []).map((item) => [item.client_ref, item.id]))
    const uploadProblems = []
    let optimizedCount = 0

    for (const item of questionFiles) {
      const questionId = questionRefs.get(item.clientRef)
      if (!questionId) {
        uploadProblems.push(`${item.files.length} fotoğraf: soru kaydı bulunamadı`)
        continue
      }
      for (const file of item.files) {
        try {
          const uploadResult = await uploadQuestionImage(questionId, file, adminToken)
          if (uploadResult.wasOptimized) optimizedCount += 1
        } catch (uploadError) {
          uploadProblems.push(`${file.name}: ${uploadError?.message || 'yüklenemedi'}`)
        }
      }
    }

    await loadExams()
    setActiveSubject('Tüm Dersler')
    setSearch('')
    setPage('home')
    setSelectedExam(null)
    setShowCreateExam(false)

    if (uploadProblems.length) {
      setAdminSuccess(`“${result.exam.title}” kaydedildi. ${uploadProblems.length} fotoğraf yüklenemedi.`)
      window.alert(`Deneme kaydedildi ancak bazı fotoğraflar yüklenemedi:\n\n${uploadProblems.join('\n')}\n\nFotoğrafları deneme ayrıntılarına girerek daha sonra ekleyebilirsin.`)
      console.error('Fotoğraf yükleme sorunları:', uploadProblems)
    } else {
      setAdminSuccess(`“${result.exam.title}” kaydedildi. ${result.questions_saved || 0} soru ve görselleri eklendi. ${optimizedCount} PNG kayıpsız optimize edildi.`)
    }
  }

  const handleAddQuestionImages = async (questionId, fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    if (!adminToken) throw new Error('Fotoğraf eklemek için yönetici modu açık olmalı.')

    const invalidFile = files.find((file) => !ACCEPTED_IMAGE_TYPES.has(file.type))
    if (invalidFile) throw new Error(`${invalidFile.name}: Yalnızca JPG, PNG ve WebP destekleniyor.`)
    let optimizedCount = 0
    const problems = []
    for (const file of files) {
      try {
        const result = await uploadQuestionImage(questionId, file, adminToken)
        if (result.wasOptimized) optimizedCount += 1
      } catch (error) {
        problems.push(`${file.name}: ${error?.message || 'yüklenemedi'}`)
      }
    }

    if (selectedExam) await openExam(selectedExam)
    if (problems.length) {
      setAdminSuccess(`${files.length - problems.length} fotoğraf yüklendi; ${problems.length} fotoğraf yüklenemedi.`)
      window.alert(`Fotoğraf yükleme sorunları:\n\n${problems.join('\n')}`)
      console.error('Fotoğraf yükleme sorunları:', problems)
    } else {
      setAdminSuccess(`${files.length} fotoğraf yüklendi. ${optimizedCount} PNG kayıpsız optimize edildi.`)
    }
  }

  const handleDeleteQuestionImage = async (image) => {
    if (!adminToken || !window.confirm(`“${image.name || 'Bu fotoğraf'}” kalıcı olarak silinsin mi?`)) return
    try {
      await callAdminFunction('delete_question_image', { image_id: image.id }, adminToken)
      if (selectedExam) await openExam(selectedExam)
      await loadExams()
      setAdminSuccess('Fotoğraf Storage alanından ve kayıt tablosundan silindi.')
    } catch (error) {
      window.alert(error?.message || 'Fotoğraf silinemedi.')
    }
  }

  const handleDeleteAllExamImages = async () => {
    if (!adminToken || !selectedExam) return
    const confirmation = window.prompt(`“${selectedExam.name}” denemesindeki TÜM fotoğrafları silmek için FOTOĞRAFLARI SİL yaz.`)
    if (confirmation !== 'FOTOĞRAFLARI SİL') return
    try {
      const result = await callAdminFunction('delete_exam_images', { exam_id: selectedExam.id }, adminToken)
      await openExam(selectedExam)
      await loadExams()
      setAdminSuccess(`${result.deleted_images || 0} fotoğraf kalıcı olarak silindi. Deneme ve net bilgileri korundu.`)
    } catch (error) {
      window.alert(error?.message || 'Fotoğraflar silinemedi.')
    }
  }

  const handleDeleteExam = async () => {
    if (!adminToken || !selectedExam) return
    const confirmed = window.confirm(
      `“${selectedExam.name}” denemesini, konu kayıtlarını, soru kayıtlarını ve tüm fotoğraflarını kalıcı olarak silmek istediğine emin misin? Bu işlem geri alınamaz.`,
    )
    if (!confirmed) return
    try {
      const result = await callAdminFunction('delete_exam', { exam_id: selectedExam.id }, adminToken)
      const deletedTitle = selectedExam.name
      setSelectedExam(null)
      setPage('home')
      await loadExams()
      setAdminSuccess(`“${deletedTitle}” denemesi ve ${result.deleted_images || 0} fotoğrafı kalıcı olarak silindi.`)
    } catch (error) {
      window.alert(error?.message || 'Deneme silinemedi.')
    }
  }

  const handleUpdateExam = async (formData) => {
    if (!adminToken || !selectedExam) throw new Error('Yönetici oturumu veya seçili deneme bulunamadı.')
    await callAdminFunction('update_exam', {
      exam_id: selectedExam.id,
      exam: formData.exam,
      topics: formData.topics,
    }, adminToken)

    const { data: updatedRow, error } = await supabase
      .from('da_exams')
      .select('id, subject, title, exam_date, correct_count, wrong_count, blank_count, net, notes, created_at')
      .eq('id', selectedExam.id)
      .single()
    if (error || !updatedRow) throw error || new Error('Güncellenen deneme yeniden okunamadı.')

    const updatedExam = mapExam(updatedRow)
    setShowEditExam(false)
    await loadExams()
    await openExam(updatedExam)
    setAdminSuccess(`“${updatedExam.name}” denemesi güncellendi.`)
  }

  const handleToggleQuestionReview = async (question) => {
    if (!adminToken || !question?.id || reviewUpdatingId) return
    setReviewUpdatingId(question.id)
    try {
      await callAdminFunction('set_question_review', {
        question_id: question.id,
        needs_review: !question.needsReview,
      }, adminToken)
      const examSnapshot = selectedExam
      await loadExams()
      if (examSnapshot) await openExam(examSnapshot)
      setAdminSuccess(question.needsReview ? 'Soru tekrar listesinden çıkarıldı.' : 'Soru tekrar listesine eklendi.')
    } catch (error) {
      window.alert(error?.message || 'Tekrar listesi güncellenemedi.')
    } finally {
      setReviewUpdatingId('')
    }
  }

  const handleAddQuestionToExam = async (formData) => {
    if (!adminToken || !selectedExam) throw new Error('Yönetici oturumu veya seçili deneme bulunamadı.')
    const { files = [], ...questionPayload } = formData
    const result = await callAdminFunction('add_question', {
      exam_id: selectedExam.id,
      question: questionPayload,
    }, adminToken)
    const questionId = result?.question?.id
    if (!questionId) throw new Error('Soru kaydedildi ancak sunucu soru kimliğini döndürmedi.')

    const uploadProblems = []
    let optimizedCount = 0
    for (const file of files) {
      try {
        const uploadResult = await uploadQuestionImage(questionId, file, adminToken)
        if (uploadResult.wasOptimized) optimizedCount += 1
      } catch (uploadError) {
        uploadProblems.push(`${file.name}: ${uploadError?.message || 'yüklenemedi'}`)
      }
    }

    const examSnapshot = selectedExam
    await openExam(examSnapshot)
    await loadExams()
    setShowAddQuestion(false)

    if (uploadProblems.length) {
      setAdminSuccess('Soru kaydedildi; bazı fotoğraflar yüklenemedi.')
      window.alert(`Soru kaydedildi ancak bazı fotoğraflar yüklenemedi:\n\n${uploadProblems.join('\n')}\n\nFotoğrafları aynı soru kartındaki “Fotoğraf seç” düğmesiyle tekrar ekleyebilirsin.`)
    } else {
      setAdminSuccess(`Soru kaydedildi. ${files.length} fotoğraf yüklendi; ${optimizedCount} PNG kayıpsız optimize edildi.`)
    }
  }

  return (
    <div className={`app-shell ${theme}`}>
      <header className="topbar">
        <button className="brand" onClick={goHome} aria-label="Ana sayfa; mobilde beş kez dokunarak yönetici girişini aç">
          <span className="brand-mark">D</span>
          <span className="brand-name">deneme<span>analiz</span></span>
        </button>
        <div className="topbar-actions">
          {adminToken ? (
            <>
              <span className="admin-mode-badge">YÖNETİCİ MODU</span>
              <button className="admin-action-button" onClick={() => setShowCreateExam(true)}>+ Deneme ekle</button>
              <button className="admin-exit-button" onClick={handleAdminLogout}>Modu kapat</button>
            </>
          ) : <span className="topbar-label">Kişisel arşiv</span>}
          <button
            className="theme-button"
            onClick={handleThemeButtonPress}
            title={theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç'}
            aria-label={theme === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç'}
          >
            <span>{theme === 'dark' ? '☼' : '☾'}</span>
            <small>{theme === 'dark' ? 'Açık tema' : 'Koyu tema'}</small>
          </button>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-label">MENÜ</div>
          <button className={`sidebar-link ${page === 'home' || page === 'exam' ? 'active' : ''}`} onClick={goHome}>
            <span className="nav-symbol">▤</span>
            <span>Denemeler</span>
            <span className="nav-chevron">›</span>
          </button>
          <button className={`sidebar-link ${page === 'repeat' ? 'active' : ''}`} onClick={() => { setPage('repeat'); setSelectedExam(null) }}>
            <span className="nav-symbol">↻</span>
            <span>Tekrar listesi</span>
            <span className="nav-count">{repeatQuestions.length}</span>
          </button>
          <button className={`sidebar-link ${page === 'weekly' ? 'active' : ''}`} onClick={() => { setPage('weekly'); setSelectedExam(null) }}>
            <span className="nav-symbol">▦</span>
            <span>Haftalık analiz</span>
            <span className="nav-chevron">›</span>
          </button>
          <button className={`sidebar-link ${page === 'monthly' ? 'active' : ''}`} onClick={() => { setPage('monthly'); setSelectedExam(null) }}>
            <span className="nav-symbol">▧</span>
            <span>Aylık raporlar</span>
            <span className="nav-chevron">›</span>
          </button>
          <button
          className={`sidebar-link ${page === 'daily' ? 'active' : ''}`}
          onClick={() => {
          setPage('daily')
          setSelectedExam(null)
            }}
           >
                <span className="nav-symbol">▤</span>
               <span>Günlük yapılanlar</span>
                <span className="nav-chevron">›</span>
               </button>
          {adminToken && (
            <button className={`sidebar-link ${page === 'backup' ? 'active' : ''}`} onClick={() => { setPage('backup'); setSelectedExam(null) }}>
              <span className="nav-symbol">⇧</span>
              <span>Yedek & depolama</span>
              <span className="nav-chevron">›</span>
            </button>
          )}
          <div className="sidebar-divider" />
          <div className="sidebar-footnote">Deneme arşivin<br />tek bir yerde.</div>
        </aside>

        <main className="workspace">
          {page === 'home' && (
            <>
              <section className="subject-section" aria-label="Ders filtreleri">
                <button className={`subject-chip ${activeSubject === 'Tüm Dersler' ? 'active' : ''}`} onClick={() => setActiveSubject('Tüm Dersler')}>Tüm denemeler</button>
                {subjects.map((subject) => (
                  <button key={subject} className={`subject-chip ${activeSubject === subject ? 'active' : ''}`} onClick={() => setActiveSubject(subject)}>{subject}</button>
                ))}
              </section>

              {activeSubject === 'Tüm Dersler' && (
                <section className="overview-stats-table" aria-label="Genel istatistikler">
                  <div className="overview-stats-heading">
                    <div>
                      <span className="section-kicker">GENEL İSTATİSTİKLER</span>
                      <h2>Deneme özeti</h2>
                    </div>
                    <span className="stats-period">Tüm dersler</span>
                  </div>
                  <div className="stats-table-wrap">
                    <table className="stats-table">
                      <thead>
                        <tr><th scope="col">Gösterge</th><th scope="col">Toplam</th></tr>
                      </thead>
                      <tbody>
                        <tr><th scope="row">Toplam deneme</th><td>{exams.length}</td></tr>
                        <tr><th scope="row">Bu hafta çözülen</th><td>{thisWeekCount}</td></tr>
                        <tr><th scope="row">Toplam yanlış</th><td>{allWrong}</td></tr>
                        <tr><th scope="row">Toplam boş</th><td>{allBlank}</td></tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="exam-section">
                <div className="list-toolbar">
                  <div className="list-title-wrap">
                    <h1>Denemeler</h1>
                    <span className="result-count">{visibleExams.length}</span>
                  </div>
                  <div className="list-toolbar-actions">
                    <label className="search-box">
                      <span>⌕</span>
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Deneme ara"
                        aria-label="Deneme ara"
                      />
                    </label>
                    {adminToken && <button className="admin-action-button list-add-button" onClick={() => setShowCreateExam(true)}>+ Deneme ekle</button>}
                  </div>
                </div>

                {adminSuccess && (
                  <div className="admin-success-banner" role="status">
                    <span>{adminSuccess}</span>
                    <button type="button" onClick={() => setAdminSuccess('')} aria-label="Bildirimi kapat">×</button>
                  </div>
                )}

                {isLoading ? (
                  <div className="empty-state">Denemeler Supabase üzerinden yükleniyor…</div>
                ) : loadError ? (
                  <div className="empty-state" role="alert">
                    <strong>Denemeler yüklenemedi.</strong>
                    <p>{loadError}</p>
                    <button className="back-button" onClick={loadExams}>Yeniden dene</button>
                  </div>
                ) : (
                  <div className="exam-list">
                    {visibleExams.length ? visibleExams.map((exam) => (
                      <ExamRow key={exam.id} exam={exam} onClick={() => openExam(exam)} />
                    )) : <div className="empty-state">Henüz kayıtlı deneme yok.</div>}
                  </div>
                )}
              </section>
            </>
          )}

          {page === 'repeat' && (
            <section className="subpage-section">
              <div className="subpage-heading">
                <div><span className="section-kicker">SORU TAKİBİ</span><h1>Tekrar listesi</h1></div>
                <span className="result-count">{repeatQuestions.length} soru</span>
              </div>
              <div className="repeat-list-panel">
                {repeatError ? (
                  <div className="empty-state" role="alert">Tekrar listesi yüklenemedi: {repeatError}</div>
                ) : repeatQuestions.length ? repeatQuestions.map((item) => (
                  <div className="repeat-row" key={item.id}>
                    <span className="repeat-dot">↻</span>
                    <div className="repeat-info">
                      <strong>{item.exam.subject} · {item.topic}</strong>
                      <span>{item.exam.name} · Soru {item.number ?? '—'}</span>
                    </div>
                    <span className={`status-tag ${item.status === 'Yanlış' ? 'wrong-tag' : ''}`}>{item.status}</span>
                    <button className="open-exam-link" onClick={() => openExam(item.exam)}>Denemeyi aç <span>→</span></button>
                  </div>
                )) : <div className="empty-state">Henüz tekrar için işaretlenmiş soru bulunmuyor.</div>}
              </div>
            </section>
          )}

          {page === 'weekly' && (
            <WeeklyAnalysisPage
              exams={exams}
              weekOffset={weekOffset}
              onWeekOffsetChange={setWeekOffset}
              adminToken={adminToken}
              onOpenExam={openExam}
            />
          )}

          {page === 'monthly' && (
            <MonthlyReportsPage
              exams={exams}
              adminToken={adminToken}
              onOpenExam={openExam}
            />
          )}
            {page === 'daily' && (
                 <section className="subpage-section daily-page">
                <DailyActivitiesPlanner adminToken={adminToken} />
               </section>
              )}
          {page === 'backup' && adminToken && (
            <BackupStoragePage
              adminToken={adminToken}
              onRestoreComplete={async () => {
                setSelectedExam(null)
                await loadExams()
                setPage('home')
                setAdminSuccess('Yedek geri yükleme tamamlandı. Deneme listesi yenilendi.')
              }}
            />
          )}

          {page === 'exam' && selectedExam && (
            <section className="subpage-section">
              <div className="subpage-heading exam-detail-heading">
                <div>
                  <span className="section-kicker">{selectedExam.subject} · {selectedExam.date}</span>
                  <h1>{selectedExam.name}</h1>
                </div>
                <button className="back-button" onClick={goHome}>← Denemeler</button>
              </div>

              {detailLoading ? (
                <div className="detail-panel empty-state">Deneme ayrıntıları yükleniyor…</div>
              ) : detailError ? (
                <div className="detail-panel empty-state" role="alert">
                  <strong>Deneme ayrıntıları yüklenemedi.</strong>
                  <p>{detailError}</p>
                  <button className="back-button" onClick={() => openExam(selectedExam)}>Yeniden dene</button>
                </div>
              ) : (
                <ExamDetail
                  exam={selectedExam}
                  isAdmin={Boolean(adminToken)}
                  onAddImages={handleAddQuestionImages}
                  onAddQuestion={() => setShowAddQuestion(true)}
                  onDeleteImage={handleDeleteQuestionImage}
                  onDeleteAllImages={handleDeleteAllExamImages}
                  onDeleteExam={handleDeleteExam}
                  onEditExam={() => setShowEditExam(true)}
                  onToggleReview={handleToggleQuestionReview}
                  reviewUpdatingId={reviewUpdatingId}
                />
              )}
            </section>
          )}
        </main>
      </div>

      {showAdminLogin && (
        <AdminLoginModal
          onClose={() => setShowAdminLogin(false)}
          onLogin={handleAdminLogin}
        />
      )}

      {showCreateExam && adminToken && (
        <CreateExamModal
          onClose={() => setShowCreateExam(false)}
          onSave={handleCreateExam}
        />
      )}

      {showAddQuestion && adminToken && selectedExam && (
        <AddQuestionModal
          exam={selectedExam}
          onClose={() => setShowAddQuestion(false)}
          onSave={handleAddQuestionToExam}
        />
      )}

      {showEditExam && adminToken && selectedExam && (
        <EditExamModal
          exam={selectedExam}
          onClose={() => setShowEditExam(false)}
          onSave={handleUpdateExam}
        />
      )}
    </div>
  )
}

function timestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

function triggerFileDownload(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function mimeTypeForStorageObject(item) {
  const supplied = String(item.mimeType || item.mime_type || '').toLowerCase()
  if (['image/jpeg', 'image/png', 'image/webp'].includes(supplied)) return supplied
  const extension = String(item.path || '').split('.').pop()?.toLowerCase()
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  throw new Error(`Yedekte desteklenmeyen görsel türü: ${item.path || 'bilinmeyen dosya'}`)
}

function validateBackupManifest(manifest, files) {
  if (!manifest || manifest.formatVersion !== 1 || !manifest.tables || !Array.isArray(manifest.storageObjects)) {
    throw new Error('Bu dosya Deneme Analiz V1 yedek biçiminde değil.')
  }
  // Eski V1 yedeklerinde günlük yapılanlar tablosu bulunmayabilir.
  if (!Array.isArray(manifest.tables.dailyActivities)) manifest.tables.dailyActivities = []
  const requiredTables = ['exams', 'topicResults', 'questions', 'questionImages', 'analysisNotes', 'weeklyNotes', 'monthlyReports', 'dailyActivities']
  for (const tableName of requiredTables) {
    if (!Array.isArray(manifest.tables[tableName])) throw new Error(`Yedekte “${tableName}” tablosu eksik.`)
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const examIds = new Set(manifest.tables.exams.map((row) => row?.id).filter((id) => typeof id === 'string' && uuidPattern.test(id)))
  if (examIds.size !== manifest.tables.exams.length) throw new Error('Yedekte geçersiz veya tekrarlanan deneme kimliği var.')
  const questionIds = new Set(manifest.tables.questions.map((row) => row?.id).filter((id) => typeof id === 'string' && uuidPattern.test(id)))
  if (questionIds.size !== manifest.tables.questions.length) throw new Error('Yedekte geçersiz veya tekrarlanan soru kimliği var.')
  if (manifest.tables.topicResults.some((row) => !examIds.has(row?.exam_id))) throw new Error('Konu kayıtlarından biri yedekte bulunmayan bir denemeye bağlı.')
  if (manifest.tables.questions.some((row) => !examIds.has(row?.exam_id))) throw new Error('Soru kayıtlarından biri yedekte bulunmayan bir denemeye bağlı.')
  if (manifest.tables.questionImages.some((row) => !questionIds.has(row?.question_id))) throw new Error('Görsel kaydı yedekte bulunmayan bir soruya bağlı.')

  const seenPaths = new Set()
  let totalImageBytes = 0
  for (const item of manifest.storageObjects) {
    if (!item || typeof item.path !== 'string' || item.path.includes('..') || item.path.startsWith('/')) {
      throw new Error('Yedekte geçersiz görsel yolu bulundu.')
    }
    const parts = item.path.split('/')
    if (parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(part)) || !/\.(jpg|jpeg|png|webp)$/i.test(parts[parts.length - 1] || '')) {
      throw new Error(`Yedekte geçersiz görsel yolu bulundu: ${item.path}`)
    }
    if (seenPaths.has(item.path)) throw new Error(`Yedekte aynı görsel birden fazla kez bulunuyor: ${item.path}`)
    seenPaths.add(item.path)
    const fileBytes = files.get(`storage/${item.path}`)
    if (!(fileBytes instanceof Uint8Array)) throw new Error(`Yedekte şu görsel dosyası eksik: ${item.path}`)
    if (Number.isFinite(Number(item.size)) && Number(item.size) !== fileBytes.byteLength) {
      throw new Error(`Yedekte şu görselin boyutu tutarsız: ${item.path}`)
    }
    mimeTypeForStorageObject(item)
    totalImageBytes += fileBytes.byteLength
  }

  for (const imageRow of manifest.tables.questionImages) {
    if (!seenPaths.has(imageRow.storage_path)) {
      throw new Error(`Görsel kaydı var ancak dosyası yedekte bulunamadı: ${imageRow.storage_path}`)
    }
  }

  return {
    examCount: manifest.tables.exams.length,
    topicCount: manifest.tables.topicResults.length,
    questionCount: manifest.tables.questions.length,
    imageRecordCount: manifest.tables.questionImages.length,
    storageFileCount: manifest.storageObjects.length,
    imageBytes: totalImageBytes,
    weeklyNoteCount: manifest.tables.weeklyNotes.length,
    monthlyReportCount: manifest.tables.monthlyReports.length,
  }
}

async function buildFullBackupArchive(adminToken, onProgress = () => {}) {
  onProgress('Veritabanı kayıtları ve görsel listesi alınıyor…')
  const response = await callAdminFunction('export_backup_snapshot', {}, adminToken)
  const snapshot = response.snapshot
  if (!snapshot || snapshot.format_version !== 1 || !snapshot.tables || !Array.isArray(snapshot.storage_objects)) {
    throw new Error('Sunucu yedek için beklenen verileri döndürmedi.')
  }

  const storageObjects = []
  const zipEntries = []
  const totalImages = snapshot.storage_objects.length
  let totalImageBytes = 0

  for (let index = 0; index < totalImages; index += 1) {
    const item = snapshot.storage_objects[index]
    onProgress(`Görseller indiriliyor: ${index + 1}/${totalImages} · ${item.path}`)
    const imageResponse = await fetch(item.signed_url)
    if (!imageResponse.ok) throw new Error(`Görsel indirilemedi (${imageResponse.status}): ${item.path}`)
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer())
    if (imageBytes.byteLength === 0) throw new Error(`Boş bir görsel dosyası bulundu: ${item.path}`)
    const mimeType = mimeTypeForStorageObject(item)
    totalImageBytes += imageBytes.byteLength
    storageObjects.push({ path: item.path, size: imageBytes.byteLength, mimeType })
    zipEntries.push({ name: `storage/${item.path}`, bytes: imageBytes })
  }

  const manifest = {
    formatVersion: 1,
    exportedAt: snapshot.exported_at || new Date().toISOString(),
    tables: snapshot.tables,
    storageObjects,
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  zipEntries.unshift({ name: 'backup.json', bytes: manifestBytes })
  zipEntries.push({
    name: 'README.txt',
    bytes: new TextEncoder().encode(
      'Deneme Analiz tam yedeği\n\nBu ZIP; deneme, konu, soru, görsel metaverisi, haftalık not, günlük yapılanlar, kalıcı not ve aylık rapor kayıtlarını içerir. storage/ klasörü soru görsellerinin orijinal dosyalarını barındırır.\n\nGeri yükleme yalnızca Deneme Analiz yönetici alanından yapılmalıdır. ZIP içeriğini değiştirmeyin.\n',
    ),
  })

  onProgress('ZIP yedeği hazırlanıyor…')
  const blob = await createBackupZip(zipEntries)
  return {
    blob,
    snapshot,
    summary: {
      examCount: snapshot.tables.exams.length,
      topicCount: snapshot.tables.topicResults.length,
      questionCount: snapshot.tables.questions.length,
      imageRecordCount: snapshot.tables.questionImages.length,
      storageFileCount: storageObjects.length,
      imageBytes: totalImageBytes,
      weeklyNoteCount: snapshot.tables.weeklyNotes.length,
      monthlyReportCount: snapshot.tables.monthlyReports.length,
    },
  }
}

function BackupStoragePage({ adminToken, onRestoreComplete }) {
  const [usage, setUsage] = useState(null)
  const [quotaMode, setQuotaMode] = useState('free')
  const [customQuotaGb, setCustomQuotaGb] = useState('1')
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState('')
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupProgress, setBackupProgress] = useState('')
  const [backupError, setBackupError] = useState('')
  const [backupNotice, setBackupNotice] = useState('')
  const [selectedBackup, setSelectedBackup] = useState(null)
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false)
  const [restoreSafetyAcknowledged, setRestoreSafetyAcknowledged] = useState(false)
  const [restoreReady, setRestoreReady] = useState(false)
  const [restoreSafetyPaths, setRestoreSafetyPaths] = useState([])
  const [restorePhrase, setRestorePhrase] = useState('')
  const [restoreProgress, setRestoreProgress] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const restoreInputRef = useRef(null)

  const quotaBytes = quotaMode === 'free'
    ? 1 * 1024 ** 3
    : quotaMode === 'pro'
      ? 100 * 1024 ** 3
      : Math.max(0.1, Number(customQuotaGb) || 0.1) * 1024 ** 3
  const usedBytes = Number(usage?.total_bytes || 0)
  const usedPercent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0
  const meterWidth = Math.min(100, Math.max(0, usedPercent))
  const meterTone = usedPercent >= 95 ? 'critical' : usedPercent >= 85 ? 'urgent' : usedPercent >= 70 ? 'warning' : 'normal'

  const refreshUsage = useCallback(async () => {
    if (!adminToken) return
    setUsageLoading(true)
    setUsageError('')
    try {
      const result = await callAdminFunction('get_storage_usage', {}, adminToken)
      setUsage(result.usage)
    } catch (error) {
      setUsageError(error?.message || 'Depolama kullanımı okunamadı.')
    } finally {
      setUsageLoading(false)
    }
  }, [adminToken])

  useEffect(() => {
    refreshUsage()
  }, [refreshUsage])

  const handleCreateBackup = async () => {
    if (!adminToken || backupBusy || restoreBusy) return
    setBackupBusy(true)
    setBackupError('')
    setBackupNotice('')
    setBackupProgress('Yedek hazırlığı başlıyor…')
    try {
      const result = await buildFullBackupArchive(adminToken, setBackupProgress)
      const fileName = `deneme-analiz-tam-yedek-${timestampForFileName()}.zip`
      triggerFileDownload(result.blob, fileName)
      setBackupNotice(
        `Tam yedek indirildi: ${result.summary.examCount} deneme, ${result.summary.questionCount} soru, ${result.summary.storageFileCount} görsel dosyası. Yedek boyutu ${formatBytes(result.blob.size)}.`,
      )
    } catch (error) {
      setBackupError(error?.message || 'Tam yedek oluşturulamadı.')
    } finally {
      setBackupBusy(false)
      setBackupProgress('')
    }
  }

  const handleBackupFileSelect = async (event) => {
    const file = event.target.files?.[0]
    setSelectedBackup(null)
    setRestoreAcknowledged(false)
    setRestoreSafetyAcknowledged(false)
    setRestoreReady(false)
    setRestoreSafetyPaths([])
    setRestorePhrase('')
    setRestoreError('')
    setBackupNotice('')
    if (!file) return

    try {
      if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Yalnızca Deneme Analiz ZIP yedek dosyasını seçmelisin.')
      const files = await readBackupZip(file)
      const manifestBytes = files.get('backup.json')
      if (!(manifestBytes instanceof Uint8Array)) throw new Error('ZIP içinde backup.json bulunamadı.')
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes))
      const summary = validateBackupManifest(manifest, files)
      setSelectedBackup({ fileName: file.name, manifest, files, summary, fileSize: file.size })
    } catch (error) {
      setRestoreError(error?.message || 'Yedek dosyası okunamadı.')
    } finally {
      event.target.value = ''
    }
  }

  const handleRestoreBackup = async () => {
    if (!adminToken || !selectedBackup || !restoreAcknowledged || restorePhrase.trim() !== 'TAM GERİ YÜKLE' || restoreBusy) return
    setRestoreBusy(true)
    setRestoreError('')
    setBackupNotice('')

    try {
      if (!restoreReady) {
        setRestoreProgress('Mevcut sistemin geri alma yedeği hazırlanıyor…')
        const currentBackup = await buildFullBackupArchive(adminToken, setRestoreProgress)
        triggerFileDownload(currentBackup.blob, `deneme-analiz-geri-alma-yedegi-${timestampForFileName()}.zip`)
        setRestoreSafetyPaths((currentBackup.snapshot.storage_objects || []).map((item) => item.path))
        setRestoreReady(true)
        setRestoreSafetyAcknowledged(false)
        setBackupNotice('Geri alma yedeği indirildi. İndirilen ZIP dosyasının bilgisayarında bulunduğunu kontrol et ve aşağıdaki onay kutusunu işaretle. Bundan sonra geri yükleme başlayacak.')
        return
      }
      if (!restoreSafetyAcknowledged) throw new Error('Devam etmeden önce geri alma yedeğinin indirildiğini ve saklandığını onaylamalısın.')

      const backup = selectedBackup
      const targetPaths = new Set(backup.manifest.storageObjects.map((item) => item.path))
      const oldPaths = restoreSafetyPaths

      for (let index = 0; index < backup.manifest.storageObjects.length; index += 1) {
        const item = backup.manifest.storageObjects[index]
        setRestoreProgress(`Görseller geri yükleniyor: ${index + 1}/${backup.manifest.storageObjects.length} · ${item.path}`)
        const fileBytes = backup.files.get(`storage/${item.path}`)
        const mimeType = mimeTypeForStorageObject(item)
        const fileName = item.path.split('/').pop()
        const file = new File([fileBytes], fileName, { type: mimeType, lastModified: Date.now() })
        const ticket = await callAdminFunction('create_restore_upload', {
          storage_path: item.path,
          mime_type: mimeType,
        }, adminToken)
        await uploadResumableFile(ticket.path, ticket.token, file, true)
      }

      setRestoreProgress('Eski tablo kayıtları temizleniyor…')
      await callAdminFunction('clear_backup_tables', {}, adminToken)

      const restoreOrder = [
        'exams', 'topicResults', 'questions', 'questionImages',
        'analysisNotes', 'weeklyNotes', 'monthlyReports', 'dailyActivities',
      ]
      for (const tableKey of restoreOrder) {
        const rows = backup.manifest.tables[tableKey]
        const batchSize = tableKey === 'monthlyReports' ? 1 : 100
        for (let start = 0; start < rows.length; start += batchSize) {
          const batch = rows.slice(start, start + batchSize)
          setRestoreProgress(`${tableKey} kayıtları geri yükleniyor: ${Math.min(start + batch.length, rows.length)}/${rows.length}`)
          await callAdminFunction('restore_backup_batch', { table_key: tableKey, rows: batch }, adminToken)
        }
      }

      const stalePaths = oldPaths.filter((path) => !targetPaths.has(path))
      for (let start = 0; start < stalePaths.length; start += 100) {
        const batch = stalePaths.slice(start, start + 100)
        setRestoreProgress(`Yedekte bulunmayan eski görseller temizleniyor: ${Math.min(start + batch.length, stalePaths.length)}/${stalePaths.length}`)
        await callAdminFunction('delete_old_restore_files', { storage_paths: batch }, adminToken)
      }

      setRestoreProgress('Geri yüklenen kayıtlar sayılıyor…')
      const verification = await callAdminFunction('verify_backup_restore', {}, adminToken)
      const expectedCounts = {
        exams: backup.summary.examCount,
        topicResults: backup.summary.topicCount,
        questions: backup.summary.questionCount,
        questionImages: backup.summary.imageRecordCount,
        analysisNotes: backup.manifest.tables.analysisNotes.length,
        weeklyNotes: backup.summary.weeklyNoteCount,
        monthlyReports: backup.summary.monthlyReportCount,
      }
      for (const [tableKey, expected] of Object.entries(expectedCounts)) {
        if (Number(verification.counts?.[tableKey] ?? -1) !== expected) {
          throw new Error(`${tableKey} tablosu doğrulanamadı. Beklenen ${expected}, bulunan ${verification.counts?.[tableKey] ?? 'bilinmiyor'}. Geri alma yedeği indirildi; gerekirse onu geri yükle.`)
        }
      }
      if (Number(verification.storage_file_count ?? -1) !== backup.summary.storageFileCount) {
        throw new Error(`Storage görsel sayısı doğrulanamadı. Beklenen ${backup.summary.storageFileCount}, bulunan ${verification.storage_file_count ?? 'bilinmiyor'}. Geri alma yedeği indirildi; gerekirse onu geri yükle.`)
      }

      setBackupNotice(`Geri yükleme tamamlandı. ${backup.summary.examCount} deneme, ${backup.summary.questionCount} soru ve ${backup.summary.storageFileCount} görsel dosyası geri yüklendi. Önceki verilerin güvenlik yedeği ayrıca indirildi.`)
      setSelectedBackup(null)
      setRestoreAcknowledged(false)
      setRestoreSafetyAcknowledged(false)
      setRestoreReady(false)
      setRestoreSafetyPaths([])
      setRestorePhrase('')
      await refreshUsage()
      await onRestoreComplete?.()
    } catch (error) {
      setRestoreError(
        `${error?.message || 'Geri yükleme tamamlanamadı.'} İşlem tablolar temizlendikten sonra kesildiyse, bu işlem başlamadan indirilen “geri alma yedeği” ZIP dosyasını seçerek önceki duruma dönebilirsin.`,
      )
    } finally {
      setRestoreBusy(false)
      setRestoreProgress('')
    }
  }

  if (!adminToken) {
    return <section className="subpage-section"><div className="empty-state">Bu bölüm yalnızca yönetici modunda açılabilir.</div></section>
  }

  return (
    <section className="subpage-section backup-page">
      <div className="subpage-heading backup-page-heading">
        <div><span className="section-kicker">YÖNETİCİ ARAÇLARI</span><h1>Yedekleme ve depolama</h1></div>
        <button type="button" className="monthly-secondary-button" onClick={refreshUsage} disabled={usageLoading || backupBusy || restoreBusy}>{usageLoading ? 'Ölçülüyor…' : '↻ Kullanımı yenile'}</button>
      </div>

      <section className={`detail-panel storage-usage-panel ${meterTone}`}>
        <div className="backup-panel-heading">
          <div><span className="section-kicker">SUPABASE STORAGE</span><h2>Görsel depolama kullanımı</h2></div>
          <span className={`storage-status-pill ${meterTone}`}>{usedPercent >= 95 ? 'Kritik seviye' : usedPercent >= 85 ? 'Yüksek kullanım' : usedPercent >= 70 ? 'Uyarı' : 'Normal'}</span>
        </div>
        {usageError && <div className="backup-alert error" role="alert">{usageError}</div>}
        <div className="storage-usage-numbers">
          <strong>{formatBytes(usedBytes)}</strong>
          <span>/ {formatBytes(quotaBytes)}</span>
          <b>{usedPercent.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}%</b>
        </div>
        <div className="storage-meter-track" role="progressbar" aria-label="Görsel depolama kullanımı" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, usedPercent)}>
          <span className={`storage-meter-fill ${meterTone}`} style={{ width: `${meterWidth}%` }} />
        </div>
        <div className="storage-meter-scale"><span>0</span><span>70% uyarı</span><span>85% yüksek</span><span>95% kritik</span><span>100%</span></div>
        <div className="storage-stat-grid">
          <div><span>Dosya sayısı</span><strong>{usageLoading && !usage ? '…' : (usage?.file_count ?? '—')}</strong></div>
          <div><span>Veritabanına bağlı görsel</span><strong>{usageLoading && !usage ? '…' : (usage?.registered_images ?? '—')}</strong></div>
          <div><span>Bağlantısız dosya</span><strong>{usageLoading && !usage ? '…' : (usage?.unregistered_files ?? '—')}</strong></div>
          <div><span>Dosyası eksik kayıt</span><strong>{usageLoading && !usage ? '…' : (usage?.missing_files ?? '—')}</strong></div>
        </div>
        <div className="storage-quota-controls">
          <label htmlFor="storage-quota-mode">Supabase planı</label>
          <select id="storage-quota-mode" value={quotaMode} onChange={(event) => setQuotaMode(event.target.value)}>
            <option value="free">Free · 1 GB</option>
            <option value="pro">Pro / Team · 100 GB</option>
            <option value="custom">Özel kota</option>
          </select>
          {quotaMode === 'custom' && <label className="storage-custom-quota"><input type="number" min="0.1" max="100000" step="0.1" value={customQuotaGb} onChange={(event) => setCustomQuotaGb(event.target.value)} /> GB</label>}
        </div>
        <p className="backup-footnote">Bu ölçüm yalnızca <b>da-question-images</b> kovasındaki gerçek dosyaları sayar. Seçtiğin kota, Supabase plan kotasına göre gösterge içindir; projendeki diğer Storage kovaları toplam kullanıma eklenebilir. Resmî toplam kullanım ve faturalandırma için Supabase Dashboard'daki Usage bölümü esas alınmalıdır.</p>
        {Number(usage?.missing_files || 0) > 0 && <div className="storage-warning urgent" role="alert">Bazı görsel kayıtlarının Storage dosyası bulunamadı. Tam yedek almadan önce bu kayıtları kontrol et.</div>}
        {usedPercent >= 70 && <div className={`storage-warning ${meterTone}`} role="status">{usedPercent >= 95 ? 'Depolama kotasının %95’ine ulaşıldı. Yeni görsel yüklemeden önce kullanımını kontrol et.' : usedPercent >= 85 ? 'Depolama kullanımı %85’i geçti. Eski görseller için yedek alıp temizlik planlaman iyi olur.' : 'Depolama kullanımı %70’i geçti. Kullanımı düzenli kontrol et.'}</div>}
      </section>

      <section className="detail-panel backup-download-panel">
        <div className="backup-panel-heading">
          <div><span className="section-kicker">TAM YEDEK</span><h2>Tüm verileri bilgisayarına indir</h2></div>
          <span className="backup-file-badge">ZIP</span>
        </div>
        <p>Yedek; denemeleri, branş konu sonuçlarını, tek tek yanlış/boş soru kayıtlarını, kalıcı ve haftalık notları, aylık rapor arşivini ve soru görsellerinin orijinal dosyalarını tek bir ZIP dosyasına koyar.</p>
        <div className="backup-includes-grid">
          <span>✓ Deneme ve net kayıtları</span><span>✓ Konu ve soru kayıtları</span>
          <span>✓ Soru görselleri (orijinal)</span><span>✓ Haftalık ve kalıcı notlar</span>
          <span>✓ Aylık rapor arşivi</span><span>✓ Görsel dosya bilgileri</span>
        </div>
        <button type="button" className="admin-action-button backup-primary-button" onClick={handleCreateBackup} disabled={backupBusy || restoreBusy}>{backupBusy ? 'Yedek hazırlanıyor…' : '↓ Tam yedek indir (.zip)'}</button>
        {backupProgress && <div className="backup-progress" role="status"><span className="backup-spinner" />{backupProgress}</div>}
        {backupError && <div className="backup-alert error" role="alert">{backupError}</div>}
        {backupNotice && <div className="backup-alert success" role="status">{backupNotice}</div>}
      </section>

      <section className="detail-panel backup-restore-panel">
        <div className="backup-panel-heading">
          <div><span className="section-kicker">YEDEKTEN GERİ DÖN</span><h2>ZIP yedeğini geri yükle</h2></div>
          <span className="backup-restore-badge">DİKKAT</span>
        </div>
        <p>Deneme Analiz tarafından indirilmiş bir ZIP yedeği seç. İçerik kontrol edildikten sonra yedekteki kayıtlar geri yüklenir. Mevcut verilerin üzerine yazılacağı için ilk adımda mevcut sistemin ayrı bir güvenlik yedeği indirilir. Dosyayı kontrol edip sakladığını onayladıktan sonra geri yükleme başlar.</p>
        <div className="backup-file-picker-row">
          <button type="button" className="monthly-secondary-button" onClick={() => restoreInputRef.current?.click()} disabled={backupBusy || restoreBusy}>ZIP yedeği seç</button>
          <span>{selectedBackup?.fileName || 'Henüz dosya seçilmedi'}</span>
          <input ref={restoreInputRef} type="file" accept=".zip,application/zip" onChange={handleBackupFileSelect} hidden />
        </div>
        {selectedBackup && (
          <div className="backup-preview-panel">
            <strong>Yedek dosyası doğrulandı</strong>
            <div className="backup-preview-grid">
              <span>Deneme <b>{selectedBackup.summary.examCount}</b></span>
              <span>Konu <b>{selectedBackup.summary.topicCount}</b></span>
              <span>Soru <b>{selectedBackup.summary.questionCount}</b></span>
              <span>Görsel dosyası <b>{selectedBackup.summary.storageFileCount}</b></span>
              <span>Haftalık not <b>{selectedBackup.summary.weeklyNoteCount}</b></span>
              <span>Aylık rapor <b>{selectedBackup.summary.monthlyReportCount}</b></span>
            </div>
            <small>Yedek tarihi: {new Date(selectedBackup.manifest.exportedAt).toLocaleString('tr-TR')} · Dosya boyutu: {formatBytes(selectedBackup.fileSize)} · Görseller: {formatBytes(selectedBackup.summary.imageBytes)}</small>
            <label className="backup-acknowledge"><input type="checkbox" checked={restoreAcknowledged} onChange={(event) => setRestoreAcknowledged(event.target.checked)} />Yedekteki kayıtların mevcut deneme arşivimin yerine geçeceğini anlıyorum.</label>
            <label className="backup-phrase-label" htmlFor="backup-restore-phrase">Devam etmek için <b>TAM GERİ YÜKLE</b> yaz.</label>
            <input id="backup-restore-phrase" className="backup-phrase-input" value={restorePhrase} onChange={(event) => setRestorePhrase(event.target.value)} placeholder="TAM GERİ YÜKLE" autoComplete="off" />
            {restoreReady && <label className="backup-acknowledge"><input type="checkbox" checked={restoreSafetyAcknowledged} onChange={(event) => setRestoreSafetyAcknowledged(event.target.checked)} />Geri alma ZIP yedeğinin bilgisayarıma indiğini kontrol ettim ve saklayacağım.</label>}
            <button type="button" className="monthly-danger-button backup-restore-button" onClick={handleRestoreBackup} disabled={!restoreAcknowledged || restorePhrase.trim() !== 'TAM GERİ YÜKLE' || (restoreReady && !restoreSafetyAcknowledged) || restoreBusy || backupBusy}>{restoreBusy ? (restoreReady ? 'Geri yükleniyor…' : 'Güvenlik yedeği hazırlanıyor…') : (restoreReady ? '2. Geri yüklemeyi başlat' : '1. Mevcut verilerin güvenlik yedeğini indir')}</button>
          </div>
        )}
        {restoreProgress && <div className="backup-progress" role="status"><span className="backup-spinner" />{restoreProgress}</div>}
        {restoreError && <div className="backup-alert error" role="alert">{restoreError}</div>}
        <div className="backup-restore-warning"><strong>Önemli:</strong> Geri yükleme sırasında tarayıcıyı kapatma veya internet bağlantısını kesme. İşlem kesilirse sayfanın indirdiği geri alma ZIP yedeğiyle önceki verileri geri yükleyebilirsin. Bu yedek dosyasını bilgisayarında sakla.</div>
      </section>
    </section>
  )
}


function WeeklyAnalysisPage({ exams, weekOffset, onWeekOffsetChange, adminToken, onOpenExam }) {
  const [selectedSubject, setSelectedSubject] = useState('AYT Matematik')
  const [expandedDayKey, setExpandedDayKey] = useState('')
  const [topicRows, setTopicRows] = useState([])
  const [topicLoading, setTopicLoading] = useState(false)
  const [topicError, setTopicError] = useState('')
  const [selectedTopic, setSelectedTopic] = useState('')
  const [topicQuestions, setTopicQuestions] = useState([])
  const [topicQuestionsLoading, setTopicQuestionsLoading] = useState(false)
  const [topicQuestionError, setTopicQuestionError] = useState('')
  const [permanentNote, setPermanentNote] = useState('')
  const [weeklyNote, setWeeklyNote] = useState('')
  const [notesLoading, setNotesLoading] = useState(true)
  const [notesError, setNotesError] = useState('')
  const [savingPermanent, setSavingPermanent] = useState(false)
  const [savingWeekly, setSavingWeekly] = useState(false)
  const [noteStatus, setNoteStatus] = useState('')
  const [annotatingImage, setAnnotatingImage] = useState(null)

  const range = useMemo(() => getWeekRange(weekOffset), [weekOffset])
  const rangeLabel = `${formatShortDate(range.start)} – ${formatShortDate(range.end)} ${range.end.getFullYear()}`
  const isCurrentWeek = weekOffset === 0
  const weekInputValue = range.reviewMondayKey
  const maxReviewMondayKey = getWeekRange(0).reviewMondayKey

  useEffect(() => {
    setExpandedDayKey('')
  }, [range.startKey, range.endKey])

  // Bu tarih aralığındaki tüm derslerin denemeleri. Günlük toplam sütunu bundan hesaplanır.
  const weeklyAllExams = useMemo(() => exams
    .filter((exam) => exam.dateValue >= range.startKey && exam.dateValue <= range.endKey)
    .sort((a, b) => String(a.dateValue).localeCompare(String(b.dateValue))),
  [exams, range.startKey, range.endKey])

  // Seçili branşın denemeleri; grafikler, konu dağılımı ve branş yanlış/boş sayıları bundan hesaplanır.
  const weeklyExams = useMemo(() => weeklyAllExams
    .filter((exam) => selectedSubject === 'Tüm Dersler' || exam.subject === selectedSubject),
  [weeklyAllExams, selectedSubject])

  const weeklyExamIdsKey = useMemo(
    () => weeklyExams.map((exam) => exam.id).sort().join(','),
    [weeklyExams],
  )

  useEffect(() => {
    let cancelled = false
    const ids = weeklyExamIdsKey ? weeklyExamIdsKey.split(',') : []
    setSelectedTopic('')
    setTopicQuestions([])
    setTopicError('')

    if (!ids.length) {
      setTopicRows([])
      setTopicLoading(false)
      return undefined
    }

    setTopicLoading(true)
    supabase
      .from('da_topic_results')
      .select('id, exam_id, topic_name, wrong_count, blank_count')
      .in('exam_id', ids)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setTopicError(error.message || 'Konu dağılımı alınamadı.')
          setTopicRows([])
        } else {
          setTopicRows(data || [])
        }
      })
      .catch((error) => {
        if (cancelled) return
        setTopicError(error?.message || 'Konu dağılımı alınamadı.')
        setTopicRows([])
      })
      .finally(() => {
        if (!cancelled) setTopicLoading(false)
      })

    return () => { cancelled = true }
  }, [weeklyExamIdsKey])

  useEffect(() => {
    let cancelled = false
    async function loadNotes() {
      setNotesLoading(true)
      setNotesError('')
      try {
        const [permanentResult, weeklyResult] = await Promise.all([
          supabase.from('da_analysis_notes').select('content').eq('id', 1).maybeSingle(),
          supabase.from('da_weekly_notes').select('content').eq('week_start', range.reviewMondayKey).maybeSingle(),
        ])
        if (permanentResult.error) throw permanentResult.error
        if (weeklyResult.error) throw weeklyResult.error
        if (!cancelled) {
          setPermanentNote(permanentResult.data?.content || '')
          setWeeklyNote(weeklyResult.data?.content || '')
        }
      } catch (error) {
        if (!cancelled) setNotesError(error?.message || 'Notlar yüklenemedi. Önce haftalık not tablolarının migration dosyasını çalıştır.')
      } finally {
        if (!cancelled) setNotesLoading(false)
      }
    }
    loadNotes()
    return () => { cancelled = true }
  }, [range.reviewMondayKey])

  useEffect(() => {
    let cancelled = false
    async function loadTopicQuestions() {
      if (!selectedTopic || !weeklyExamIdsKey) {
        setTopicQuestions([])
        setTopicQuestionError('')
        return
      }
      const ids = weeklyExamIdsKey.split(',')
      setTopicQuestionsLoading(true)
      setTopicQuestionError('')
      try {
        const { data: questionRows, error: questionError } = await supabase
          .from('da_questions')
          .select('id, exam_id, question_number, topic_name, status, error_type, note, needs_review')
          .in('exam_id', ids)
          .eq('topic_name', selectedTopic)
          .order('question_number', { ascending: true })
        if (questionError) throw questionError

        const questionIds = (questionRows || []).map((row) => row.id)
        let imagesByQuestion = new Map()
        if (questionIds.length) {
          const { data: imageRows, error: imageError } = await supabase
            .from('da_question_images')
            .select('id, question_id, storage_path, original_name')
            .in('question_id', questionIds)
          if (imageError) throw imageError
          imagesByQuestion = new Map()
          ;(imageRows || []).forEach((image) => {
            const current = imagesByQuestion.get(image.question_id) || []
            current.push({ id: image.id, name: image.original_name, url: getPublicImageUrl(image.storage_path) })
            imagesByQuestion.set(image.question_id, current)
          })
        }

        if (!cancelled) {
          setTopicQuestions((questionRows || []).map((question) => ({
            ...question,
            exam: weeklyExams.find((exam) => exam.id === question.exam_id),
            images: imagesByQuestion.get(question.id) || [],
          })))
        }
      } catch (error) {
        if (!cancelled) {
          setTopicQuestionError(error?.message || 'Konu soruları yüklenemedi.')
          setTopicQuestions([])
        }
      } finally {
        if (!cancelled) setTopicQuestionsLoading(false)
      }
    }
    loadTopicQuestions()
    return () => { cancelled = true }
  }, [selectedTopic, weeklyExamIdsKey])

  const summary = useMemo(() => {
    const totals = weeklyExams.reduce((sum, exam) => ({
      correct: sum.correct + exam.correct,
      wrong: sum.wrong + exam.wrong,
      blank: sum.blank + exam.blank,
    }), { correct: 0, wrong: 0, blank: 0 })

    const dailyNames = ['Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar']
    const daily = dailyNames.map((name, index) => {
      const date = new Date(range.start)
      date.setDate(date.getDate() + index)
      const key = localDateKey(date)
      const dayExams = weeklyExams.filter((exam) => exam.dateValue === key)
      const allDayExams = weeklyAllExams.filter((exam) => exam.dateValue === key)
      return {
        name,
        dateKey: key,
        dateLabel: formatShortDate(date),
        count: dayExams.length,
        totalCount: allDayExams.length,
        wrong: dayExams.reduce((sum, exam) => sum + exam.wrong, 0),
        blank: dayExams.reduce((sum, exam) => sum + exam.blank, 0),
        exams: allDayExams.slice().sort((a, b) => {
          // Önce branşları bir arada tut; aynı branşta en son eklenen deneme üstte olsun.
          const subjectOrderA = subjects.indexOf(a.subject)
          const subjectOrderB = subjects.indexOf(b.subject)
          const groupedOrder = (subjectOrderA < 0 ? Number.MAX_SAFE_INTEGER : subjectOrderA)
            - (subjectOrderB < 0 ? Number.MAX_SAFE_INTEGER : subjectOrderB)
          if (groupedOrder !== 0) return groupedOrder

          const createdOrder = String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
          if (createdOrder !== 0) return createdOrder
          return String(b.id).localeCompare(String(a.id))
        }),
      }
    })

    const topicMap = new Map()
    topicRows.forEach((row) => {
      const key = String(row.topic_name || 'Konu belirtilmedi').trim()
      const current = topicMap.get(key) || { name: key, wrong: 0, blank: 0, examIds: new Set() }
      current.wrong += Number(row.wrong_count || 0)
      current.blank += Number(row.blank_count || 0)
      current.examIds.add(row.exam_id)
      topicMap.set(key, current)
    })
    const topics = [...topicMap.values()]
      .filter((topic) => topic.wrong > 0 || topic.blank > 0)
      .sort((a, b) => (b.wrong + b.blank) - (a.wrong + a.blank) || b.wrong - a.wrong || a.name.localeCompare(b.name, 'tr'))
      .map((topic) => ({ ...topic, examCount: topic.examIds.size }))

    return { ...totals, daily, topics }
  }, [weeklyExams, weeklyAllExams, topicRows, range.start])

  const maxTopicTotal = Math.max(1, ...summary.topics.map((topic) => topic.wrong + topic.blank))
  const selectedTopicExams = selectedTopic
    ? weeklyExams.filter((exam) => topicRows.some((row) => row.exam_id === exam.id && row.topic_name === selectedTopic))
    : []

  const changeWeekFromPicker = (event) => {
    const reviewMonday = getReviewMondayForDate(event.target.value)
    if (!reviewMonday) return

    const currentReviewMonday = getWeekRange(0).reviewMonday
    const differenceInDays = getDayDifference(currentReviewMonday, reviewMonday)
    if (differenceInDays > 0 || differenceInDays % 7 !== 0) return

    onWeekOffsetChange(differenceInDays / 7)
  }

  const savePermanentNote = async () => {
    if (!adminToken || savingPermanent) return
    setSavingPermanent(true)
    setNotesError('')
    setNoteStatus('')
    try {
      await callAdminFunction('save_permanent_note', { content: permanentNote }, adminToken)
      setNoteStatus('Kalıcı not kaydedildi.')
    } catch (error) {
      setNotesError(error?.message || 'Kalıcı not kaydedilemedi.')
    } finally {
      setSavingPermanent(false)
    }
  }

  const saveWeeklyNote = async () => {
    if (!adminToken || savingWeekly) return
    setSavingWeekly(true)
    setNotesError('')
    setNoteStatus('')
    try {
      await callAdminFunction('save_weekly_note', { week_start: range.reviewMondayKey, content: weeklyNote }, adminToken)
      setNoteStatus('Bu haftanın değerlendirmesi kaydedildi.')
    } catch (error) {
      setNotesError(error?.message || 'Haftalık değerlendirme kaydedilemedi.')
    } finally {
      setSavingWeekly(false)
    }
  }

  const subjectLabel = selectedSubject === 'Tüm Dersler' ? 'Tüm dersler' : selectedSubject

  return (
    <section className="subpage-section weekly-page">
      <div className="subpage-heading weekly-page-heading">
        <div><span className="section-kicker">DENEME TAKİBİ</span><h1>Haftalık analiz</h1></div>
        <span className="result-count">{weeklyExams.length} deneme</span>
      </div>

      <section className="weekly-range-panel">
        <button type="button" className="weekly-range-button" onClick={() => onWeekOffsetChange((value) => value - 1)} aria-label="Önceki hafta">←</button>
        <div className="weekly-range-label">
          <strong>{rangeLabel}</strong>
          <small>{isCurrentWeek ? 'Pazartesi kontrolü · Son tamamlanan çalışma haftası' : `${formatShortDate(range.reviewMonday)} kontrolü`}</small>
          <input className="weekly-calendar-input" type="date" value={weekInputValue} max={maxReviewMondayKey} onChange={changeWeekFromPicker} aria-label="Haftalık kontrol pazartesisini takvimden seç" />
        </div>
        <button type="button" className="weekly-range-button" onClick={() => onWeekOffsetChange((value) => Math.min(0, value + 1))} disabled={isCurrentWeek} aria-label="Sonraki hafta">→</button>
        {!isCurrentWeek && <button type="button" className="weekly-current-button" onClick={() => onWeekOffsetChange(0)}>Bu haftaya dön</button>}
      </section>

      <section className="detail-panel weekly-daily-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">GÜN GÜN</span><h2>Haftanın çalışma dağılımı</h2></div>
          <span className="stats-period">Güne bas: A = AYT · T = TYT</span>
        </div>
        <div className="table-wrap">
          <table className="weekly-table weekly-daily-table">
            <thead><tr>
              <th>Gün</th>
              <th className="weekly-daily-total-heading">Toplam deneme</th>
              <th className="weekly-daily-subject-heading">{selectedSubject === 'Tüm Dersler' ? 'Seçili ders' : 'Seçili branş'}</th>
              <th>Yanlış</th>
              <th>Boş</th>
            </tr></thead>
            <tbody>{summary.daily.map((day) => {
              const isExpanded = expandedDayKey === day.dateKey
              return (
                <Fragment key={day.dateKey}>
                  <tr className={isExpanded ? 'weekly-day-row expanded' : 'weekly-day-row'}>
                    <th scope="row">
                      <button
                        type="button"
                        className="weekly-day-toggle"
                        onClick={() => setExpandedDayKey((current) => current === day.dateKey ? '' : day.dateKey)}
                        aria-expanded={isExpanded}
                        aria-controls={`weekly-day-exams-${day.dateKey}`}
                      >
                        <span className="weekly-day-name">{day.name}<small>{day.dateLabel}</small></span>
                        <span className={`weekly-day-chevron ${isExpanded ? 'open' : ''}`} aria-hidden="true">⌄</span>
                      </button>
                    </th>
                    <td className="weekly-daily-total-count">{day.totalCount}</td>
                    <td className="weekly-daily-subject-count">{day.count}</td>
                    <td>{day.wrong}</td>
                    <td>{day.blank}</td>
                  </tr>
                  {isExpanded && (
                    <tr className="weekly-day-details-row">
                      <td colSpan={5}>
                        <div className="weekly-day-details" id={`weekly-day-exams-${day.dateKey}`}>
                          {day.exams.length ? (
                            <div className="weekly-day-exam-list">
                              {day.exams.map((exam) => (
                                <button type="button" className="weekly-day-exam" key={exam.id} onClick={() => onOpenExam(exam)}>
                                  <span className="weekly-day-exam-code">{subjectCode(exam.subject)}</span>
                                  <span className="weekly-day-exam-name">{exam.name}</span>
                                  <span className="weekly-day-exam-stats">
                                    <span><b>{netOf(exam)}</b><small>Net</small></span>
                                    <span><b>{exam.wrong}</b><small>Yanlış</small></span>
                                    <span><b>{exam.blank}</b><small>Boş</small></span>
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="weekly-day-empty">Bu gün için kayıtlı deneme bulunmuyor.</div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}</tbody>
          </table>
        </div>
      </section>

      <section className="weekly-filter-panel">
        <label htmlFor="weekly-subject-select">Analiz edilecek ders</label>
        <select id="weekly-subject-select" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)}>
          <option value="Tüm Dersler">Tüm Dersler</option>
          {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
        <span>{subjectLabel} · {rangeLabel}</span>
      </section>

      <section className="weekly-metrics-grid" aria-label="Seçilen ders ve haftanın özeti">
        <div className="weekly-metric"><span>Deneme</span><strong>{weeklyExams.length}</strong></div>
        <div className="weekly-metric"><span>Doğru</span><strong>{summary.correct}</strong></div>
        <div className="weekly-metric wrong"><span>Yanlış</span><strong>{summary.wrong}</strong></div>
        <div className="weekly-metric blank"><span>Boş</span><strong>{summary.blank}</strong></div>
      </section>

      <section className="detail-panel weekly-topic-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">KONU BAZLI ANALİZ</span><h2>Bu hafta zorlandığın konular</h2></div>
          <span className="stats-period">Yanlış + boş</span>
        </div>
        <div className="weekly-chart-legend">
          <span><i className="legend-wrong" /> Yanlış</span>
          <span><i className="legend-blank" /> Boş</span>
        </div>
        {topicLoading ? (
          <div className="empty-state">Konu dağılımı yükleniyor…</div>
        ) : topicError ? (
          <div className="empty-state" role="alert">{topicError}</div>
        ) : summary.topics.length ? (
          <div className="weekly-topic-chart">
            {summary.topics.map((topic) => {
              const total = topic.wrong + topic.blank
              const totalWidth = (total / maxTopicTotal) * 100
              const wrongWidth = total ? (topic.wrong / total) * totalWidth : 0
              const blankWidth = total ? (topic.blank / total) * totalWidth : 0
              const isSelected = selectedTopic === topic.name
              return (
                <button type="button" key={topic.name} className={`weekly-topic-row ${isSelected ? 'selected' : ''}`} onClick={() => setSelectedTopic(isSelected ? '' : topic.name)}>
                  <span className="weekly-topic-name">{topic.name}</span>
                  <span className="weekly-topic-bar" aria-label={`${topic.wrong} yanlış, ${topic.blank} boş`}>
                    <span className="weekly-topic-bar-wrong" style={{ width: `${wrongWidth}%` }} />
                    <span className="weekly-topic-bar-blank" style={{ width: `${blankWidth}%` }} />
                  </span>
                  <span className="weekly-topic-counts"><b>{topic.wrong}</b><small>Y</small><b>{topic.blank}</b><small>B</small></span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="empty-state">Bu hafta {subjectLabel.toLocaleLowerCase('tr-TR')} için konu bazlı yanlış veya boş kaydı bulunmuyor.</div>
        )}
        {selectedTopic && (
          <div className="weekly-topic-drilldown">
            <div className="panel-heading">
              <div><span className="section-kicker">SEÇİLİ KONU</span><h3>{selectedTopic}</h3></div>
              <button className="weekly-current-button" type="button" onClick={() => setSelectedTopic('')}>Kapat</button>
            </div>
            {selectedTopicExams.length ? (
              <div className="weekly-topic-exam-list">
                {selectedTopicExams.map((exam) => (
                  <button type="button" className="weekly-topic-exam" key={exam.id} onClick={() => onOpenExam(exam)}>
                    <span><strong>{exam.name}</strong><small>{exam.subject} · {exam.date}</small></span>
                    <span>{topicRows.filter((row) => row.exam_id === exam.id && row.topic_name === selectedTopic).reduce((sum, row) => sum + Number(row.wrong_count || 0), 0)} yanlış · {topicRows.filter((row) => row.exam_id === exam.id && row.topic_name === selectedTopic).reduce((sum, row) => sum + Number(row.blank_count || 0), 0)} boş <b>→</b></span>
                  </button>
                ))}
              </div>
            ) : <div className="empty-state">Bu konu için deneme kaydı bulunamadı.</div>}
            {topicQuestionsLoading ? <div className="empty-state">İlgili sorular yükleniyor…</div> : topicQuestionError ? <div className="empty-state" role="alert">{topicQuestionError}</div> : topicQuestions.length ? (
              <div className="weekly-topic-questions">
                <h4>Bu haftaki ilgili soru kayıtları</h4>
                {topicQuestions.map((question) => (
                  <article className="weekly-topic-question" key={question.id}>
                    <div className="weekly-topic-question-heading">
                      <strong>{question.exam?.name || 'Deneme'} · Soru {question.question_number ?? '—'}</strong>
                      <span className={`status-tag ${question.status === 'wrong' ? 'wrong-tag' : ''}`}>{question.status === 'wrong' ? 'Yanlış' : 'Boş'}</span>
                    </div>
                    <small>{question.error_type || 'Hata nedeni belirtilmedi'}</small>
                    {question.note && <p>{question.note}</p>}
                    {question.images?.length > 0 && (
                      <div className="weekly-question-images">
                        {question.images.map((image) => (
                          <button type="button" key={image.id} onClick={() => setAnnotatingImage(image)} title="Geçici çizim alanında aç">
                            <img src={image.url} alt={image.name || 'Soru görseli'} loading="lazy" />
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </section>


      <section className="detail-panel weekly-note-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">HER ZAMAN ERİŞİLEBİLİR</span><h2>Kalıcı çalışma notlarım</h2></div>
          <span className="stats-period">Haftadan bağımsız</span>
        </div>
        {notesLoading ? <div className="empty-state">Notlar yükleniyor…</div> : (
          <>
            {adminToken ? (
              <>
                <textarea className="weekly-note-textarea" value={permanentNote} onChange={(event) => setPermanentNote(event.target.value)} maxLength={10000} placeholder="Sürekli hatırlamak istediğin konuları, hedeflerini ve çalışma notlarını yaz…" />
                <div className="weekly-note-actions"><span>{permanentNote.length}/10000 karakter</span><button type="button" className="admin-action-button" onClick={savePermanentNote} disabled={savingPermanent}>{savingPermanent ? 'Kaydediliyor…' : 'Kalıcı notu kaydet'}</button></div>
              </>
            ) : (
              <div className="weekly-note-readonly">{permanentNote || 'Henüz kalıcı not eklenmemiş.'}</div>
            )}
          </>
        )}
      </section>

      <section className="detail-panel weekly-note-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">{rangeLabel}</span><h2>Bu haftanın değerlendirmesi</h2></div>
          <span className="stats-period">Haftaya özel</span>
        </div>
        {notesLoading ? <div className="empty-state">Notlar yükleniyor…</div> : (
          <>
            {adminToken ? (
              <>
                <textarea className="weekly-note-textarea" value={weeklyNote} onChange={(event) => setWeeklyNote(event.target.value)} maxLength={6000} placeholder="Bu hafta neler iyi gitti? Hangi konulara tekrar çalışmalısın? Gelecek hafta hedefin ne?" />
                <div className="weekly-note-actions"><span>{weeklyNote.length}/6000 karakter</span><button type="button" className="admin-action-button" onClick={saveWeeklyNote} disabled={savingWeekly}>{savingWeekly ? 'Kaydediliyor…' : 'Haftalık değerlendirmeyi kaydet'}</button></div>
              </>
            ) : (
              <div className="weekly-note-readonly">{weeklyNote || 'Bu hafta için henüz değerlendirme yazılmamış.'}</div>
            )}
          </>
        )}
        {notesError && <div className="weekly-note-error" role="alert">{notesError}</div>}
        {noteStatus && <div className="weekly-note-status" role="status">{noteStatus}</div>}
      </section>
      {annotatingImage && (
        <TemporaryImageAnnotator
          image={annotatingImage}
          onClose={() => setAnnotatingImage(null)}
        />
      )}
    </section>
  )
}

function getCurrentMonthKey() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function monthLabelForUi(monthKey) {
  const [year, month] = String(monthKey || '').split('-').map(Number)
  if (!year || !month) return monthKey || 'Ay seçilmedi'
  return new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' })
    .format(new Date(year, month - 1, 1))
}

function MonthlyReportsPage({ exams, adminToken, onOpenExam }) {
  const [selectedMonth, setSelectedMonth] = useState(getCurrentMonthKey)
  const [archives, setArchives] = useState([])
  const [report, setReport] = useState(null)
  const [archivesLoading, setArchivesLoading] = useState(true)
  const [savingReport, setSavingReport] = useState(false)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [imageDeleteConfirmOpen, setImageDeleteConfirmOpen] = useState(false)
  const [deletingImages, setDeletingImages] = useState(false)
  const [archiveDeleteConfirmOpen, setArchiveDeleteConfirmOpen] = useState(false)
  const [deletingArchive, setDeletingArchive] = useState(false)
  const [pageError, setPageError] = useState('')
  const [pageNotice, setPageNotice] = useState('')

  const selectedMonthExams = useMemo(() => exams.filter((exam) => (
    String(exam.dateValue || '').startsWith(`${selectedMonth}-`)
  )), [exams, selectedMonth])

  useEffect(() => {
    let cancelled = false
    async function loadArchives() {
      setArchivesLoading(true)
      setPageError('')
      const { data, error } = await supabase
        .from('da_monthly_reports')
        .select('month_key, report_data, generated_at')
        .order('month_key', { ascending: false })
      if (cancelled) return
      if (error) {
        setPageError(`Aylık rapor arşivi yüklenemedi: ${error.message}. Önce aylık rapor SQL migration dosyasını Supabase üzerinde çalıştır.`)
        setArchives([])
      } else {
        setArchives(data || [])
      }
      setArchivesLoading(false)
    }
    loadArchives()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const saved = archives.find((item) => item.month_key === selectedMonth)
    setReport(saved?.report_data || null)
  }, [archives, selectedMonth])

  const handleSelectMonth = (monthKey) => {
    setSelectedMonth(monthKey)
    setCleanupOpen(false)
    setImageDeleteConfirmOpen(false)
    setArchiveDeleteConfirmOpen(false)
    setPageError('')
    setPageNotice('')
  }

  const handleGenerateReport = async () => {
    if (!adminToken) {
      setPageError('Aylık rapor oluşturmak için önce yönetici modunu açmalısın.')
      return
    }
    if (!selectedMonthExams.length) {
      setPageError(`${monthLabelForUi(selectedMonth)} için kayıtlı deneme bulunmuyor.`)
      return
    }
    const existing = archives.some((item) => item.month_key === selectedMonth)
    if (existing && !window.confirm(`${monthLabelForUi(selectedMonth)} arşivi zaten var. Yeniden oluşturup eski rapor özetinin üzerine yazmak istiyor musun?`)) {
      return
    }

    setSavingReport(true)
    setPageError('')
    setPageNotice('')
    try {
      const ids = selectedMonthExams.map((exam) => exam.id)
      const topicRows = []
      for (let start = 0; start < ids.length; start += 200) {
        const batchIds = ids.slice(start, start + 200)
        const { data, error } = await supabase
          .from('da_topic_results')
          .select('id, exam_id, topic_name, wrong_count, blank_count')
          .in('exam_id', batchIds)
        if (error) throw error
        topicRows.push(...(data || []))
      }

      const nextReport = buildMonthlyReportData(selectedMonthExams, topicRows, selectedMonth)
      const saveResult = await callAdminFunction('save_monthly_report', {
        month_key: selectedMonth,
        report_data: nextReport,
      }, adminToken)

      const archiveRow = {
        month_key: selectedMonth,
        report_data: saveResult.report?.report_data || nextReport,
        generated_at: saveResult.report?.generated_at || nextReport.generatedAt,
      }
      setArchives((current) => [archiveRow, ...current.filter((item) => item.month_key !== selectedMonth)]
        .sort((a, b) => String(b.month_key).localeCompare(String(a.month_key))))
      setReport(archiveRow.report_data)
      downloadMonthlyReportDocx(archiveRow.report_data)
      setCleanupOpen(true)
      setImageDeleteConfirmOpen(false)
      setPageNotice(`${monthLabelForUi(selectedMonth)} raporu arşivlendi ve Word dosyası indirildi.`)
    } catch (error) {
      console.error('Aylık rapor oluşturulamadı:', error)
      setPageError(error?.message || 'Aylık rapor oluşturulurken bir hata oluştu.')
    } finally {
      setSavingReport(false)
    }
  }

  const handleDownloadArchived = () => {
    if (!report) return
    try {
      downloadMonthlyReportDocx(report)
      setPageNotice('Arşivlenmiş Word raporu indirildi.')
    } catch (error) {
      setPageError(error?.message || 'Word dosyası oluşturulamadı.')
    }
  }

  const handleDeleteMonthImages = async () => {
    if (!adminToken || deletingImages) return
    setDeletingImages(true)
    setPageError('')
    try {
      const result = await callAdminFunction('delete_month_images', { month_key: selectedMonth }, adminToken)
      setPageNotice(`${monthLabelForUi(selectedMonth)} dönemi için ${result.deleted_images || 0} soru görseli silindi. Deneme, soru ve konu kayıtları korundu.`)
      setImageDeleteConfirmOpen(false)
      setCleanupOpen(false)
    } catch (error) {
      setPageError(error?.message || 'Soru görselleri silinemedi.')
    } finally {
      setDeletingImages(false)
    }
  }
  const handleDeleteMonthlyArchive = async () => {
  if (!adminToken || !report || deletingArchive) return

  setDeletingArchive(true)
  setPageError('')
  setPageNotice('')

  try {
    await callAdminFunction(
      'delete_monthly_report',
      { month_key: selectedMonth },
      adminToken,
    )

    setArchives((current) =>
      current.filter((item) => item.month_key !== selectedMonth)
    )

    setReport(null)
    setArchiveDeleteConfirmOpen(false)
    setCleanupOpen(false)
    setImageDeleteConfirmOpen(false)

    setPageNotice(
      `${monthLabelForUi(selectedMonth)} raporu arşivden silindi. Deneme, soru, konu ve görsel kayıtları korundu.`
    )
  } catch (error) {
    console.error('Aylık rapor arşivden silinemedi:', error)
    setPageError(
      error?.message || 'Aylık rapor arşivden silinemedi.'
    )
  } finally {
    setDeletingArchive(false)
  }
}
  const archivedMonths = archives.map((item) => item.month_key)
  const generatedLabel = report?.generatedAt
    ? new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.generatedAt))
    : ''

  return (
    <section className="subpage-section monthly-page">
      <div className="subpage-heading monthly-page-heading">
        <div><span className="section-kicker">AYLIK DEĞERLENDİRME</span><h1>Aylık raporlar</h1></div>
        <span className="result-count">{archives.length} arşiv</span>
      </div>

      <section className="monthly-selector-panel">
        <div className="monthly-selector-copy">
          <strong>Raporlanacak ay</strong>
          <span>Ay seçerek geçmiş raporları açabilir veya yönetici modunda yeni rapor oluşturabilirsin.</span>
        </div>
        <input
          type="month"
          value={selectedMonth}
          onChange={(event) => handleSelectMonth(event.target.value)}
          aria-label="Aylık rapor dönemi seç"
        />
      </section>

      <section className="detail-panel monthly-archive-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">KAYITLI RAPORLAR</span><h2>Aylık arşiv takvimi</h2></div>
          <span className="stats-period">{archivedMonths.length} ay</span>
        </div>
        {archivesLoading ? (
          <div className="empty-state">Aylık rapor arşivi yükleniyor…</div>
        ) : archivedMonths.length ? (
          <div className="monthly-archive-list">
            {archives.map((item) => (
              <button
                type="button"
                key={item.month_key}
                className={`monthly-archive-chip ${selectedMonth === item.month_key ? 'active' : ''}`}
                onClick={() => handleSelectMonth(item.month_key)}
              >
                <strong>{monthLabelForUi(item.month_key)}</strong>
                <small>{item.report_data?.summary?.examCount ?? 0} deneme</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="monthly-empty-archive">Henüz aylık rapor arşivi oluşturulmadı. İlk raporu yönetici modunda oluşturduğunda burada saklanacak.</div>
        )}
      </section>

      {pageError && <div className="monthly-alert error" role="alert">{pageError}</div>}
      {pageNotice && <div className="monthly-alert success" role="status">{pageNotice}</div>}

      {report ? (
        <>
          <section className="monthly-report-toolbar">
            <div>
              <span className="section-kicker">ARŞİVLENMİŞ RAPOR</span>
              <h2>{report.monthLabel} raporu</h2>
              {generatedLabel && <small>Arşiv oluşturulma: {generatedLabel}</small>}
            </div>
            <div className="monthly-report-actions">
              <button type="button" className="admin-action-button" onClick={handleDownloadArchived}>Word raporunu indir</button>
              {adminToken && (
  <button
    type="button"
    className="monthly-danger-button"
    onClick={() => setArchiveDeleteConfirmOpen(true)}
    disabled={deletingArchive}
  >
    Arşivden sil
  </button>
)}
              {adminToken && <button type="button" className="monthly-secondary-button" onClick={handleGenerateReport} disabled={savingReport}>{savingReport ? 'Hazırlanıyor…' : 'Güncel verilerle yeniden oluştur'}</button>}
            </div>
          </section>
          <MonthlyReportPreview report={report} onOpenExam={onOpenExam} />
        </>
      ) : (
        <section className="detail-panel monthly-no-report-panel">
          <span className="section-kicker">{monthLabelForUi(selectedMonth).toLocaleUpperCase('tr-TR')}</span>
          <h2>Bu ay için henüz rapor yok</h2>
          <p>{selectedMonthExams.length} deneme kaydı bulundu. Rapor oluşturulduğunda özet veritabanında arşivlenecek; daha sonra takvimden tekrar açılabilecek.</p>
          {adminToken ? (
            <button type="button" className="admin-action-button" onClick={handleGenerateReport} disabled={savingReport || archivesLoading || selectedMonthExams.length === 0}>
              {savingReport ? 'Rapor hazırlanıyor…' : 'Raporu oluştur ve Word indir'}
            </button>
          ) : (
            <p className="monthly-admin-hint">Rapor oluşturmak için gizli yönetici modunu açmalısın.</p>
          )}
        </section>
      )}

      

      {cleanupOpen && adminToken && (
        <div className="monthly-modal-backdrop" role="presentation">
          <section className="monthly-modal" role="dialog" aria-modal="true" aria-labelledby="monthly-cleanup-title">
            <span className="section-kicker">RAPOR ARŞİVLENDİ</span>
            <h2 id="monthly-cleanup-title">Son 1 aylık verileri silmek ister misiniz?</h2>
            <p>Word raporu indirildi ve aylık özet veritabanına kaydedildi. İstersen seçtiğin ayın soru görsellerini silebilirsin. Deneme adları, tarihler, netler, doğru/yanlış/boş sayıları, konu analizleri ve soru kayıtları korunur.</p>
            <div className="monthly-modal-actions vertical">
              <button type="button" className="monthly-secondary-button" onClick={() => setCleanupOpen(false)}>Hayır, tüm verileri koru</button>
              <button type="button" className="admin-action-button" onClick={() => setImageDeleteConfirmOpen(true)}>Evet, yalnızca soru görsellerini sil</button>
            </div>
            <small className="monthly-modal-footnote">Deneme ve soru kayıtlarının aylık toplu silinmesi bu sürümde kapalıdır. Önce yedekleme ve geri yükleme sistemini ayrıca test etmelisin.</small>
          </section>
        </div>
      )}

      {imageDeleteConfirmOpen && adminToken && (
        <div className="monthly-modal-backdrop" role="presentation">
          <section className="monthly-modal danger" role="dialog" aria-modal="true" aria-labelledby="monthly-delete-confirm-title">
            <span className="section-kicker">GERİ ALINAMAZ İŞLEM</span>
            <h2 id="monthly-delete-confirm-title">{monthLabelForUi(selectedMonth)} görselleri silinsin mi?</h2>
            <p>Bu işlem seçilen aya ait soru görsellerini Storage alanından ve görsel kayıtlarını veritabanından kaldırır. Deneme, soru ve konu analiz kayıtları ile aylık rapor arşivi kalır. Görseller geri getirilemez.</p>
            <div className="monthly-modal-actions">
              <button type="button" className="monthly-secondary-button" onClick={() => setImageDeleteConfirmOpen(false)} disabled={deletingImages}>İptal</button>
              <button type="button" className="monthly-danger-button" onClick={handleDeleteMonthImages} disabled={deletingImages}>{deletingImages ? 'Görseller siliniyor…' : 'Evet, görselleri sil'}</button>
            </div>

          </section>
        </div>
      )}

      {archiveDeleteConfirmOpen && adminToken && report && (
        <div className="monthly-modal-backdrop" role="presentation">
          <section
            className="monthly-modal danger"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-delete-title"
          >
            <span className="section-kicker">ARŞİV KAYDI SİLİNECEK</span>
            <h2 id="archive-delete-title">
              {monthLabelForUi(selectedMonth)} raporu silinsin mi?
            </h2>
            <p>
              Yalnızca seçilen ayın arşivlenmiş Word raporu özeti silinecek.
              Denemeler, soru kayıtları, konu analizleri, soru görselleri ve
              haftalık notlar korunacak. Bu işlem geri alınamaz.
            </p>
            <div className="monthly-modal-actions">
              <button
                type="button"
                className="monthly-secondary-button"
                onClick={() => setArchiveDeleteConfirmOpen(false)}
                disabled={deletingArchive}
              >
                Vazgeç
              </button>
              <button
                type="button"
                className="monthly-danger-button"
                onClick={handleDeleteMonthlyArchive}
                disabled={deletingArchive}
              >
                {deletingArchive ? 'Siliniyor…' : 'Evet, arşivden sil'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  )
}

function MonthlyReportPreview({ report, onOpenExam }) {
  return (
    <div className="monthly-report-content">
      <section className="monthly-summary-grid" aria-label="Aylık toplamlar">
        <div className="monthly-summary-card"><span>Toplam deneme</span><strong>{formatReportNumber(report.summary.examCount)}</strong></div>
        <div className="monthly-summary-card"><span>Doğru</span><strong>{formatReportNumber(report.summary.correct)}</strong></div>
        <div className="monthly-summary-card wrong"><span>Yanlış</span><strong>{formatReportNumber(report.summary.wrong)}</strong></div>
        <div className="monthly-summary-card blank"><span>Boş</span><strong>{formatReportNumber(report.summary.blank)}</strong></div>
      </section>

      <section className="detail-panel monthly-table-panel">
        <div className="panel-heading"><div><span className="section-kicker">DERS BAZINDA</span><h2>Performans özeti</h2></div></div>
        <div className="monthly-table-scroll"><table className="monthly-table">
          <thead><tr><th>Ders</th><th>Deneme</th><th>Doğru</th><th>Yanlış</th><th>Boş</th></tr></thead>
          <tbody>{report.subjects.map((item) => (
            <tr key={item.subject}><th>{item.subject}</th><td>{item.examCount}</td><td>{item.correct}</td><td>{item.wrong}</td><td>{item.blank}</td></tr>
          ))}</tbody>
        </table></div>
      </section>

      <section className="detail-panel monthly-table-panel">
        <div className="panel-heading"><div><span className="section-kicker">HAFTA HAFTA</span><h2>Haftalık değişim</h2></div><span className="stats-period">Salı-Pazar</span></div>
        <div className="monthly-table-scroll"><table className="monthly-table">
          <thead><tr><th>Dönem</th><th>Deneme</th><th>Doğru</th><th>Yanlış</th><th>Boş</th><th>Δ Deneme</th><th>Δ Doğru</th><th>Δ Yanlış</th><th>Δ Boş</th></tr></thead>
          <tbody>{report.weeklyTrend.map((week) => (
            <tr key={week.key}>
              <th>{week.label}</th><td>{week.examCount}</td><td>{week.correct}</td><td>{week.wrong}</td><td>{week.blank}</td>
              <td>{week.change ? `${week.change.examCount > 0 ? '+' : ''}${week.change.examCount}` : '—'}</td>
              <td>{week.change ? `${week.change.correct > 0 ? '+' : ''}${week.change.correct}` : '—'}</td>
              <td>{week.change ? `${week.change.wrong > 0 ? '+' : ''}${week.change.wrong}` : '—'}</td>
              <td>{week.change ? `${week.change.blank > 0 ? '+' : ''}${week.change.blank}` : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="monthly-table-note">{report.weeklyNote}</p>
      </section>

      <section className="monthly-difficulty-section">
        <div className="monthly-section-heading"><div><span className="section-kicker">YANLIŞ + BOŞ</span><h2>Zorlanılan konular</h2></div><span className="stats-period">Her derste en fazla 7 konu</span></div>
        <div className="monthly-subject-topic-grid">
          {report.subjects.map((subject) => (
            <article className="monthly-subject-topic-card" key={subject.subject}>
              <div className="monthly-subject-topic-heading"><h3>{subject.subject}</h3><small>{subject.examCount} deneme</small></div>
              {subject.topics.length ? (
                <div className="monthly-topic-list">{subject.topics.map((topic, index) => (
                  <div className="monthly-topic-item" key={`${subject.subject}-${topic.name}`}>
                    <span className="monthly-topic-rank">{index + 1}</span>
                    <span className="monthly-topic-title">{topic.name}</span>
                    <span className="monthly-topic-values"><b>{topic.wrong}</b><small>Y</small><b>{topic.blank}</b><small>B</small><strong>{topic.total}</strong></span>
                  </div>
                ))}</div>
              ) : <p className="monthly-topic-empty">Bu ay konu bazlı yanlış veya boş kaydı yok.</p>}
            </article>
          ))}
        </div>
      </section>

      <section className="detail-panel monthly-table-panel">
        <div className="panel-heading"><div><span className="section-kicker">KAYIT DETAYLARI</span><h2>Bu ay çözülen denemeler</h2></div><span className="stats-period">{report.exams.length} deneme</span></div>
        <div className="monthly-table-scroll"><table className="monthly-table monthly-exams-table">
          <thead><tr><th>Tarih</th><th>Ders</th><th>Deneme adı</th><th>Net</th><th>Doğru</th><th>Yanlış</th><th>Boş</th></tr></thead>
          <tbody>{report.exams.map((exam) => (
            <tr key={exam.id}>
              <td>{formatReportDate(exam.date)}</td><td>{exam.subject}</td>
              <td><button type="button" className="monthly-exam-open" onClick={() => onOpenExam({ id: exam.id, subject: exam.subject, name: exam.name, dateValue: exam.date, date: formatReportDate(exam.date), correct: exam.correct, wrong: exam.wrong, blank: exam.blank, net: exam.net, createdAt: exam.createdAt })}>{exam.name}</button></td>
              <td>{formatReportNumber(exam.net, 2)}</td><td>{exam.correct}</td><td>{exam.wrong}</td><td>{exam.blank}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
    </div>
  )
}


function TemporaryImageAnnotator({ image, onClose }) {
  const workspaceRef = useRef(null)
  const canvasRef = useRef(null)
  const strokesRef = useRef([])
  const activeStrokeRef = useRef(null)

  const [tool, setTool] = useState('pen')
  const [color, setColor] = useState('#e53935')
  const [strokeSize, setStrokeSize] = useState('3')
  const [canvasReady, setCanvasReady] = useState(false)
  const [screenTheme, setScreenTheme] = useState('white')
const [themeMenuOpen, setThemeMenuOpen] = useState(false)

const screenThemes = {
  white: {
    label: 'Beyaz',
    background: '#ffffff',
    panel: '#ffffff',
    canvas: '#ffffff',
    text: '#172033',
    muted: '#64748b',
    border: '#e2e8f0',
    control: '#f8fafc',
    swatch: '#ffffff',
  },
  black: {
    label: 'Siyah',
    background: '#080b12',
    panel: '#10141e',
    canvas: '#090d16',
    text: '#f8fafc',
    muted: '#a1a1aa',
    border: '#303744',
    control: '#1b2230',
    swatch: '#090d16',
  },
  navy: {
    label: 'Koyu mavi',
    background: '#101b2b',
    panel: '#142238',
    canvas: '#17263c',
    text: '#e6edf7',
    muted: '#a9b8cc',
    border: '#30445f',
    control: '#21334c',
    swatch: '#17263c',
  },
}

const activeTheme = screenThemes[screenTheme]

  // Tüm beyaz çalışma alanını çizim katmanına dönüştürür.
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const workspace = workspaceRef.current

    if (!canvas || !workspace) return

    const context = canvas.getContext('2d')
    const rect = workspace.getBoundingClientRect()

    if (!context || !rect.width || !rect.height) return

    context.clearRect(0, 0, rect.width, rect.height)

    for (const stroke of strokesRef.current) {
      if (!stroke.points.length) continue

      context.globalCompositeOperation =
        stroke.tool === 'eraser' ? 'destination-out' : 'source-over'

      context.strokeStyle = stroke.color
      context.fillStyle = stroke.color
      context.lineWidth = stroke.width
      context.lineCap = 'round'
      context.lineJoin = 'round'

      const first = stroke.points[0]
      const firstX = first.x * rect.width
      const firstY = first.y * rect.height

      if (stroke.points.length === 1) {
        context.beginPath()
        context.arc(firstX, firstY, stroke.width / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.beginPath()
        context.moveTo(firstX, firstY)

        for (let i = 1; i < stroke.points.length; i++) {
          const point = stroke.points[i]
          context.lineTo(
            point.x * rect.width,
            point.y * rect.height
          )
        }

        context.stroke()
      }
    }

    context.globalCompositeOperation = 'source-over'
  }, [])

  // Ekran boyutu değişirse çizim alanını yeniden ayarlar.
  const resizeCanvas = useCallback(() => {
    const workspace = workspaceRef.current
    const canvas = canvasRef.current

    if (!workspace || !canvas) return

    const rect = workspace.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const pixelRatio = window.devicePixelRatio || 1

    canvas.width = Math.round(rect.width * pixelRatio)
    canvas.height = Math.round(rect.height * pixelRatio)

    const context = canvas.getContext('2d')
    if (!context) return

    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    setCanvasReady(true)
    redrawCanvas()
  }, [redrawCanvas])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return undefined

    resizeCanvas()

    const handleResize = () => resizeCanvas()

    window.addEventListener('resize', handleResize)

    let observer

    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(handleResize)
      observer.observe(workspace)
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('keydown', handleKeyDown)

      observer?.disconnect()

      document.body.style.overflow = previousOverflow
    }
  }, [image?.url, onClose, resizeCanvas])

  // Fare veya dokunmatik kalem konumunu hesaplar.
  const getPoint = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()

    if (!rect.width || !rect.height) return null

    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    }
  }

  const startDrawing = (event) => {
    if (!canvasReady) return

    event.preventDefault()

    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const point = getPoint(event)

    if (!canvas || !context || !point) return

    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture desteklenmiyorsa çizim yine devam eder.
    }

    const stroke = {
      tool,
      color,
      width: tool === 'eraser'
        ? Math.max(18, Number(strokeSize) * 6)
        : Number(strokeSize),
      points: [point],
    }

    strokesRef.current.push(stroke)
    activeStrokeRef.current = stroke

    const rect = canvas.getBoundingClientRect()

    context.globalCompositeOperation =
      tool === 'eraser' ? 'destination-out' : 'source-over'

    context.fillStyle = color
    context.beginPath()
    context.arc(
      point.x * rect.width,
      point.y * rect.height,
      stroke.width / 2,
      0,
      Math.PI * 2
    )
    context.fill()

    context.globalCompositeOperation = 'source-over'
  }

  const continueDrawing = (event) => {
    const stroke = activeStrokeRef.current
    if (!stroke) return

    event.preventDefault()

    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    const point = getPoint(event)

    if (!canvas || !context || !point) return

    const previous = stroke.points[stroke.points.length - 1]
    stroke.points.push(point)

    const rect = canvas.getBoundingClientRect()

    context.globalCompositeOperation =
      stroke.tool === 'eraser' ? 'destination-out' : 'source-over'

    context.strokeStyle = stroke.color
    context.lineWidth = stroke.width
    context.lineCap = 'round'
    context.lineJoin = 'round'

    context.beginPath()
    context.moveTo(
      previous.x * rect.width,
      previous.y * rect.height
    )
    context.lineTo(
      point.x * rect.width,
      point.y * rect.height
    )
    context.stroke()

    context.globalCompositeOperation = 'source-over'
  }

  const stopDrawing = (event) => {
    if (!activeStrokeRef.current) return

    activeStrokeRef.current = null

    const context = canvasRef.current?.getContext('2d')
    if (context) {
      context.globalCompositeOperation = 'source-over'
    }

    try {
      if (event?.pointerId !== undefined) {
        canvasRef.current?.releasePointerCapture(event.pointerId)
      }
    } catch {
      // İşaretçi yakalaması zaten bırakılmış olabilir.
    }
  }

  const undoLastStroke = () => {
    if (!strokesRef.current.length) return

    strokesRef.current.pop()
    redrawCanvas()
  }

  const clearDrawing = () => {
    strokesRef.current = []
    activeStrokeRef.current = null
    redrawCanvas()
  }

  const buttonStyle = (active = false, close = false) => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 38,
    padding: '8px 12px',
    borderRadius: 9,
    border: active ? '1px solid #93c5fd' : '1px solid #cbd5e1',
    background: close ? '#b91c1c' : active ? '#1d4ed8' : '#f8fafc',
    color: close || active ? '#ffffff' : '#172033',
    fontSize: 13,
    fontWeight: 650,
    cursor: 'pointer',
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Geçici soru çözüm alanı"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
        color: '#172033',
        padding: 'max(8px, env(safe-area-inset-top)) 10px max(8px, env(safe-area-inset-bottom))',
        boxSizing: 'border-box',
      }}
    >
      {/* ÜST BAŞLIK VE KAPATMA */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          padding: '4px 2px 10px',
          background: '#ffffff',
        }}
      >
        <div>
          <strong style={{ display: 'block', fontSize: 16 }}>
            Geçici soru çözüm alanı
          </strong>

          <span style={{ display: 'block', marginTop: 3, fontSize: 12, color: '#64748b' }}>
            Görselin dışındaki beyaz alanı da kullanabilirsin.
            Çizimlerin kaydedilmez.
          </span>
        </div>

        <div style={{
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  position: 'relative'
}}>
  <button
    type="button"
    onClick={() => setThemeMenuOpen((open) => !open)}
    style={buttonStyle(themeMenuOpen)}
  >
    ◐ Renk
  </button>

  <button
    type="button"
    onClick={onClose}
    style={{ ...buttonStyle(false, true), minWidth: 86 }}
  >
    ✕ Kapat
  </button>

  {themeMenuOpen && (
    <div style={{
      position: 'absolute',
      top: 'calc(100% + 8px)',
      right: 0,
      zIndex: 20,
      minWidth: 160,
      padding: 7,
      border: `1px solid ${activeTheme.border}`,
      borderRadius: 12,
      background: activeTheme.panel,
      boxShadow: '0 12px 30px rgba(0,0,0,.25)'
    }}>
      {Object.entries(screenThemes).map(([key, option]) => (
        <button
          key={key}
          type="button"
          onClick={() => {
            setScreenTheme(key)
            setThemeMenuOpen(false)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: 10,
            marginBottom: 4,
            border: screenTheme === key
              ? '1px solid #3b82f6'
              : `1px solid ${activeTheme.border}`,
            borderRadius: 8,
            background: activeTheme.control,
            color: activeTheme.text,
            cursor: 'pointer'
          }}
        >
          <span style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: option.swatch,
            border: '1px solid #94a3b8'
          }} />
          {option.label}
          {screenTheme === key ? ' ✓' : ''}
        </button>
      ))}
    </div>
  )}
</div>
      </div>

      {/* KALEM VE SİLGİ ARAÇLARI */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: '9px 0 11px',
          background: '#ffffff',
        }}
      >
        <button
          type="button"
          onClick={() => setTool('pen')}
          aria-pressed={tool === 'pen'}
          style={buttonStyle(tool === 'pen')}
        >
          ✎ Kalem
        </button>

        <button
          type="button"
          onClick={() => setTool('eraser')}
          aria-pressed={tool === 'eraser'}
          style={buttonStyle(tool === 'eraser')}
        >
          ⌫ Silgi
        </button>

        <span style={{ width: 1, height: 26, background: '#cbd5e1' }} />

        {['#e53935', '#2563eb', '#16a34a', '#111827'].map((swatch) => (
          <button
            key={swatch}
            type="button"
            onClick={() => {
              setColor(swatch)
              setTool('pen')
            }}
            aria-label={`Kalem rengi ${swatch}`}
            aria-pressed={color === swatch && tool === 'pen'}
            style={{
              width: 27,
              height: 27,
              borderRadius: '50%',
              border: color === swatch && tool === 'pen'
                ? '3px solid #ffffff'
                : '2px solid #cbd5e1',
              background: swatch,
              cursor: 'pointer',
              boxShadow: color === swatch && tool === 'pen'
                ? '0 0 0 2px #2563eb'
                : 'none',
            }}
          />
        ))}

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: '#475569',
            fontSize: 12,
          }}
        >
          Kalınlık

          <select
            value={strokeSize}
            onChange={(event) => setStrokeSize(event.target.value)}
            style={{
              minHeight: 34,
              borderRadius: 8,
              padding: '4px 7px',
              color: '#0f172a',
              background: '#ffffff',
              border: '1px solid #cbd5e1',
            }}
          >
            <option value="2">İnce</option>
            <option value="3">Orta</option>
            <option value="6">Kalın</option>
          </select>
        </label>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          onClick={undoLastStroke}
          style={buttonStyle()}
        >
          ↶ Geri al
        </button>

        <button
          type="button"
          onClick={clearDrawing}
          style={buttonStyle()}
        >
          Temizle
        </button>
      </div>

      {/* TAM BEYAZ ÇALIŞMA ALANI */}
      <div
        ref={workspaceRef}
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflow: 'hidden',
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          boxSizing: 'border-box',
          touchAction: 'none',
        }}
      >
        {/* SORU GÖRSELİ */}
        <img
          src={image?.url}
          alt={image?.name || 'Soru görseli'}
          draggable="false"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />

        {/* ÇİZİM KATMANI: GÖRSELİN DIŞINDAKİ BEYAZ ALAN DAHİL */}
        <canvas
          ref={canvasRef}
          onPointerDown={startDrawing}
          onPointerMove={continueDrawing}
          onPointerUp={stopDrawing}
          onPointerCancel={stopDrawing}
          onLostPointerCapture={stopDrawing}
          aria-label="Tüm beyaz çalışma alanında geçici çizim katmanı"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'block',
            width: '100%',
            height: '100%',
            cursor: tool === 'eraser' ? 'cell' : 'crosshair',
            touchAction: 'none',
            userSelect: 'none',
          }}
        />
      </div>
    </div>
  )
}

function ExamRow({ exam, onClick }) {
  return (
    <button className="exam-row" onClick={onClick} type="button">
      <span className="exam-row-icon">▤</span>
      <span className="exam-main">
        <strong>{exam.name}</strong>
        <small>{exam.subject} <i /> {exam.date}</small>
      </span>
      <span className="exam-metrics">
        <strong>{netOf(exam)} <small>net</small></strong>
        <small>{exam.wrong} yanlış <i /> {exam.blank} boş</small>
      </span>
      <span className="row-arrow">→</span>
    </button>
  )
}

function ExamDetail({ exam, isAdmin, onAddImages, onAddQuestion, onDeleteImage, onDeleteAllImages, onDeleteExam, onEditExam, onToggleReview, reviewUpdatingId }) {
  const [annotatingImage, setAnnotatingImage] = useState(null)

  return (
    <div className="detail-layout">
      {isAdmin && (
        <section className="exam-admin-toolbar">
          <div><strong>Yönetici işlemleri</strong><small>Fotoğrafları denemeden bağımsız silebilir veya denemeyi tamamen kaldırabilirsin.</small></div>
          <div className="exam-admin-toolbar-actions">
            <button className="form-secondary-button" type="button" onClick={onEditExam}>Denemeyi düzenle</button>
            <button className="form-primary-button" type="button" onClick={onAddQuestion}>+ Yeni soru ve fotoğraf ekle</button>
            <button className="form-secondary-button" type="button" onClick={onDeleteAllImages}>Bütün fotoğrafları sil</button>
            <button className="exam-danger-button" type="button" onClick={onDeleteExam}>Denemeyi tamamen sil</button>
          </div>
        </section>
      )}
      <section className="detail-stat-strip">
        <StatCard label="Net" value={netOf(exam)} />
        <StatCard label="Doğru" value={String(exam.correct)} />
        <StatCard label="Yanlış" value={String(exam.wrong)} />
        <StatCard label="Boş" value={String(exam.blank)} />
      </section>

      <section className="detail-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">KONU ANALİZİ</span><h2>Yanlış ve boş dağılımı</h2></div>
          <span className="result-count">{exam.topics.length} konu</span>
        </div>
        {exam.topics.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Konu</th><th>Yanlış</th><th>Boş</th></tr></thead>
              <tbody>
                {exam.topics.map((topic) => (
                  <tr key={topic.id || topic.name}>
                    <td>{topic.name}</td>
                    <td><span className="table-number wrong-number">{topic.wrong}</span></td>
                    <td><span className="table-number blank-number">{topic.blank}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty-state">Bu deneme için henüz konu analizi kaydedilmemiş.</div>}
      </section>

      <section className="detail-panel">
        <div className="panel-heading">
          <div><span className="section-kicker">SORU ARŞİVİ</span><h2>Yanlış ve boş sorular</h2></div>
          <span className="result-count">{exam.questions.length} soru</span>
        </div>
        {exam.questions.length ? (
          <div className="question-grid">
            {exam.questions.map((question) => (
              <article className="question-card" key={question.id}>
                <div className="question-placeholder">
                  {question.images.length ? (
                    <div className="question-image-row">
                      {question.images.map((image) => (
                        <div className="question-image-item" key={image.id}>
                          <button
                            type="button"
                            onClick={() => setAnnotatingImage(image)}
                            title="Soruyu çizim alanında aç"
                            aria-label={`Soru ${question.number ?? ''} görselini çizim alanında aç`}
                            style={{ display: 'block', maxWidth: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'crosshair' }}
                          >
                            <img src={image.url} alt={image.name || `Soru ${question.number} görseli`} />
                          </button>
                          {isAdmin && <button className="photo-delete-button" type="button" onClick={() => onDeleteImage(image)} aria-label="Fotoğrafı sil" title="Fotoğrafı sil">×</button>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <span>GÖRSEL YOK</span>
                      <strong>{question.number ?? '—'}</strong>
                      <small>Bu soru için henüz görsel yüklenmemiş.</small>
                    </>
                  )}
                </div>
                <div className="question-card-body">
                  <div className="question-card-top">
                    <span className={`status-tag ${question.status === 'Yanlış' ? 'wrong-tag' : ''}`}>{question.status}</span>
                    <span className="topic-label">{question.topic}</span>
                  </div>
                  <strong>Soru {question.number ?? '—'}</strong>
                  <p>{question.reason}</p>
                  <small>{question.note || 'Ek açıklama yok.'}</small>
                  {isAdmin && (
                    <ImageFilePicker
                      label="+ Bilgisayardan fotoğraf seç"
                      onFiles={(files) => onAddImages(question.id, files).catch((error) => window.alert(error.message))}
                    />
                  )}
                  <button
                    className={`repeat-toggle ${question.needsReview ? 'selected' : ''}`}
                    type="button"
                    disabled={!isAdmin || reviewUpdatingId === question.id}
                    onClick={() => onToggleReview(question)}
                    title={isAdmin ? 'Tekrar listesi durumunu değiştir' : 'Bu işaret yalnızca yönetici modunda değiştirilebilir'}
                  >
                    {reviewUpdatingId === question.id
                      ? 'Kaydediliyor…'
                      : question.needsReview
                        ? '✓ Tekrar listesinden çıkar'
                        : '+ Tekrar listesine ekle'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            Bu denemeye henüz yanlış veya boş soru kaydedilmemiş.
            {isAdmin && <p><button className="form-primary-button" type="button" onClick={onAddQuestion}>+ Soru ekle ve fotoğraf yükle</button></p>}
          </div>
        )}
      </section>
      {annotatingImage && (
        <TemporaryImageAnnotator
          image={annotatingImage}
          onClose={() => setAnnotatingImage(null)}
        />
      )}
    </div>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function AdminLoginModal({ onClose, onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await onLogin(password)
    } catch (loginError) {
      setError(loginError?.message || 'Yönetici girişi başarısız oldu.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal-panel admin-login-panel" role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
        <div className="modal-heading">
          <div><span className="section-kicker">KORUMALI ALAN</span><h2 id="admin-login-title">Yönetici girişi</h2></div>
          <button className="modal-close-button" type="button" onClick={onClose} aria-label="Kapat">×</button>
        </div>
        <p className="modal-description">Yönetim işlemlerini açmak için yönetici şifreni gir.</p>
        <form onSubmit={submit} className="admin-form">
          <label className="form-field">
            <span>Yönetici şifresi</span>
            <input autoFocus autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button className="form-secondary-button" type="button" onClick={onClose}>Vazgeç</button>
            <button className="form-primary-button" type="submit" disabled={busy}>{busy ? 'Kontrol ediliyor…' : 'Yönetici moduna gir'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function ImageFilePicker({ label, onFiles }) {
  const inputRef = useRef(null)
  return (
    <>
      <button
        className="inline-image-upload image-picker-button"
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        className="visually-hidden-file-input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={(event) => {
          onFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </>
  )
}

function AddQuestionModal({ exam, onClose, onSave }) {
  const [number, setNumber] = useState('')
  const [topic, setTopic] = useState('')
  const [status, setStatus] = useState('wrong')
  const [errorType, setErrorType] = useState('')
  const [note, setNote] = useState('')
  const [needsReview, setNeedsReview] = useState(false)
  const [files, setFiles] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleFiles = (fileList) => {
    const incoming = Array.from(fileList || [])
    if (!incoming.length) return
    const invalid = incoming.find((file) => !ACCEPTED_IMAGE_TYPES.has(file.type))
    if (invalid) {
      setError(`${invalid.name}: Yalnızca JPG, PNG ve WebP dosyaları destekleniyor.`)
      return
    }
    setError('')
    setFiles((current) => [...current, ...incoming])
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (!topic.trim() && !number && files.length === 0) {
      setError('En azından soru numarası, konu veya bir fotoğraf eklemelisin.')
      return
    }
    if (number && (!Number.isSafeInteger(Number(number)) || Number(number) < 1)) {
      setError('Soru numarası 1 veya daha büyük bir tam sayı olmalı.')
      return
    }
    setBusy(true)
    try {
      await onSave({
        question_number: number ? Number(number) : null,
        topic_name: topic.trim(),
        status,
        error_type: errorType,
        note: note.trim(),
        needs_review: needsReview,
        files,
      })
    } catch (saveError) {
      setError(saveError?.message || 'Soru kaydedilemedi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-panel add-question-panel" role="dialog" aria-modal="true" aria-labelledby="add-question-title">
        <div className="modal-heading">
          <div>
            <span className="section-kicker">{exam.name}</span>
            <h2 id="add-question-title">Yeni soru ve fotoğraf ekle</h2>
          </div>
          <button className="modal-close-button" type="button" onClick={onClose} disabled={busy} aria-label="Kapat">×</button>
        </div>
        <form onSubmit={submit} className="admin-form">
          <div className="form-grid two-columns">
            <label className="form-field">
              <span>Soru numarası</span>
              <input type="number" min="1" step="1" value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Örn. 12" />
            </label>
            <label className="form-field">
              <span>Konu</span>
              <input type="text" maxLength={120} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="Örn. Fonksiyonlar" />
            </label>
          </div>
          <div className="form-grid two-columns">
            <label className="form-field">
              <span>Durum</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="wrong">Yanlış</option>
                <option value="blank">Boş</option>
              </select>
            </label>
            <label className="form-field">
              <span>Hata nedeni</span>
              <select value={errorType} onChange={(event) => setErrorType(event.target.value)}>
                <option value="">Belirtilmedi</option>
                <option value="Bilgi eksikliği">Bilgi eksikliği</option>
                <option value="Dikkat hatası">Dikkat hatası</option>
                <option value="İşlem hatası">İşlem hatası</option>
                <option value="Süre yetmedi">Süre yetmedi</option>
                <option value="Yorumlama hatası">Yorumlama hatası</option>
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>Kendi açıklamam</span>
            <textarea rows="2" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Bu soruyla ilgili notun…" />
          </label>
          <section className="question-file-picker">
            <strong>Soru fotoğrafları</strong>
            <ImageFilePicker label="+ Bilgisayardan fotoğraf seç" onFiles={handleFiles} />
            <small>{files.length} fotoğraf seçildi. Seçtiğin dosyalar kalite kaybı olmadan saklanır; PNG için yalnızca kayıpsız optimizasyon denenir.</small>
            {files.length > 0 && (
              <ul className="selected-file-list">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    <span>{file.name} · {(file.size / 1024).toFixed(0)} KB</span>
                    <button type="button" className="remove-row-button" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))} aria-label="Fotoğrafı listeden çıkar">×</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <label className="form-checkbox">
            <input type="checkbox" checked={needsReview} onChange={(event) => setNeedsReview(event.target.checked)} />
            <span>Tekrar çöz listesine ekle</span>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button className="form-secondary-button" type="button" onClick={onClose} disabled={busy}>Vazgeç</button>
            <button className="form-primary-button" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Soruyu ve fotoğrafları kaydet'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function EditExamModal({ exam, onClose, onSave }) {
  const [form, setForm] = useState({
    subject: exam.subject,
    title: exam.name,
    examDate: exam.dateValue || todayDateValue(),
    correct: String(exam.correct),
    wrong: String(exam.wrong),
    blank: String(exam.blank),
    notes: exam.notes || '',
  })
  const [topics, setTopics] = useState(() => (exam.topics || []).map((topic) => ({
    rowId: topic.id || createRowId(),
    name: topic.name,
    wrong: String(topic.wrong ?? 0),
    blank: String(topic.blank ?? 0),
  })))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const currentNet = (Number(form.correct || 0) - Number(form.wrong || 0) / 4).toFixed(2).replace('.', ',')

  const setField = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const updateTopic = (rowId, field, value) => {
    setTopics((current) => current.map((topic) => topic.rowId === rowId ? { ...topic, [field]: value } : topic))
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')

    if (!form.title.trim()) {
      setError('Deneme adı boş bırakılamaz.')
      return
    }
    if (!form.examDate) {
      setError('Deneme tarihi seçmelisin.')
      return
    }
    const counts = ['correct', 'wrong', 'blank'].map((key) => Number(form[key]))
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setError('Doğru, yanlış ve boş sayıları sıfır veya daha büyük tam sayı olmalı.')
      return
    }

    const existingTopicIds = new Set((exam.topics || []).map((topic) => String(topic.id)))
    const topicPayload = topics
      .filter((topic) => topic.name.trim())
      .map((topic) => ({
        id: existingTopicIds.has(String(topic.rowId)) ? topic.rowId : null,
        topic_name: topic.name.trim(),
        wrong_count: Number(topic.wrong || 0),
        blank_count: Number(topic.blank || 0),
      }))

    const topicNames = topicPayload.map((topic) => topic.topic_name.toLocaleLowerCase('tr-TR'))
    if (new Set(topicNames).size !== topicNames.length) {
      setError('Aynı konu adını birden fazla kez ekleyemezsin.')
      return
    }

    if (topicPayload.some((topic) => !Number.isSafeInteger(topic.wrong_count) || topic.wrong_count < 0 || !Number.isSafeInteger(topic.blank_count) || topic.blank_count < 0)) {
      setError('Konu yanlış ve boş sayıları sıfır veya daha büyük tam sayı olmalı.')
      return
    }

    setBusy(true)
    try {
      await onSave({
        exam: {
          subject: form.subject,
          title: form.title.trim(),
          exam_date: form.examDate,
          correct_count: counts[0],
          wrong_count: counts[1],
          blank_count: counts[2],
          notes: form.notes.trim(),
        },
        topics: topicPayload,
      })
    } catch (saveError) {
      setError(saveError?.message || 'Deneme güncellenemedi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-panel create-exam-panel" role="dialog" aria-modal="true" aria-labelledby="edit-exam-title">
        <div className="modal-heading">
          <div><span className="section-kicker">YÖNETİCİ İŞLEMİ</span><h2 id="edit-exam-title">Denemeyi düzenle</h2></div>
          <button className="modal-close-button" type="button" onClick={onClose} disabled={busy} aria-label="Kapat">×</button>
        </div>
        <form onSubmit={submit} className="admin-form">
          <div className="form-grid two-columns">
            <label className="form-field">
              <span>Ders</span>
              <select value={form.subject} onChange={(event) => setField('subject', event.target.value)}>
                {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Deneme tarihi</span>
              <input type="date" value={form.examDate} onChange={(event) => setField('examDate', event.target.value)} required />
            </label>
          </div>
          <label className="form-field">
            <span>Deneme adı</span>
            <input type="text" maxLength={120} value={form.title} onChange={(event) => setField('title', event.target.value)} required />
          </label>
          <section className="form-section">
            <div className="form-section-heading"><h3>Deneme sonucu</h3><span className="net-preview">Net: {currentNet}</span></div>
            <div className="form-grid three-columns">
              <label className="form-field"><span>Doğru</span><input type="number" min="0" step="1" required value={form.correct} onChange={(event) => setField('correct', event.target.value)} /></label>
              <label className="form-field"><span>Yanlış</span><input type="number" min="0" step="1" required value={form.wrong} onChange={(event) => setField('wrong', event.target.value)} /></label>
              <label className="form-field"><span>Boş</span><input type="number" min="0" step="1" required value={form.blank} onChange={(event) => setField('blank', event.target.value)} /></label>
            </div>
          </section>
          <section className="form-section">
            <div className="form-section-heading">
              <div><h3>Konu dağılımı</h3><p>Mevcut konuları güncelleyebilir veya yenilerini ekleyebilirsin.</p></div>
              <button className="form-secondary-button compact-button" type="button" onClick={() => setTopics((current) => [...current, { rowId: createRowId(), name: '', wrong: '0', blank: '0' }])}>+ Konu ekle</button>
            </div>
            {topics.length ? (
              <div className="dynamic-row-list">
                {topics.map((topic) => (
                  <div className="topic-input-row" key={topic.rowId}>
                    <input aria-label="Konu adı" type="text" maxLength={120} placeholder="Konu adı" value={topic.name} onChange={(event) => updateTopic(topic.rowId, 'name', event.target.value)} />
                    <input aria-label="Yanlış sayısı" type="number" min="0" step="1" placeholder="Yanlış" value={topic.wrong} onChange={(event) => updateTopic(topic.rowId, 'wrong', event.target.value)} />
                    <input aria-label="Boş sayısı" type="number" min="0" step="1" placeholder="Boş" value={topic.blank} onChange={(event) => updateTopic(topic.rowId, 'blank', event.target.value)} />
                    <button className="remove-row-button" type="button" onClick={() => setTopics((current) => current.filter((item) => item.rowId !== topic.rowId))} aria-label="Konuyu kaldır">×</button>
                  </div>
                ))}
              </div>
            ) : <div className="form-hint">Konu kaydı yok. Eklemek için “Konu ekle” düğmesini kullan.</div>}
          </section>
          <label className="form-field">
            <span>Notlar</span>
            <textarea rows="3" maxLength={4000} value={form.notes} onChange={(event) => setField('notes', event.target.value)} />
          </label>
          <div className="form-hint">Bu işlem soru kayıtlarını ve yüklenmiş fotoğrafları değiştirmez.</div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button className="form-secondary-button" type="button" onClick={onClose} disabled={busy}>Vazgeç</button>
            <button className="form-primary-button" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Değişiklikleri kaydet'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

function CreateExamModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    subject: subjects[0],
    title: '',
    examDate: todayDateValue(),
    correct: '0',
    wrong: '0',
    blank: '0',
    notes: '',
  })
  const [topics, setTopics] = useState([])
  const [questions, setQuestions] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const setField = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const currentNet = (Number(form.correct || 0) - Number(form.wrong || 0) / 4).toFixed(2).replace('.', ',')

  const updateTopic = (rowId, field, value) => {
    setTopics((current) => current.map((topic) => topic.rowId === rowId ? { ...topic, [field]: value } : topic))
  }
  const updateQuestion = (rowId, field, value) => {
    setQuestions((current) => current.map((question) => question.rowId === rowId ? { ...question, [field]: value } : question))
  }

  const addQuestionFiles = (rowId, fileList) => {
    const incoming = Array.from(fileList || [])
    if (!incoming.length) return
    const invalidType = incoming.find((file) => !ACCEPTED_IMAGE_TYPES.has(file.type))
    if (invalidType) {
      setError(`${invalidType.name}: Yalnızca JPG, PNG veya WebP dosyaları kabul edilir.`)
      return
    }
    setError('')
    setQuestions((current) => current.map((question) => question.rowId === rowId
      ? { ...question, files: [...question.files, ...incoming] }
      : question))
  }

  const removeQuestionFile = (rowId, fileIndex) => {
    setQuestions((current) => current.map((question) => question.rowId === rowId
      ? { ...question, files: question.files.filter((_, index) => index !== fileIndex) }
      : question))
  }

  const submit = async (event) => {
    event.preventDefault()
    setError('')

    if (!form.title.trim()) {
      setError('Deneme adı boş bırakılamaz.')
      return
    }

    const counts = ['correct', 'wrong', 'blank'].map((key) => Number(form[key]))
    if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setError('Doğru, yanlış ve boş sayıları sıfır veya daha büyük tam sayı olmalı.')
      return
    }

    const topicPayload = topics
      .filter((topic) => topic.name.trim())
      .map((topic) => ({
        topic_name: topic.name.trim(),
        wrong_count: Number(topic.wrong || 0),
        blank_count: Number(topic.blank || 0),
      }))

    const questionPayload = questions
      .filter((question) => question.number !== '' || question.topic.trim() || question.errorType || question.note.trim() || question.files.length > 0)
      .map((question) => ({
        client_ref: question.rowId,
        question_number: question.number === '' ? null : Number(question.number),
        topic_name: question.topic.trim(),
        status: question.status,
        error_type: question.errorType,
        note: question.note.trim(),
        needs_review: question.needsReview,
      }))

    setBusy(true)
    try {
      await onSave({
        exam: {
          subject: form.subject,
          title: form.title.trim(),
          exam_date: form.examDate,
          correct_count: counts[0],
          wrong_count: counts[1],
          blank_count: counts[2],
          notes: form.notes.trim(),
        },
        topics: topicPayload,
        questions: questionPayload,
        questionFiles: questions.filter((question) => question.files.length > 0).map((question) => ({
          clientRef: question.rowId,
          files: question.files,
        })),
      })
    } catch (saveError) {
      setError(saveError?.message || 'Deneme kaydedilemedi.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="modal-panel create-exam-panel" role="dialog" aria-modal="true" aria-labelledby="create-exam-title">
        <div className="modal-heading">
          <div><span className="section-kicker">YÖNETİCİ İŞLEMİ</span><h2 id="create-exam-title">Yeni deneme ekle</h2></div>
          <button className="modal-close-button" type="button" onClick={onClose} disabled={busy} aria-label="Kapat">×</button>
        </div>
        <form onSubmit={submit} className="admin-form">
          <div className="form-grid two-columns">
            <label className="form-field">
              <span>Ders</span>
              <select value={form.subject} onChange={(event) => setField('subject', event.target.value)}>
                {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>Deneme tarihi</span>
              <input type="date" value={form.examDate} onChange={(event) => setField('examDate', event.target.value)} required />
            </label>
          </div>

          <label className="form-field">
            <span>Deneme adı</span>
            <input type="text" maxLength={120} placeholder="Örn. Orijinal - 4" value={form.title} onChange={(event) => setField('title', event.target.value)} required />
          </label>

          <section className="form-section">
            <div className="form-section-heading"><h3>Deneme sonucu</h3><span className="net-preview">Net: {currentNet}</span></div>
            <div className="form-grid three-columns">
              <label className="form-field"><span>Doğru</span><input type="number" min="0" step="1" required value={form.correct} onChange={(event) => setField('correct', event.target.value)} /></label>
              <label className="form-field"><span>Yanlış</span><input type="number" min="0" step="1" required value={form.wrong} onChange={(event) => setField('wrong', event.target.value)} /></label>
              <label className="form-field"><span>Boş</span><input type="number" min="0" step="1" required value={form.blank} onChange={(event) => setField('blank', event.target.value)} /></label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-heading">
              <div><h3>Konu dağılımı</h3><p>Her konu için yanlış ve boş sayılarını gir.</p></div>
              <button className="form-secondary-button compact-button" type="button" onClick={() => setTopics((current) => [...current, { rowId: createRowId(), name: '', wrong: '0', blank: '0' }])}>+ Konu ekle</button>
            </div>
            {topics.length ? (
              <div className="dynamic-row-list">
                {topics.map((topic) => (
                  <div className="topic-input-row" key={topic.rowId}>
                    <input aria-label="Konu adı" type="text" maxLength={120} placeholder="Konu adı" value={topic.name} onChange={(event) => updateTopic(topic.rowId, 'name', event.target.value)} />
                    <input aria-label="Yanlış sayısı" type="number" min="0" step="1" placeholder="Yanlış" value={topic.wrong} onChange={(event) => updateTopic(topic.rowId, 'wrong', event.target.value)} />
                    <input aria-label="Boş sayısı" type="number" min="0" step="1" placeholder="Boş" value={topic.blank} onChange={(event) => updateTopic(topic.rowId, 'blank', event.target.value)} />
                    <button className="remove-row-button" type="button" onClick={() => setTopics((current) => current.filter((item) => item.rowId !== topic.rowId))} aria-label="Konuyu kaldır">×</button>
                  </div>
                ))}
              </div>
            ) : <div className="form-hint">Henüz konu eklenmedi. Konu analizi girmek için “Konu ekle” düğmesini kullan.</div>}
          </section>

          <section className="form-section">
            <div className="form-section-heading">
              <div><h3>Yanlış ve boş soru kayıtları</h3><p>Her soruya fotoğraf ekleyebilirsin. PNG dosyaları kayıpsız optimize edilir; JPEG ve WebP dosyaları kalite kaybı olmadan orijinal hâliyle saklanır.</p></div>
              <button className="form-secondary-button compact-button" type="button" onClick={() => setQuestions((current) => [...current, { rowId: createRowId(), number: '', topic: '', status: 'wrong', errorType: '', note: '', needsReview: false, files: [] }])}>+ Soru ekle</button>
            </div>
            {questions.length ? (
              <div className="question-input-list">
                {questions.map((question, index) => (
                  <div className="question-input-card" key={question.rowId}>
                    <div className="question-input-card-heading">
                      <strong>Soru kaydı {index + 1}</strong>
                      <button className="remove-row-button" type="button" onClick={() => setQuestions((current) => current.filter((item) => item.rowId !== question.rowId))} aria-label="Soru kaydını kaldır">×</button>
                    </div>
                    <div className="form-grid two-columns">
                      <label className="form-field"><span>Soru numarası</span><input type="number" min="1" step="1" placeholder="Örn. 12" value={question.number} onChange={(event) => updateQuestion(question.rowId, 'number', event.target.value)} /></label>
                      <label className="form-field"><span>Konu</span><input type="text" maxLength={120} placeholder="Örn. Fonksiyonlar" value={question.topic} onChange={(event) => updateQuestion(question.rowId, 'topic', event.target.value)} /></label>
                    </div>
                    <div className="form-grid two-columns">
                      <label className="form-field"><span>Durum</span><select value={question.status} onChange={(event) => updateQuestion(question.rowId, 'status', event.target.value)}><option value="wrong">Yanlış</option><option value="blank">Boş</option></select></label>
                      <label className="form-field"><span>Hata nedeni</span><select value={question.errorType} onChange={(event) => updateQuestion(question.rowId, 'errorType', event.target.value)}><option value="">Belirtilmedi</option><option value="Bilgi eksikliği">Bilgi eksikliği</option><option value="Dikkat hatası">Dikkat hatası</option><option value="İşlem hatası">İşlem hatası</option><option value="Süre yetmedi">Süre yetmedi</option><option value="Yorumlama hatası">Yorumlama hatası</option></select></label>
                    </div>
                    <label className="form-field"><span>Kendi açıklamam</span><textarea rows="2" maxLength={2000} placeholder="Bu soruyla ilgili notun…" value={question.note} onChange={(event) => updateQuestion(question.rowId, 'note', event.target.value)} /></label>
                    <div className="question-file-picker">
                      <ImageFilePicker
                        label="+ Bilgisayardan soru fotoğrafı seç"
                        onFiles={(files) => addQuestionFiles(question.rowId, files)}
                      />
                      <small>{question.files.length} fotoğraf seçildi · Seçtiğin tüm fotoğraflar sırayla yüklenecek</small>
                      {question.files.length > 0 && (
                        <ul className="selected-file-list">
                          {question.files.map((file, fileIndex) => (
                            <li key={`${file.name}-${fileIndex}`}>
                              <span>{file.name} · {(file.size / 1024).toFixed(0)} KB</span>
                              <button type="button" className="remove-row-button" onClick={() => removeQuestionFile(question.rowId, fileIndex)} aria-label="Fotoğrafı listeden çıkar">×</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <label className="form-checkbox"><input type="checkbox" checked={question.needsReview} onChange={(event) => updateQuestion(question.rowId, 'needsReview', event.target.checked)} /><span>Tekrar çöz listesine ekle</span></label>
                  </div>
                ))}
              </div>
            ) : <div className="form-hint">İstersen soru kayıtlarını şimdi ekleyebilir veya daha sonra yönetici panelinden tamamlayabiliriz.</div>}
          </section>

          <label className="form-field"><span>Deneme hakkında not</span><textarea rows="3" maxLength={4000} placeholder="İsteğe bağlı genel not…" value={form.notes} onChange={(event) => setField('notes', event.target.value)} /></label>

          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="form-hint">Fotoğraf adedi için uygulama içi sınır yoktur. Büyük dosyalar parça parça yüklenir. PNG yalnızca kayıpsız küçültülebilirse optimize edilir; JPEG/WebP orijinal hâliyle saklanır. Supabase plan limitleri geçerlidir.</div>
          <div className="modal-actions">
            <button className="form-secondary-button" type="button" onClick={onClose} disabled={busy}>Vazgeç</button>
            <button className="form-primary-button" type="submit" disabled={busy}>{busy ? 'Kaydediliyor…' : 'Denemeyi kaydet'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default App